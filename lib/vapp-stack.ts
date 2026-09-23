import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { stackName, type EnvironmentConfig } from '../config/environment';
import { vappConfig } from '../config/vapp';

export class VappStack extends cdk.Stack {
  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'Vapp'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: 'Separate static Vapp hosting for app.vamberic.com',
    });

    const vappBucket = new s3.Bucket(this, 'VappBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'VappCertificate',
      vappConfig.certificateArn,
    );

    const distribution = new cloudfront.Distribution(this, 'VappDistribution', {
      domainNames: [vappConfig.domainName],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(vappBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // Reuse the account's GitHub provider; never create a duplicate provider.
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const role = new iam.Role(this, 'VappDeploymentRole', {
      description: 'Deploy Vapp assets from the protected GitHub vapp Environment',
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${vappConfig.deploymentOidcRepository}:environment:${vappConfig.deploymentEnvironment}`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [vappBucket.bucketArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:DeleteObject'],
        resources: [vappBucket.arnForObjects('*')],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [
          `arn:${this.partition}:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        ],
      }),
    );
    new cdk.CfnOutput(this, 'VappDeploymentRoleArn', { value: role.roleArn });

    new cdk.CfnOutput(this, 'VappBucketName', {
      value: vappBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'VappDistributionId', {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'VappDistributionDomainName', {
      value: distribution.distributionDomainName,
    });
  }
}
