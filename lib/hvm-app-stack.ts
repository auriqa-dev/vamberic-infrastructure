import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct } from 'constructs';
import { createPrivateSiteBucket, createSiteDeploymentRole } from './static-site-resources';
export class HvmAppCertificateStack extends cdk.Stack {
  constructor(scope: Construct, account: string) {
    super(scope, 'VambericHvmAppCertificate', { env: { account, region: 'us-east-1' } });
    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: 'app.h-v-m.agency',
      validation: acm.CertificateValidation.fromDns(),
    });
    certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, 'CertificateArn', { value: certificate.certificateArn });
  }
}
export class HvmAppStack extends cdk.Stack {
  constructor(scope: Construct, account: string) {
    super(scope, 'VambericHvmApp', { env: { account, region: 'eu-west-2' } });
    const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
      type: 'String',
      allowedPattern: '^arn:aws:acm:us-east-1:755905325223:certificate/[0-9a-f-]{36}$',
    });
    const bucket = createPrivateSiteBucket(this, 'Bucket');
    const headers = new cf.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.vamberic.com https://cognito-idp.eu-west-2.amazonaws.com https://vamberic-dev-vapp-755905325223.auth.eu-west-2.amazoncognito.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://vamberic-dev-vapp-755905325223.auth.eu-west-2.amazoncognito.com",
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cf.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cf.HeadersReferrerPolicy.NO_REFERRER, override: true },
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), override: true },
      },
    });
    const routing = new cf.Function(this, 'SpaRouting', {
      runtime: cf.FunctionRuntime.JS_2_0,
      code: cf.FunctionCode.fromInline(
        "function handler(event) { var request = event.request; if (request.uri === '/' || !request.uri.split('/').pop().includes('.')) request.uri = '/index.html'; return request; }",
      ),
    });
    const distribution = new cf.Distribution(this, 'Distribution', {
      domainNames: ['app.h-v-m.agency'],
      certificate: acm.Certificate.fromCertificateArn(
        this,
        'Certificate',
        certificateArn.valueAsString,
      ),
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cf.CachePolicy.CACHING_DISABLED,
        responseHeadersPolicy: headers,
        functionAssociations: [
          { eventType: cf.FunctionEventType.VIEWER_REQUEST, function: routing },
        ],
      },
    });
    const role = createSiteDeploymentRole(this, {
      id: 'DeploymentRole',
      description: 'Manual HVMapp deployment from protected GitHub environment',
      oidcRepository: 'auriqa-dev@209590030/hvm-app@1392322706',
      environment: 'hvmapp',
      bucket,
      distribution,
    });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, 'DeploymentRoleArn', { value: role.roleArn });
  }
}
