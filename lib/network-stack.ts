import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';

export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;

  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'Network'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} network foundation`,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `vamberic-${config.name}-vpc`,
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: `VPC for the Vamberic ${config.name} environment`,
    });
    new cdk.CfnOutput(this, 'NatGatewayCount', {
      value: String(config.natGateways),
      description: 'NAT Gateway count; each gateway receives an AWS-managed Elastic IP',
    });
  }
}
