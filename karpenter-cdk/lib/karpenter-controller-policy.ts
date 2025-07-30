import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface KarpenterControllerPolicyProps {
  /**
   * The name of the EKS cluster
   */
  clusterName: string;
  
  /**
   * The ARN of the Karpenter interruption SQS queue
   */
  karpenterInterruptionQueueArn: string;
  
  /**
   * The ARN of the Karpenter node IAM role
   */
  karpenterNodeRoleArn: string;
}

/**
 * CDK Construct for Karpenter Controller IAM Policy
 * Based on the official Karpenter v1.6.1 policy requirements
 */
export class KarpenterControllerPolicy extends Construct {
  public readonly managedPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: KarpenterControllerPolicyProps) {
    super(scope, id);

    const { clusterName, karpenterInterruptionQueueArn, karpenterNodeRoleArn } = props;

    this.managedPolicy = new iam.ManagedPolicy(this, 'Policy', {
      managedPolicyName: `KarpenterControllerPolicy-${clusterName}`,
      description: `IAM policy for Karpenter controller in cluster ${clusterName}`,
      statements: [
        // Allow scoped EC2 instance access actions
        new iam.PolicyStatement({
          sid: 'AllowScopedEC2InstanceAccessActions',
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}::image/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}::snapshot/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:security-group/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:subnet/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:capacity-reservation/*`,
          ],
          actions: [
            'ec2:RunInstances',
            'ec2:CreateFleet',
          ],
        }),

        // Allow scoped EC2 launch template access actions
        new iam.PolicyStatement({
          sid: 'AllowScopedEC2LaunchTemplateAccessActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:launch-template/*`],
          actions: [
            'ec2:RunInstances',
            'ec2:CreateFleet',
          ],
          conditions: {
            StringEquals: {
              [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
            },
            StringLike: {
              'aws:ResourceTag/karpenter.sh/nodepool': '*',
            },
          },
        }),

        // Allow scoped EC2 instance actions with tags
        new iam.PolicyStatement({
          sid: 'AllowScopedEC2InstanceActionsWithTags',
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:fleet/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:instance/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:volume/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:network-interface/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:launch-template/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:spot-instances-request/*`,
          ],
          actions: [
            'ec2:RunInstances',
            'ec2:CreateFleet',
            'ec2:CreateLaunchTemplate',
          ],
          conditions: {
            StringEquals: {
              [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:RequestTag/eks:eks-cluster-name`]: clusterName,
            },
            StringLike: {
              'aws:RequestTag/karpenter.sh/nodepool': '*',
            },
          },
        }),

        // Allow scoped resource creation tagging
        new iam.PolicyStatement({
          sid: 'AllowScopedResourceCreationTagging',
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:fleet/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:instance/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:volume/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:network-interface/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:launch-template/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:spot-instances-request/*`,
          ],
          actions: ['ec2:CreateTags'],
          conditions: {
            StringEquals: {
              [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:RequestTag/eks:eks-cluster-name`]: clusterName,
              'ec2:CreateAction': [
                'RunInstances',
                'CreateFleet',
                'CreateLaunchTemplate',
              ],
            },
            StringLike: {
              'aws:RequestTag/karpenter.sh/nodepool': '*',
            },
          },
        }),

        // Allow scoped resource tagging
        new iam.PolicyStatement({
          sid: 'AllowScopedResourceTagging',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:instance/*`],
          actions: ['ec2:CreateTags'],
          conditions: {
            StringEquals: {
              [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
            },
            StringLike: {
              'aws:ResourceTag/karpenter.sh/nodepool': '*',
            },
            StringEqualsIfExists: {
              [`aws:RequestTag/eks:eks-cluster-name`]: clusterName,
            },
            'ForAllValues:StringEquals': {
              'aws:TagKeys': [
                'eks:eks-cluster-name',
                'karpenter.sh/nodeclaim',
                'Name',
              ],
            },
          },
        }),

        // Allow scoped deletion
        new iam.PolicyStatement({
          sid: 'AllowScopedDeletion',
          effect: iam.Effect.ALLOW,
          resources: [
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:instance/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:*:launch-template/*`,
          ],
          actions: [
            'ec2:TerminateInstances',
            'ec2:DeleteLaunchTemplate',
          ],
          conditions: {
            StringEquals: {
              [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
            },
            StringLike: {
              'aws:ResourceTag/karpenter.sh/nodepool': '*',
            },
          },
        }),

        // Allow regional read actions
        new iam.PolicyStatement({
          sid: 'AllowRegionalReadActions',
          effect: iam.Effect.ALLOW,
          resources: ['*'],
          actions: [
            'ec2:DescribeCapacityReservations',
            'ec2:DescribeImages',
            'ec2:DescribeInstances',
            'ec2:DescribeInstanceTypeOfferings',
            'ec2:DescribeInstanceTypes',
            'ec2:DescribeLaunchTemplates',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeSpotPriceHistory',
            'ec2:DescribeSubnets',
          ],
          conditions: {
            StringEquals: {
              'aws:RequestedRegion': cdk.Aws.REGION,
            },
          },
        }),

        // Allow SSM read actions
        new iam.PolicyStatement({
          sid: 'AllowSSMReadActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}::parameter/aws/service/*`],
          actions: ['ssm:GetParameter'],
        }),

        // Allow pricing read actions
        new iam.PolicyStatement({
          sid: 'AllowPricingReadActions',
          effect: iam.Effect.ALLOW,
          resources: ['*'],
          actions: ['pricing:GetProducts'],
        }),

        // Allow interruption queue actions
        new iam.PolicyStatement({
          sid: 'AllowInterruptionQueueActions',
          effect: iam.Effect.ALLOW,
          resources: [karpenterInterruptionQueueArn],
          actions: [
            'sqs:DeleteMessage',
            'sqs:GetQueueUrl',
            'sqs:ReceiveMessage',
          ],
        }),

        // Allow passing instance role
        new iam.PolicyStatement({
          sid: 'AllowPassingInstanceRole',
          effect: iam.Effect.ALLOW,
          resources: [karpenterNodeRoleArn],
          actions: ['iam:PassRole'],
          conditions: {
            StringEquals: {
              'iam:PassedToService': [
                'ec2.amazonaws.com',
                'ec2.amazonaws.com.cn',
              ],
            },
          },
        }),

        // Allow scoped instance profile creation actions
        new iam.PolicyStatement({
          sid: 'AllowScopedInstanceProfileCreationActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/*`],
          actions: ['iam:CreateInstanceProfile'],
          conditions: {
            StringEquals: {
              [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:RequestTag/eks:eks-cluster-name`]: clusterName,
              [`aws:RequestTag/topology.kubernetes.io/region`]: cdk.Aws.REGION,
            },
            StringLike: {
              'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass': '*',
            },
          },
        }),

        // Allow scoped instance profile tag actions
        new iam.PolicyStatement({
          sid: 'AllowScopedInstanceProfileTagActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/*`],
          actions: ['iam:TagInstanceProfile'],
          conditions: {
            StringEquals: {
              [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:ResourceTag/topology.kubernetes.io/region`]: cdk.Aws.REGION,
              [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:RequestTag/eks:eks-cluster-name`]: clusterName,
              [`aws:RequestTag/topology.kubernetes.io/region`]: cdk.Aws.REGION,
            },
            StringLike: {
              'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass': '*',
              'aws:RequestTag/karpenter.k8s.aws/ec2nodeclass': '*',
            },
          },
        }),

        // Allow scoped instance profile actions
        new iam.PolicyStatement({
          sid: 'AllowScopedInstanceProfileActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/*`],
          actions: [
            'iam:AddRoleToInstanceProfile',
            'iam:RemoveRoleFromInstanceProfile',
            'iam:DeleteInstanceProfile',
          ],
          conditions: {
            StringEquals: {
              [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: 'owned',
              [`aws:ResourceTag/topology.kubernetes.io/region`]: cdk.Aws.REGION,
            },
            StringLike: {
              'aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass': '*',
            },
          },
        }),

        // Allow instance profile read actions
        new iam.PolicyStatement({
          sid: 'AllowInstanceProfileReadActions',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:iam::${cdk.Aws.ACCOUNT_ID}:instance-profile/*`],
          actions: ['iam:GetInstanceProfile'],
        }),

        // Allow API server endpoint discovery
        new iam.PolicyStatement({
          sid: 'AllowAPIServerEndpointDiscovery',
          effect: iam.Effect.ALLOW,
          resources: [`arn:${cdk.Aws.PARTITION}:eks:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:cluster/${clusterName}`],
          actions: ['eks:DescribeCluster'],
        }),
      ],
    });
  }
}