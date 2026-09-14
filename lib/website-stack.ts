import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { WebsiteConfig } from '../config/website';

export class WebsiteStack extends cdk.Stack {
  public constructor(scope: Construct, config: WebsiteConfig) {
    super(scope, config.stackName, {
      env: {
        account: config.account,
        region: config.region,
      },
      description: 'Production static website hosting for www.vamberic.com',
    });

    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'WebsiteCertificate',
      config.certificateArn,
    );

    const distribution = new cloudfront.Distribution(this, 'WebsiteDistribution', {
      domainNames: [config.domainName],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
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

    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: websiteBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'WebsiteDistributionId', {
      value: distribution.distributionId,
    });
    new cdk.CfnOutput(this, 'WebsiteDistributionDomainName', {
      value: distribution.distributionDomainName,
    });
  }
}
