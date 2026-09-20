import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { hvmConfig } from '../config/hvm';

export class HvmWebsiteStack extends cdk.Stack {
  public constructor(scope: Construct, account?: string) {
    super(scope, hvmConfig.websiteStackName, {
      env: { account, region: hvmConfig.region },
      description: 'Separate production static hosting for Henry Vincent Moss Agency',
    });
    // Explicit handoff avoids cross-region custom resources and allows DNS validation first.
    const certificateArn = new cdk.CfnParameter(this, 'HvmCertificateArn', {
      type: 'String',
      description:
        'Issued dedicated HVM certificate ARN from VambericProdHvmCertificate in us-east-1, in this AWS account',
      allowedPattern: '^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]{36}$',
      constraintDescription:
        'Provide an ACM certificate ARN in us-east-1 covering h-v-m.agency and www.h-v-m.agency.',
    });
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'HvmCertificate',
      certificateArn.valueAsString,
    );
    const bucket = new s3.Bucket(this, 'HvmBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const redirect = new cloudfront.Function(this, 'HvmCanonicalRedirect', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  if (request.headers.host.value !== '${hvmConfig.wwwDomainName}') return request;
  var query = [];
  for (var key in request.querystring) {
    var entry = request.querystring[key];
    var values = entry.multiValue || [entry];
    for (var i = 0; i < values.length; i++) {
      query.push(key + '=' + values[i].value);
    }
  }
  return {
    statusCode: 301,
    statusDescription: 'Moved Permanently',
    headers: { location: { value: 'https://${hvmConfig.domainName}' + request.uri + (query.length ? '?' + query.join('&') : '') } }
  };
}`),
    });
    const distribution = new cloudfront.Distribution(this, 'HvmDistribution', {
      domainNames: [hvmConfig.domainName, hvmConfig.wwwDomainName],
      certificate,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        functionAssociations: [
          { function: redirect, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: cdk.Duration.seconds(0),
      })),
    });
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      `arn:${this.partition}:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`,
    );
    const role = new iam.Role(this, 'HvmDeploymentRole', {
      description: 'HVM assets and invalidations from the protected GitHub hvm-prod Environment',
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${hvmConfig.deploymentOidcRepository}:environment:${hvmConfig.deploymentEnvironment}`,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [bucket.arnForObjects('*')],
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
    new cdk.CfnOutput(this, 'HvmBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'HvmDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'HvmDistributionDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'HvmDeploymentRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'HvmCertificateArnOutput', { value: certificateArn.valueAsString });
  }
}
