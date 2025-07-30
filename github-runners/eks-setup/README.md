# EKS Setup for Podman/Rootless Container Builds

This directory contains configurations to set up EKS nodes for rootless container builds using Podman.

## EKS Challenges for Rootless Containers

### Default EKS Limitations:
- **User namespaces disabled** by default
- **Missing fuse-overlayfs** (required for rootless overlay storage)
- **Only runc runtime** (crun has better rootless support)
- **Limited subuid/subgid ranges**
- **Restrictive security policies**

## Setup Options

### Option 1: Custom Node Group (Recommended)

Use the Terraform configuration to create a dedicated node group:

```bash
# Deploy with Terraform
terraform init
terraform plan -var="cluster_name=my-cluster"
terraform apply
```

**Benefits:**
- Nodes pre-configured for rootless builds
- Dedicated storage for container layers
- Proper taints and labels
- Optimized instance types

### Option 2: DaemonSet Configuration

For existing clusters, use the DaemonSet to configure nodes:

```bash
# Apply the DaemonSet
kubectl apply -f daemonset-node-setup.yaml

# Label existing nodes for builds
kubectl label nodes <node-name> node-type=builder podman-enabled=true
```

**Benefits:**
- Works with existing node groups
- No infrastructure changes required
- Can be applied selectively

## EKS-Specific Configurations

### 1. User Namespaces
```bash
# Enable user namespaces (requires kernel 3.8+)
echo 'user.max_user_namespaces = 65536' >> /etc/sysctl.conf
sysctl -p
```

### 2. Container Runtime
```bash
# Install crun (better rootless support than runc)
curl -L "https://github.com/containers/crun/releases/download/1.8.7/crun-1.8.7-linux-amd64" \
    -o /usr/local/bin/crun
chmod +x /usr/local/bin/crun
```

### 3. Storage Driver
```bash
# Install fuse-overlayfs for rootless overlay
yum install -y fuse-overlayfs
```

### 4. Subuid/Subgid Ranges
```bash
# Set up user namespace ranges
echo 'ec2-user:100000:65536' >> /etc/subuid
echo 'ec2-user:100000:65536' >> /etc/subgid
```

## Instance Type Recommendations

### For Build Workloads:
- **m5.2xlarge** (8 vCPU, 32GB RAM) - Good balance
- **m5.4xlarge** (16 vCPU, 64GB RAM) - Heavy builds
- **c5.4xlarge** (16 vCPU, 32GB RAM) - CPU intensive

### Storage Requirements:
- **Root volume**: 100GB GP3 (OS + tools)
- **Build volume**: 200GB GP3 (container layers)
- **IOPS**: 3000+ for build performance

## Network Configuration

### Security Groups:
```hcl
# Allow node-to-node communication
ingress {
  from_port = 0
  to_port   = 65535
  protocol  = "tcp"
  self      = true
}

# Allow cluster API access
ingress {
  from_port       = 443
  to_port         = 443
  protocol        = "tcp"
  security_groups = [cluster_sg_id]
}
```

### VPC Requirements:
- **Private subnets** for build nodes
- **NAT Gateway** for internet access
- **VPC endpoints** for ECR (optional, for performance)

## Verification

### Check Node Configuration:
```bash
# Verify user namespaces
kubectl exec -it <pod> -- cat /proc/sys/user/max_user_namespaces

# Check fuse-overlayfs
kubectl exec -it <pod> -- which fuse-overlayfs

# Verify crun
kubectl exec -it <pod> -- /usr/local/bin/crun --version

# Test rootless build
kubectl exec -it <pod> -- podman build --help
```

### Test Podman Build:
```bash
# Create test pod
kubectl run test-podman --image=quay.io/podman/stable:latest \
  --rm -it --restart=Never \
  --overrides='{"spec":{"securityContext":{"runAsUser":1000,"runAsGroup":1000}}}' \
  -- podman info
```

## Troubleshooting

### Common Issues:

**1. User namespaces not enabled:**
```bash
# Check current setting
cat /proc/sys/user/max_user_namespaces

# Should return > 0, if 0 then user namespaces are disabled
```

**2. fuse-overlayfs missing:**
```bash
# Install on Amazon Linux 2
yum install -y fuse-overlayfs

# Verify installation
which fuse-overlayfs
```

**3. Permission denied errors:**
```bash
# Check subuid/subgid
cat /etc/subuid
cat /etc/subgid

# Should contain entries like: ec2-user:100000:65536
```

**4. Storage driver issues:**
```bash
# Check available storage drivers
podman info --format json | jq '.store.graphDriverName'

# Should show "overlay" with fuse-overlayfs
```

## Cost Optimization

### Spot Instances:
```hcl
# Use spot instances for cost savings
capacity_type = "SPOT"
instance_types = ["m5.2xlarge", "m5a.2xlarge", "m4.2xlarge"]
```

### Auto Scaling:
```hcl
scaling_config {
  desired_size = 1
  max_size     = 10
  min_size     = 0  # Scale to zero when not needed
}
```

### Storage Optimization:
- Use GP3 volumes with baseline IOPS
- Enable EBS volume encryption
- Set up lifecycle policies for unused volumes

## Security Considerations

### Pod Security Standards:
```yaml
# Use restricted pod security standard
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
    add: [SETUID, SETGID]  # Minimal for user namespaces
```

### Network Policies:
```yaml
# Restrict network access for build pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: build-pods-policy
spec:
  podSelector:
    matchLabels:
      app: github-runner
  policyTypes:
  - Egress
  egress:
  - to: []
    ports:
    - protocol: TCP
      port: 443  # HTTPS only
```

This setup provides a secure, scalable foundation for rootless container builds on EKS while maintaining AWS best practices.