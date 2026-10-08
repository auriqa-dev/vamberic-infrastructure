import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import { builtMattersConfig as config } from '../config/built-matters';
import { deploymentAccount } from '../config/deployment';
import { createPrivateSiteBucket, createSiteDeploymentRole } from './static-site-resources';

export class BuiltMattersWebsiteStack extends cdk.Stack {
  public constructor(scope: Construct) {
    super(scope, config.websiteStackName, {
      env: { account: deploymentAccount, region: config.region },
      description: 'Production static marketing website for Built Matters',
    });
    const certificateArn = new cdk.CfnParameter(this, 'BuiltMattersCertificateArn', {
      type: 'String',
      description:
        'Issued dedicated certificate from VambericProdBuiltMattersCertificate covering all four public domains',
      allowedPattern: '^arn:aws:acm:us-east-1:755905325223:certificate/[0-9a-f-]{36}$',
      constraintDescription:
        'Supply the issued Built Matters certificate ARN in account 755905325223, us-east-1.',
    });
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'BuiltMattersCertificate',
      certificateArn.valueAsString,
    );
    const bucket = createPrivateSiteBucket(this, 'BuiltMattersBucket');
    // Vite's prerender build emits route/index.html and 404.html, not just an SPA shell.
    const routing = new cloudfront.Function(this, 'BuiltMattersRouting', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var request = event.request;
  var aliases = ${JSON.stringify(config.redirectDomains)};
  if (aliases.indexOf(request.headers.host.value) !== -1) {
    var query = [];
    for (var key in request.querystring) {
      var entry = request.querystring[key];
      var values = entry.multiValue || [entry];
      for (var i = 0; i < values.length; i++) query.push(key + '=' + values[i].value);
    }
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: 'https://${config.domainName}' + request.uri + (query.length ? '?' + query.join('&') : '') } }
    };
  }
  var uri = request.uri;
  if (uri.endsWith('/')) request.uri += 'index.html';
  else if (uri.substring(uri.lastIndexOf('/') + 1).indexOf('.') === -1) request.uri += '/index.html';
  return request;
}`),
    });
    // Honour deploy-time Cache-Control for HTML; avoid the managed policy's positive minimum TTL.
    const cachePolicy = new cloudfront.CachePolicy(this, 'BuiltMattersCachePolicy', {
      minTtl: cdk.Duration.seconds(0),
      defaultTtl: cdk.Duration.minutes(5),
      maxTtl: cdk.Duration.days(365),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const distribution = new cloudfront.Distribution(this, 'BuiltMattersDistribution', {
      domainNames: [config.domainName, ...config.redirectDomains],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy,
        functionAssociations: [
          { function: routing, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 404,
        responsePagePath: '/404.html',
        ttl: cdk.Duration.seconds(0),
      })),
    });
    const role = createSiteDeploymentRole(this, {
      id: 'BuiltMattersDeploymentRole',
      description:
        'Built Matters assets and invalidations from the protected built-matters-prod GitHub Environment',
      oidcRepository: config.deploymentOidcRepository,
      environment: config.deploymentEnvironment,
      bucket,
      distribution,
    });
    new cdk.CfnOutput(this, 'BuiltMattersBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'BuiltMattersDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'BuiltMattersDistributionDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'BuiltMattersDeploymentRoleArn', { value: role.roleArn });
    new cdk.CfnOutput(this, 'BuiltMattersCertificateArnOutput', {
      value: certificateArn.valueAsString,
    });
    new cdk.CfnOutput(this, 'BuiltMattersDnsRecords', {
      value: cdk.Fn.join(
        '\n',
        ['built-matters.com', 'built-matters.co.uk'].flatMap((zone) => [
          `${zone}: ALIAS @ -> ${distribution.distributionDomainName}`,
          `${zone}: CNAME www -> ${distribution.distributionDomainName}`,
        ]),
      ),
      description:
        'Namecheap routing records, separate from ACM validation CNAMEs; no app subdomain',
    });
  }
}
