import * as cdk from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/** Keep resources directly under the supplied scope so existing logical IDs stay stable. */
export function createPrivateSiteBucket(scope: Construct, id: string): s3.Bucket {
  return new s3.Bucket(scope, id, {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}

export function createSiteDeploymentRole(
  scope: Construct,
  props: {
    id: string;
    description: string;
    oidcRepository: string;
    environment: string;
    bucket: s3.IBucket;
    distribution: cloudfront.IDistribution;
  },
): iam.Role {
  const stack = cdk.Stack.of(scope);
  const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    scope,
    'GitHubOidcProvider',
    `arn:${stack.partition}:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
  );
  const role = new iam.Role(scope, props.id, {
    description: props.description,
    assumedBy: new iam.OpenIdConnectPrincipal(provider, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': `repo:${props.oidcRepository}:environment:${props.environment}`,
      },
    }),
    maxSessionDuration: cdk.Duration.hours(1),
  });
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [props.bucket.bucketArn],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      resources: [props.bucket.arnForObjects('*')],
    }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [
        `arn:${stack.partition}:cloudfront::${stack.account}:distribution/${props.distribution.distributionId}`,
      ],
    }),
  );
  return role;
}
