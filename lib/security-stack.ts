import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';
import type { NetworkStack } from './network-stack';

export class SecurityStack extends cdk.Stack {
  public readonly loadBalancerSecurityGroup: ec2.SecurityGroup;
  public readonly serviceSecurityGroup: ec2.SecurityGroup;
  public readonly apiRuntimeSecret: secretsmanager.ISecret;

  public constructor(scope: Construct, config: EnvironmentConfig, network: NetworkStack) {
    super(scope, stackName(config, 'Security'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} security controls`,
    });

    this.loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'LoadBalancerSecurityGroup', {
      vpc: network.vpc,
      securityGroupName: `vamberic-${config.name}-alb`,
      description: 'Public ingress for the Vamberic API load balancer',
      allowAllOutbound: true,
    });
    this.loadBalancerSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Public HTTP ingress until an ACM certificate is introduced',
    );

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc: network.vpc,
      securityGroupName: `vamberic-${config.name}-api`,
      description: 'Private ingress for the Vamberic API ECS service',
      allowAllOutbound: true,
    });
    this.serviceSecurityGroup.addIngressRule(
      this.loadBalancerSecurityGroup,
      ec2.Port.tcp(config.containerPort),
      'Only the public load balancer may reach the API task',
    );

    if (config.apiRuntimeSecretName) {
      this.apiRuntimeSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'ApiRuntimeSecret',
        config.apiRuntimeSecretName,
      );
    } else {
      this.apiRuntimeSecret = new secretsmanager.Secret(this, 'ApiRuntimeSecret', {
        secretName: `vamberic/${config.name}/api`,
        description: `Runtime configuration for the Vamberic ${config.name} API`,
        generateSecretString: {
          secretStringTemplate: '{}',
          generateStringKey: 'placeholder',
          excludePunctuation: true,
        },
      });

      new cdk.CfnOutput(this, 'ApiRuntimeSecretArn', {
        value: this.apiRuntimeSecret.secretArn,
        description: 'Store API runtime configuration here before a future deployment',
      });
    }
  }
}
