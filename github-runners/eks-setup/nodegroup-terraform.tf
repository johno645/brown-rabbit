# Terraform configuration for EKS Node Group with Podman support

# Data source for the user data script
data "template_file" "user_data" {
  template = file("${path.module}/node-group-userdata.sh")
  vars = {
    CLUSTER_NAME = var.cluster_name
  }
}

# Launch template for EKS nodes with rootless container support
resource "aws_launch_template" "podman_nodes" {
  name_prefix   = "${var.cluster_name}-podman-"
  image_id      = data.aws_ami.eks_worker.id
  instance_type = var.instance_type
  
  vpc_security_group_ids = [aws_security_group.node_group_sg.id]
  
  user_data = base64encode(data.template_file.user_data.rendered)
  
  # Additional EBS volume for container storage
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 100
      volume_type          = "gp3"
      iops                 = 3000
      throughput           = 125
      delete_on_termination = true
      encrypted            = true
    }
  }
  
  # Additional volume for container storage
  block_device_mappings {
    device_name = "/dev/xvdb"
    ebs {
      volume_size           = 200
      volume_type          = "gp3"
      iops                 = 3000
      throughput           = 125
      delete_on_termination = true
      encrypted            = true
    }
  }
  
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "enabled"
  }
  
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name                     = "${var.cluster_name}-podman-node"
      "kubernetes.io/cluster/${var.cluster_name}" = "owned"
      "node-type"             = "builder"
      "podman-enabled"        = "true"
    }
  }
  
  tags = {
    Name = "${var.cluster_name}-podman-launch-template"
  }
}

# EKS Node Group for Podman builds
resource "aws_eks_node_group" "podman_builders" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "podman-builders"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids
  
  capacity_type  = "ON_DEMAND"
  instance_types = [var.instance_type]
  
  scaling_config {
    desired_size = var.desired_capacity
    max_size     = var.max_capacity
    min_size     = var.min_capacity
  }
  
  update_config {
    max_unavailable = 1
  }
  
  launch_template {
    id      = aws_launch_template.podman_nodes.id
    version = aws_launch_template.podman_nodes.latest_version
  }
  
  # Taints for dedicated build nodes
  taint {
    key    = "builder"
    value  = "true"
    effect = "NO_SCHEDULE"
  }
  
  labels = {
    "node-type"      = "builder"
    "podman-enabled" = "true"
  }
  
  depends_on = [
    aws_iam_role_policy_attachment.node_group_AmazonEKSWorkerNodePolicy,
    aws_iam_role_policy_attachment.node_group_AmazonEKS_CNI_Policy,
    aws_iam_role_policy_attachment.node_group_AmazonEC2ContainerRegistryReadOnly,
  ]
  
  tags = {
    Name = "${var.cluster_name}-podman-node-group"
  }
}

# Security group for node group
resource "aws_security_group" "node_group_sg" {
  name_prefix = "${var.cluster_name}-node-group-"
  vpc_id      = var.vpc_id
  
  ingress {
    description = "Node to node communication"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }
  
  ingress {
    description     = "Cluster API to node groups"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.cluster_sg.id]
  }
  
  ingress {
    description     = "Cluster API to node kubelets"
    from_port       = 10250
    to_port         = 10250
    protocol        = "tcp"
    security_groups = [aws_security_group.cluster_sg.id]
  }
  
  egress {
    description = "All outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  
  tags = {
    Name = "${var.cluster_name}-node-group-sg"
    "kubernetes.io/cluster/${var.cluster_name}" = "owned"
  }
}

# Data source for EKS optimized AMI
data "aws_ami" "eks_worker" {
  filter {
    name   = "name"
    values = ["amazon-eks-node-${var.kubernetes_version}-v*"]
  }
  
  most_recent = true
  owners      = ["602401143452"] # Amazon EKS AMI Account ID
}

# IAM role for node group
resource "aws_iam_role" "node_group" {
  name = "${var.cluster_name}-node-group-role"
  
  assume_role_policy = jsonencode({
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
    Version = "2012-10-17"
  })
}

# IAM role policy attachments
resource "aws_iam_role_policy_attachment" "node_group_AmazonEKSWorkerNodePolicy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.node_group.name
}

resource "aws_iam_role_policy_attachment" "node_group_AmazonEKS_CNI_Policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.node_group.name
}

resource "aws_iam_role_policy_attachment" "node_group_AmazonEC2ContainerRegistryReadOnly" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.node_group.name
}

# Additional policy for container registry access
resource "aws_iam_role_policy" "node_group_ecr_policy" {
  name = "${var.cluster_name}-node-group-ecr-policy"
  role = aws_iam_role.node_group.id
  
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:GetRepositoryPolicy",
          "ecr:DescribeRepositories",
          "ecr:ListImages",
          "ecr:DescribeImages",
          "ecr:BatchGetImage",
          "ecr:GetLifecyclePolicy",
          "ecr:GetLifecyclePolicyPreview",
          "ecr:ListTagsForResource",
          "ecr:DescribeImageScanFindings",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage"
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:GetAuthorizationToken"
        ]
        Resource = "*"
      }
    ]
  })
}

# Variables
variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where the cluster will be created"
  type        = string
}

variable "private_subnet_ids" {
  description = "List of private subnet IDs"
  type        = list(string)
}

variable "instance_type" {
  description = "EC2 instance type for worker nodes"
  type        = string
  default     = "m5.2xlarge"
}

variable "desired_capacity" {
  description = "Desired number of worker nodes"
  type        = number
  default     = 2
}

variable "max_capacity" {
  description = "Maximum number of worker nodes"
  type        = number
  default     = 10
}

variable "min_capacity" {
  description = "Minimum number of worker nodes"
  type        = number
  default     = 1
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.28"
}

# Outputs
output "node_group_arn" {
  description = "ARN of the EKS node group"
  value       = aws_eks_node_group.podman_builders.arn
}

output "node_group_status" {
  description = "Status of the EKS node group"
  value       = aws_eks_node_group.podman_builders.status
}