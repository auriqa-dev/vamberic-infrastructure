import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import { hvmConfig } from '../config/hvm';

/** Deploy and complete external DNS validation before deploying HVM hosting. */
export class HvmCertificateStack extends cdk.Stack {
  public constructor(scope: Construct, account?: string) {
    super(scope, hvmConfig.certificateStackName, {
      env: { account, region: hvmConfig.certificateRegion },
      description: 'Dedicated HVM CloudFront certificate; DNS validation managed in Namecheap',
    });
    const certificate = new acm.Certificate(this, 'HvmCertificate', {
      domainName: hvmConfig.domainName,
      subjectAlternativeNames: [hvmConfig.wwwDomainName],
      validation: acm.CertificateValidation.fromDns(),
    });
    certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, 'HvmCertificateArn', { value: certificate.certificateArn });
    new cdk.CfnOutput(this, 'HvmCertificateValidationDomains', {
      value: `${hvmConfig.domainName},${hvmConfig.wwwDomainName}`,
      description:
        'Retrieve exact validation CNAMEs from ACM in us-east-1 while issuance is pending; see docs/hvm-website.md',
    });
  }
}
