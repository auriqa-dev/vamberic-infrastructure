import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { websiteConfig } from '../config/website';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';
import { WebsiteStack } from '../lib/website-stack';

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
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });

  test('requires the complete runtime secret ARN for development', () => {
    const app = new cdk.App();
    const config = {
      ...getEnvironmentConfig('dev'),
      apiRuntimeSecretCompleteArn: undefined,
    };
    const network = new NetworkStack(app, config);

    expect(() => new SecurityStack(app, config, network)).toThrow(
      /must be imported by complete ARN/,
    );
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
          Secrets: [
            {
              Name: 'MONGODB_URI',
              ValueFrom:
                'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/api-vDW6XL:MONGODB_URI::',
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
    const roles = template.findResources('AWS::IAM::Role');
    const executionRoleEntry = Object.entries(roles).find(
      ([, role]) => role.Properties.RoleName === 'vamberic-dev-api-execution',
    );
    const taskRoleEntry = Object.entries(roles).find(
      ([, role]) => role.Properties.RoleName === 'vamberic-dev-api-task',
    );
    expect(executionRoleEntry).toBeDefined();
    expect(taskRoleEntry).toBeDefined();

    const policies = template.findResources('AWS::IAM::Policy');
    const secretPolicyEntry = Object.entries(policies).find(([, policy]) =>
      policy.Properties.PolicyDocument.Statement.some(
        (statement: { Action?: string | string[] }) =>
          statement.Action === 'secretsmanager:GetSecretValue' ||
          statement.Action?.includes('secretsmanager:GetSecretValue'),
      ),
    );
    expect(secretPolicyEntry).toBeDefined();

    const [executionRoleLogicalId] = executionRoleEntry!;
    const [taskRoleLogicalId] = taskRoleEntry!;
    const [secretPolicyLogicalId, secretPolicy] = secretPolicyEntry!;
    expect(secretPolicy.Properties.Roles).toEqual([{ Ref: executionRoleLogicalId }]);
    expect(secretPolicy.Properties.Roles).not.toContainEqual({ Ref: taskRoleLogicalId });
    expect(secretPolicy.Properties.PolicyDocument.Statement).toContainEqual(
      expect.objectContaining({
        Action: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
        Effect: 'Allow',
        Resource: 'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/api-vDW6XL',
      }),
    );
    expect(JSON.stringify(secretPolicy.Properties.PolicyDocument.Statement)).not.toContain(
      '??????',
    );

    const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition');
    expect(Object.values(taskDefinitions)[0].DependsOn).toContain(secretPolicyLogicalId);
    template.hasOutput('ApiClusterName', {
      Value: {
        Ref: Match.stringLikeRegexp('ApiCluster'),
      },
    });
    template.hasOutput('ApiTaskDefinitionArn', {
      Value: {
        Ref: Match.stringLikeRegexp('ApiTaskDefinition'),
      },
    });
    template.hasOutput('ApiPrivateSubnetIds', {
      Value: {
        'Fn::Join': [
          ',',
          Match.arrayWith([
            Match.objectLike({
              'Fn::ImportValue': Match.stringLikeRegexp('applicationSubnet1Subnet'),
            }),
            Match.objectLike({
              'Fn::ImportValue': Match.stringLikeRegexp('applicationSubnet2Subnet'),
            }),
          ]),
        ],
      },
    });
    template.hasOutput('ApiTaskSecurityGroupId', {
      Value: {
        'Fn::ImportValue': Match.stringLikeRegexp('ServiceSecurityGroup'),
      },
    });
    template.hasOutput('ApiContainerName', {
      Value: 'api',
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

  test('hosts the production website privately behind CloudFront', () => {
    const app = new cdk.App();
    const website = new WebsiteStack(app, websiteConfig);
    const template = Template.fromStack(website);

    template.hasResource('AWS::S3::Bucket', {
      Properties: {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {
                SSEAlgorithm: 'AES256',
              },
            },
          ],
        },
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.values(buckets)[0].Properties).not.toHaveProperty('WebsiteConfiguration');
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
            Effect: 'Deny',
          }),
          Match.objectLike({
            Action: 's3:GetObject',
            Condition: {
              StringEquals: {
                'AWS:SourceArn': Match.anyValue(),
              },
            },
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['www.vamberic.com'],
        CustomErrorResponses: [
          {
            ErrorCachingMinTTL: 0,
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          },
          {
            ErrorCachingMinTTL: 0,
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          },
        ],
        DefaultCacheBehavior: Match.objectLike({
          Compress: true,
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
        DefaultRootObject: 'index.html',
        Enabled: true,
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: {
              OriginAccessIdentity: '',
            },
          }),
        ]),
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: websiteConfig.certificateArn,
          SslSupportMethod: 'sni-only',
        }),
      }),
    });
    template.resourceCountIs('AWS::EC2::Instance', 0);
    template.resourceCountIs('AWS::ECS::Service', 0);
    template.resourceCountIs('AWS::Lambda::Function', 0);
    template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
    template.hasOutput('WebsiteBucketName', {});
    template.hasOutput('WebsiteDistributionId', {});
    template.hasOutput('WebsiteDistributionDomainName', {});
  });
});
