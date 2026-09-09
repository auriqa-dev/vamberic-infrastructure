import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';

function createStacks() {
  const app = new cdk.App();
  const config = getEnvironmentConfig('dev');
  const network = new NetworkStack(app, config);
  const security = new SecurityStack(app, config, network);
  const observability = new ObservabilityStack(app, config);
  const registry = new RegistryStack(app, config);
  const api = new ApiStack(app, config, network, security, observability, registry, 'test-abcdef0');
  return { network, security, observability, registry, api };
}

describe('Vamberic infrastructure assumptions', () => {
  test('creates public and private network capacity with a NAT gateway', () => {
    const template = Template.fromStack(createStacks().network);

    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: false,
    });
  });

  test('restricts API tasks to traffic from the load balancer', () => {
    const template = Template.fromStack(createStacks().security);

    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 3000,
      ToPort: 3000,
    });
    template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  });

  test('runs the API privately behind a public load balancer', () => {
    const template = Template.fromStack(createStacks().api);

    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      HealthCheckGracePeriodSeconds: 60,
      NetworkConfiguration: {
        AwsvpcConfiguration: {
          AssignPublicIp: 'DISABLED',
        },
      },
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health',
      Matcher: {
        HttpCode: '200-399',
      },
    });
    template.resourceCountIs('AWS::ECR::Repository', 0);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: [
            {
              Name: 'NODE_ENV',
              Value: 'production',
            },
            {
              Name: 'DEPLOYMENT_ENV',
              Value: 'dev',
            },
          ],
          HealthCheck: {
            Command: [
              'CMD',
              'node',
              '-e',
              "fetch('http://127.0.0.1:3000/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));",
            ],
            Interval: 30,
            Retries: 3,
            StartPeriod: 30,
            Timeout: 5,
          },
          Image: {
            'Fn::Join': ['', Match.arrayWith([':test-abcdef0'])],
          },
        }),
      ]),
    });
  });

  test('creates an immutable registry with bounded rollback retention', () => {
    const template = Template.fromStack(createStacks().registry);

    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
      ImageTagMutability: 'IMMUTABLE',
      LifecyclePolicy: Match.objectLike({
        LifecyclePolicyText: Match.anyValue(),
      }),
    });
  });

  test('retains production logs and uses longer retention', () => {
    const app = new cdk.App();
    const config = getEnvironmentConfig('prod');
    const observability = new ObservabilityStack(app, config);
    const template = Template.fromStack(observability);

    template.hasResource('AWS::Logs::LogGroup', {
      Properties: {
        RetentionInDays: 30,
      },
      DeletionPolicy: 'Retain',
    });
  });
});
