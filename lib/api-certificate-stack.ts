import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type { Construct } from 'constructs';
import { stackName, type EnvironmentConfig } from '../config/environment';
import { vappConfig } from '../config/vapp';

/** Separate stack allows external DNS validation before updating the running API. */
export class ApiCertificateStack extends cdk.Stack {
  public readonly certificate: acm.ICertificate;

  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'ApiCertificate'), {
      env: { account: config.account, region: config.region },
      description: 'Regional API TLS certificate; DNS validation is operator-managed',
    });
    if (config.region !== 'eu-west-2') {
      throw new Error('Vapp API HTTPS must be deployed in eu-west-2.');
    }
    this.certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: vappConfig.apiDomainName,
      validation: acm.CertificateValidation.fromDns(),
    });
    this.certificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, 'ApiCertificateArn', { value: this.certificate.certificateArn });
  }
}
