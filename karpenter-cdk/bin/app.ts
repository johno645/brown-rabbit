#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MainStack } from '../lib/main-stack';

const app = new cdk.App();

new MainStack(app, 'KarpenterEksStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-west-2',
  },
  description: 'EKS cluster with Karpenter 1.6.1 for autoscaling',
  tags: {
    Project: 'Karpenter-Demo',
    Environment: 'Development',
    ManagedBy: 'CDK',
  },
});