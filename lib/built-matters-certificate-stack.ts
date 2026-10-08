import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import { builtMattersConfig as config } from '../config/built-matters';
import { deploymentAccount } from '../config/deployment';

/** External DNS validation completes before the independent hosting stack is deployed. */
export class BuiltMattersCertificateStack extends cdk.Stack {
  public constructor(scope: Construct) {
    super(scope, config.certificateStackName, {
      env: { account: deploymentAccount, region: config.certificateRegion },
      description:
        'Dedicated Built Matters public website TLS certificate; manual Namecheap validation',
    });
    const certificate = new acm.Certificate(this, 'BuiltMattersCertificate', {
      domainName: config.domainName,
      subjectAlternativeNames: config.redirectDomains,
      validation: acm.CertificateValidation.fromDns(),
    });
    certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, 'BuiltMattersCertificateArn', { value: certificate.certificateArn });
    new cdk.CfnOutput(this, 'BuiltMattersCertificateValidationDomains', {
      value: [config.domainName, ...config.redirectDomains].join(','),
      description:
        'Retrieve actual CNAME names/values with ACM DescribeCertificate in us-east-1; see docs/built-matters-website.md',
    });
  }
}
