# brown-rabbit


import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as eks from 'aws-cdk-lib/aws-eks';

export class MyIrsaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. Reference your existing EKS cluster's OIDC provider
    const oidcProviderArn = `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/oidc.eks.${cdk.Aws.REGION}.amazonaws.com/id/YOUR_OIDC_PROVIDER_ID`;
    const oidcProvider = eks.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'OidcProvider', oidcProviderArn);

    // 2. Define the namespace and service account
    const namespace = 'nexus-ns';
    const serviceAccount = 'nexus-sa';

    // 3. Create the IAM Role for the Nexus Service Account
    const nexusRole = new iam.Role(this, 'NexusIrsaRole', {
      assumedBy: new iam.FederatedPrincipal(
        oidcProvider.openIdConnectProviderArn,
        {
          // Condition to scope the trust policy to the specific service account
          StringEquals: {
            [`${oidcProvider.openIdConnectProviderIssuer}:sub`]: `system:serviceaccount:${namespace}:${serviceAccount}`,
          },
        },
        'sts:AssumeRoleWithWebIdentity' // The action performed by the federated user
      ),
      roleName: 'nexus-irsa-role',
      description: `IAM Role for the ${serviceAccount} service account in ${namespace}`,
    });

    // 4. (Optional) Attach policies to the role
    // For example, to allow access to an S3 bucket
    nexusRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: ['arn:aws:s3:::my-nexus-bucket/*'],
    }));
  }
}
