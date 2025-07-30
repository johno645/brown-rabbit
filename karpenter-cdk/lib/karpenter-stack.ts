import * as cdk from 'aws-cdk-lib';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { KarpenterControllerPolicy } from './karpenter-controller-policy';

export interface KarpenterStackProps extends cdk.StackProps {
    cluster: eks.Cluster;
    vpc: ec2.Vpc;
}

export class KarpenterStack extends cdk.Stack {
    public readonly karpenterNodeInstanceProfile: iam.CfnInstanceProfile;
    public readonly karpenterNodeRole: iam.Role;

    constructor(scope: Construct, id: string, props: KarpenterStackProps) {
        super(scope, id, props);

        const { cluster, vpc } = props;

        // Create Karpenter node IAM role
        this.karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
            roleName: `KarpenterNodeInstanceRole-${cluster.clusterName}`,
            assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
            ],
        });

        // Create instance profile for Karpenter nodes
        this.karpenterNodeInstanceProfile = new iam.CfnInstanceProfile(this, 'KarpenterNodeInstanceProfile', {
            instanceProfileName: `KarpenterNodeInstanceProfile-${cluster.clusterName}`,
            roles: [this.karpenterNodeRole.roleName],
        });

        // Create SQS queue for spot interruption handling
        const karpenterQueue = new sqs.Queue(this, 'KarpenterQueue', {
            queueName: `Karpenter-${cluster.clusterName}`,
            messageRetentionPeriod: cdk.Duration.seconds(300),
        });

        // Create Karpenter controller IAM role
        const karpenterControllerRole = new iam.Role(this, 'KarpenterControllerRole', {
            roleName: `KarpenterControllerRole-${cluster.clusterName}`,
            assumedBy: new iam.FederatedPrincipal(
                cluster.openIdConnectProvider.openIdConnectProviderArn,
                {
                    StringEquals: {
                        [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:sub`]: 'system:serviceaccount:karpenter:karpenter',
                        [`${cluster.openIdConnectProvider.openIdConnectProviderIssuer}:aud`]: 'sts.amazonaws.com',
                    },
                },
                'sts:AssumeRoleWithWebIdentity'
            ),
        });

        // Create Karpenter controller policy using the new construct
        const karpenterControllerPolicyConstruct = new KarpenterControllerPolicy(this, 'KarpenterControllerPolicy', {
            clusterName: cluster.clusterName,
            karpenterInterruptionQueueArn: karpenterQueue.queueArn,
            karpenterNodeRoleArn: this.karpenterNodeRole.roleArn,
        });

        // Attach the managed policy to the controller role
        karpenterControllerRole.addManagedPolicy(karpenterControllerPolicyConstruct.managedPolicy);

        // Create EventBridge rules for spot interruption
        const spotInterruptionRule = new events.Rule(this, 'SpotInterruptionRule', {
            eventPattern: {
                source: ['aws.ec2'],
                detailType: ['EC2 Spot Instance Interruption Warning'],
            },
        });

        const scheduledChangeRule = new events.Rule(this, 'ScheduledChangeRule', {
            eventPattern: {
                source: ['aws.health'],
                detailType: ['AWS Health Event'],
            },
        });

        const instanceStateChangeRule = new events.Rule(this, 'InstanceStateChangeRule', {
            eventPattern: {
                source: ['aws.ec2'],
                detailType: ['EC2 Instance State-change Notification'],
            },
        });

        // Add SQS targets to EventBridge rules
        spotInterruptionRule.addTarget(new targets.SqsQueue(karpenterQueue));
        scheduledChangeRule.addTarget(new targets.SqsQueue(karpenterQueue));
        instanceStateChangeRule.addTarget(new targets.SqsQueue(karpenterQueue));

        // Create Karpenter namespace
        const karpenterNamespace = cluster.addManifest('KarpenterNamespace', {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: {
                name: 'karpenter',
                labels: {
                    'app.kubernetes.io/name': 'karpenter',
                },
            },
        });

        // Create ServiceAccount for Karpenter
        const karpenterServiceAccount = cluster.addManifest('KarpenterServiceAccount', {
            apiVersion: 'v1',
            kind: 'ServiceAccount',
            metadata: {
                name: 'karpenter',
                namespace: 'karpenter',
                annotations: {
                    'eks.amazonaws.com/role-arn': karpenterControllerRole.roleArn,
                },
            },
        });

        // Apply Karpenter CRDs and controller manifests directly
        // This approach uses kubectl apply with the official Karpenter manifests
        const karpenterManifests = cluster.addManifest('KarpenterController', {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: {
                name: 'karpenter-install-script',
                namespace: 'karpenter',
            },
            data: {
                'install.sh': `#!/bin/bash
set -e

echo "Installing Karpenter 1.6.1..."

# Install required tools
yum update -y
yum install -y curl tar gzip

# Install kubectl
curl -LO "https://dl.k8s.io/release/v1.28.0/bin/linux/amd64/kubectl"
chmod +x kubectl
mv kubectl /usr/local/bin/

# Install Helm
curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
chmod 700 get_helm.sh
./get_helm.sh

# Configure kubectl to use the cluster
aws eks update-kubeconfig --region $AWS_DEFAULT_REGION --name $CLUSTER_NAME

# Authenticate with ECR Public for OCI registry access
aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws

# Install Karpenter using Helm with OCI registry
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \\
  --version 1.6.1 \\
  --namespace karpenter \\
  --create-namespace \\
  --set serviceAccount.create=false \\
  --set serviceAccount.name=karpenter \\
  --set settings.clusterName=$CLUSTER_NAME \\
  --set settings.clusterEndpoint=$CLUSTER_ENDPOINT \\
  --set settings.interruptionQueue=$INTERRUPTION_QUEUE \\
  --set settings.featureGates.drift=true \\
  --set settings.featureGates.spotToSpotConsolidation=true \\
  --set controller.resources.requests.cpu=1 \\
  --set controller.resources.requests.memory=1Gi \\
  --set controller.resources.limits.cpu=1 \\
  --set controller.resources.limits.memory=1Gi \\
  --set webhook.enabled=true \\
  --set webhook.port=8443 \\
  --set logLevel=info \\
  --set batchMaxDuration=10s \\
  --set batchIdleDuration=1s \\
  --wait

echo "Karpenter installation completed successfully!"

# Verify installation
kubectl get pods -n karpenter
kubectl get deployment -n karpenter
`,
            },
        });

        // Create RBAC for installer job
        const installerRole = cluster.addManifest('KarpenterInstallerRole', {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRole',
            metadata: {
                name: 'karpenter-installer',
            },
            rules: [
                {
                    apiGroups: ['*'],
                    resources: ['*'],
                    verbs: ['*'],
                },
            ],
        });

        const installerRoleBinding = cluster.addManifest('KarpenterInstallerRoleBinding', {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRoleBinding',
            metadata: {
                name: 'karpenter-installer',
            },
            roleRef: {
                apiGroup: 'rbac.authorization.k8s.io',
                kind: 'ClusterRole',
                name: 'karpenter-installer',
            },
            subjects: [
                {
                    kind: 'ServiceAccount',
                    name: 'karpenter',
                    namespace: 'karpenter',
                },
            ],
        });

        // Create a Job to install Karpenter
        const karpenterInstallJob = cluster.addManifest('KarpenterInstallJob', {
            apiVersion: 'batch/v1',
            kind: 'Job',
            metadata: {
                name: 'karpenter-installer',
                namespace: 'karpenter',
            },
            spec: {
                template: {
                    spec: {
                        serviceAccountName: 'karpenter',
                        restartPolicy: 'OnFailure',
                        containers: [
                            {
                                name: 'installer',
                                image: 'amazon/aws-cli:latest',
                                command: ['/bin/bash'],
                                args: ['/scripts/install.sh'],
                                volumeMounts: [
                                    {
                                        name: 'install-script',
                                        mountPath: '/scripts',
                                    },
                                ],
                                env: [
                                    {
                                        name: 'AWS_DEFAULT_REGION',
                                        value: this.region,
                                    },
                                    {
                                        name: 'CLUSTER_NAME',
                                        value: cluster.clusterName,
                                    },
                                    {
                                        name: 'CLUSTER_ENDPOINT',
                                        value: cluster.clusterEndpoint,
                                    },
                                    {
                                        name: 'INTERRUPTION_QUEUE',
                                        value: karpenterQueue.queueName,
                                    },
                                ],
                            },
                        ],
                        volumes: [
                            {
                                name: 'install-script',
                                configMap: {
                                    name: 'karpenter-install-script',
                                    defaultMode: 0o755,
                                },
                            },
                        ],
                    },
                },
                backoffLimit: 3,
            },
        });

        // Add dependencies
        karpenterServiceAccount.node.addDependency(karpenterNamespace);
        karpenterManifests.node.addDependency(karpenterServiceAccount);
        karpenterInstallJob.node.addDependency(karpenterManifests);

        // Create default NodePool
        const defaultNodePool = cluster.addManifest('DefaultNodePool', {
            apiVersion: 'karpenter.sh/v1beta1',
            kind: 'NodePool',
            metadata: {
                name: 'default',
                namespace: 'karpenter',
            },
            spec: {
                template: {
                    metadata: {
                        labels: {
                            'node-type': 'karpenter',
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
                                values: ['m5.large', 'm5.xlarge', 'm5.2xlarge', 'm5.4xlarge', 'c5.large', 'c5.xlarge', 'c5.2xlarge', 'c5.4xlarge'],
                            },
                        ],
                        nodeClassRef: {
                            apiVersion: 'karpenter.k8s.aws/v1beta1',
                            kind: 'EC2NodeClass',
                            name: 'default',
                        },
                        taints: [
                            {
                                key: 'karpenter.sh/unschedulable',
                                value: 'true',
                                effect: 'NoSchedule',
                            },
                        ],
                    },
                },
                disruption: {
                    consolidationPolicy: 'WhenUnderutilized',
                    consolidateAfter: '30s',
                    expireAfter: '30m',
                },
                limits: {
                    cpu: '1000',
                    memory: '1000Gi',
                },
            },
        });

        // Create default EC2NodeClass
        const defaultNodeClass = cluster.addManifest('DefaultNodeClass', {
            apiVersion: 'karpenter.k8s.aws/v1beta1',
            kind: 'EC2NodeClass',
            metadata: {
                name: 'default',
                namespace: 'karpenter',
            },
            spec: {
                amiFamily: 'AL2',
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
                        '#!/bin/bash',
                        '/etc/eks/bootstrap.sh ' + cluster.clusterName,
                        'echo "net.ipv4.conf.all.route_localnet = 1" >> /etc/sysctl.conf',
                        'sysctl -p /etc/sysctl.conf',
                    ].join('\n')
                ),
                blockDeviceMappings: [
                    {
                        deviceName: '/dev/xvda',
                        ebs: {
                            volumeSize: '100Gi',
                            volumeType: 'gp3',
                            iops: 3000,
                            throughput: 125,
                            deleteOnTermination: true,
                            encrypted: true,
                        },
                    },
                ],
                role: this.karpenterNodeRole.roleName,
                tags: {
                    'karpenter.sh/discovery': cluster.clusterName,
                    'kubernetes.io/cluster/' + cluster.clusterName: 'owned',
                },
            },
        });

        // Add dependencies
        defaultNodePool.node.addDependency(karpenterInstallJob);
        defaultNodeClass.node.addDependency(karpenterInstallJob);

        // Tag subnets for Karpenter discovery
        vpc.privateSubnets.forEach((subnet, index) => {
            cdk.Tags.of(subnet).add('karpenter.sh/discovery', cluster.clusterName);
        });

        // Output important values
        new cdk.CfnOutput(this, 'KarpenterControllerRoleArn', {
            value: karpenterControllerRole.roleArn,
            description: 'Karpenter Controller IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'KarpenterNodeRoleArn', {
            value: this.karpenterNodeRole.roleArn,
            description: 'Karpenter Node IAM Role ARN',
        });

        new cdk.CfnOutput(this, 'KarpenterQueueName', {
            value: karpenterQueue.queueName,
            description: 'Karpenter SQS Queue Name',
        });
    }


}