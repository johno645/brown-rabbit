import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { KarpenterStack } from './karpenter-stack';

export class MainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC
    const vpc = new ec2.Vpc(this, 'EksVpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Create EKS cluster
    const cluster = new eks.Cluster(this, 'EksCluster', {
      clusterName: 'karpenter-demo',
      version: eks.KubernetesVersion.V1_28,
      vpc,
      vpcSubnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
      defaultCapacity: 0, // We'll use Karpenter for scaling
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
    });

    // Add initial managed node group (minimal, for Karpenter itself)
    cluster.addNodegroupCapacity('InitialNodes', {
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      minSize: 1,
      maxSize: 3,
      desiredSize: 2,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      labels: {
        'node-type': 'system',
        'karpenter.sh/provisioner-name': 'system',
      },
      taints: [
        {
          key: 'CriticalAddonsOnly',
          value: 'true',
          effect: eks.TaintEffect.NO_SCHEDULE,
        },
      ],
    });

    // Deploy Karpenter
    const karpenterStack = new KarpenterStack(this, 'Karpenter', {
      cluster,
      vpc,
    });

    // Create security group for Karpenter nodes
    const karpenterNodeSecurityGroup = new ec2.SecurityGroup(this, 'KarpenterNodeSecurityGroup', {
      vpc,
      description: 'Security group for Karpenter provisioned nodes',
      allowAllOutbound: true,
    });

    // Allow communication between nodes
    karpenterNodeSecurityGroup.addIngressRule(
      karpenterNodeSecurityGroup,
      ec2.Port.allTraffic(),
      'Allow communication between Karpenter nodes'
    );

    // Allow communication from cluster security group
    karpenterNodeSecurityGroup.addIngressRule(
      cluster.clusterSecurityGroup,
      ec2.Port.allTraffic(),
      'Allow communication from EKS cluster'
    );

    // Tag security group for Karpenter discovery
    cdk.Tags.of(karpenterNodeSecurityGroup).add('karpenter.sh/discovery', cluster.clusterName);

    // Create example workload deployment
    const exampleWorkload = cluster.addManifest('ExampleWorkload', {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: 'example-workload',
        namespace: 'default',
      },
      spec: {
        replicas: 0, // Start with 0, scale up manually to test
        selector: {
          matchLabels: {
            app: 'example-workload',
          },
        },
        template: {
          metadata: {
            labels: {
              app: 'example-workload',
            },
          },
          spec: {
            tolerations: [
              {
                key: 'karpenter.sh/unschedulable',
                operator: 'Exists',
                effect: 'NoSchedule',
              },
            ],
            nodeSelector: {
              'node-type': 'karpenter',
            },
            containers: [
              {
                name: 'app',
                image: 'nginx:latest',
                resources: {
                  requests: {
                    cpu: '100m',
                    memory: '128Mi',
                  },
                  limits: {
                    cpu: '500m',
                    memory: '512Mi',
                  },
                },
                ports: [
                  {
                    containerPort: 80,
                  },
                ],
              },
            ],
          },
        },
      },
    });

    // Create NodePool for GitHub Actions runners
    const githubRunnersNodePool = cluster.addManifest('GitHubRunnersNodePool', {
      apiVersion: 'karpenter.sh/v1',
      kind: 'NodePool',
      metadata: {
        name: 'github-runners',
        namespace: 'karpenter',
      },
      spec: {
        template: {
          metadata: {
            labels: {
              'node-type': 'github-runner',
              'workload-type': 'ci-cd',
            },
            annotations: {
              'cluster-autoscaler.kubernetes.io/safe-to-evict': 'true',
            },
          },
          spec: {
            requirements: [
              {
                key: 'kubernetes.io/arch',
                operator: 'In',
                values: ['amd64'],
              },
              {
                key: 'kubernetes.io/os',
                operator: 'In',
                values: ['linux'],
              },
              {
                key: 'karpenter.sh/capacity-type',
                operator: 'In',
                values: ['spot', 'on-demand'],
              },
              {
                key: 'node.kubernetes.io/instance-type',
                operator: 'In',
                values: ['m5.large', 'm5.xlarge', 'm5.2xlarge', 'm5.4xlarge', 'c5.2xlarge', 'c5.4xlarge'],
              },
            ],
            nodeClassRef: {
              apiVersion: 'karpenter.k8s.aws/v1',
              kind: 'EC2NodeClass',
              name: 'github-runners',
            },
            taints: [
              {
                key: 'github-runner',
                value: 'true',
                effect: 'NoSchedule',
              },
            ],
          },
        },
        disruption: {
          consolidationPolicy: 'WhenEmpty',
          consolidateAfter: '30s',
          expireAfter: '10m', // Shorter expiry for CI/CD workloads
        },
        limits: {
          cpu: '500',
          memory: '500Gi',
        },
      },
    });

    // Create EC2NodeClass for GitHub Actions runners
    const githubRunnersNodeClass = cluster.addManifest('GitHubRunnersNodeClass', {
      apiVersion: 'karpenter.k8s.aws/v1',
      kind: 'EC2NodeClass',
      metadata: {
        name: 'github-runners',
        namespace: 'karpenter',
      },
      spec: {
        amiFamily: 'Bottlerocket',
        subnetSelectorTerms: [
          {
            tags: {
              'karpenter.sh/discovery': cluster.clusterName,
            },
          },
        ],
        securityGroupSelectorTerms: [
          {
            tags: {
              'karpenter.sh/discovery': cluster.clusterName,
            },
          },
        ],
        instanceStorePolicy: 'RAID0',
        userData: cdk.Fn.base64(
          [
            '[settings.kubernetes]',
            `cluster-name = "${cluster.clusterName}"`,
            `api-server = "${cluster.clusterEndpoint}"`,
            `cluster-certificate = "${cluster.clusterCertificateAuthorityData}"`,
            '',
            '[settings.container-runtime]',
            'max-container-log-line-size = 16384',
            '',
            '[settings.container-registry]',
            '# Configure Google Container Registry mirror for Docker Hub',
            '"docker.io" = "https://mirror.gcr.io"',
            '# Add your GHES registry (replace with your actual GHES domain)',
            '# "ghes.your-company.com" = "https://ghes.your-company.com"',
            '',
            '[settings.container-registry.credentials]',
            '# GHES registry credentials will be managed by Kubernetes secrets',
            '# The kubelet will handle authentication via imagePullSecrets',
            '',
            '[settings.network]',
            'https-proxy = ""',
            'no-proxy = ["169.254.169.254", "10.0.0.0/8", "ghes.your-company.com"]',
            '',
            '[settings.host-containers.admin]',
            'enabled = true',
            'superpowered = true',
            '',
            '[settings.host-containers.control]',
            'enabled = true',
            'superpowered = false',
            '',
            '# Additional settings for CI/CD workloads',
            '[settings.kernel]',
            'lockdown = "none"',
            '',
            '[settings.kernel.sysctl]',
            '"user.max_user_namespaces" = "65536"',
            '"user.max_pid_namespaces" = "65536"',
          ].join('\n')
        ),
        blockDeviceMappings: [
          {
            deviceName: '/dev/xvda',
            ebs: {
              volumeSize: '20Gi',
              volumeType: 'gp3',
              iops: 3000,
              throughput: 125,
              deleteOnTermination: true,
              encrypted: true,
            },
          },
          {
            deviceName: '/dev/xvdb',
            ebs: {
              volumeSize: '200Gi', // Additional storage for container builds
              volumeType: 'gp3',
              iops: 3000,
              throughput: 125,
              deleteOnTermination: true,
              encrypted: true,
            },
          },
        ],
        role: karpenterStack.karpenterNodeRole.roleName,
        tags: {
          'karpenter.sh/discovery': cluster.clusterName,
          'kubernetes.io/cluster/' + cluster.clusterName: 'owned',
          'node-type': 'github-runner',
          'workload-type': 'ci-cd',
        },
      },
    });

    // Add dependencies
    exampleWorkload.node.addDependency(karpenterStack);
    githubRunnersNodePool.node.addDependency(karpenterStack);
    githubRunnersNodeClass.node.addDependency(karpenterStack);

    // Outputs
    new cdk.CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'EKS Cluster Name',
    });

    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: cluster.clusterEndpoint,
      description: 'EKS Cluster Endpoint',
    });

    new cdk.CfnOutput(this, 'KubectlCommand', {
      value: `aws eks update-kubeconfig --region ${this.region} --name ${cluster.clusterName}`,
      description: 'Command to configure kubectl',
    });

    new cdk.CfnOutput(this, 'TestKarpenterCommand', {
      value: 'kubectl scale deployment example-workload --replicas=5',
      description: 'Command to test Karpenter scaling',
    });
  }
}