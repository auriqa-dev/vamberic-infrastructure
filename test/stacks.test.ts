import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { websiteConfig } from '../config/website';
import { AuthStack } from '../lib/auth-stack';
import { ApiCertificateStack } from '../lib/api-certificate-stack';
import { VappStack } from '../lib/vapp-stack';
import productionWebsiteBaseline from './fixtures/production-website.template.json';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';
import { WebsiteStack } from '../lib/website-stack';

function createStacks(existingCertificateArn?: string, imageTag = 'test-abcdef0') {
  const app = new cdk.App();
  const config = getEnvironmentConfig('dev');
  const network = new NetworkStack(app, config);
  const security = new SecurityStack(app, config, network);
  const observability = new ObservabilityStack(app, config);
  const registry = new RegistryStack(app, config);
  const auth = new AuthStack(app, config);
  const certificate = existingCertificateArn ? undefined : new ApiCertificateStack(app, config);
  const api = new ApiStack(
    app,
    config,
    network,
    security,
    observability,
    registry,
    imageTag,
    auth,
    existingCertificateArn ?? certificate?.certificate,
  );
  return { app, network, security, observability, registry, api, auth, certificate };
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
          Environment: Match.arrayWith([
            {
              Name: 'NODE_ENV',
              Value: 'production',
            },
            {
              Name: 'DEPLOYMENT_ENV',
              Value: 'dev',
            },
          ]),
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
            'Fn::Join': ['', Match.arrayWith([{ Ref: 'ApiImageTag' }])],
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

describe('authenticated Vapp', () => {
  test('configured dev release imports the issued certificate and uses the image parameter', () => {
    const config = getEnvironmentConfig('dev');
    const stacks = createStacks(config.apiCertificateArn, config.apiImageTag);
    const template = Template.fromStack(stacks.api);
    expect(stacks.certificate).toBeUndefined();
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Certificates: [
        {
          CertificateArn:
            'arn:aws:acm:eu-west-2:755905325223:certificate/dba9f811-56bd-4168-8618-0523efa1a118',
        },
      ],
    });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: { 'Fn::Join': ['', Match.arrayWith([{ Ref: 'ApiImageTag' }])] },
        }),
      ]),
    });
    expect(stacks.api.dependencies).toContain(stacks.auth);
    expect(stacks.api.dependencies.map((stack) => stack.stackName)).not.toContain(
      'VambericDevApiCertificate',
    );
  });

  test('dev image parameter has no default and permits only immutable hexadecimal tags', () => {
    const template = Template.fromStack(createStacks().api).toJSON();
    const parameter = template.Parameters.ApiImageTag;
    expect(parameter.Type).toBe('String');
    expect(parameter).not.toHaveProperty('Default');
    const pattern = new RegExp('^(?:' + parameter.AllowedPattern + ')$');
    expect(pattern.test('a830200')).toBe(true);
    expect(pattern.test('a'.repeat(40))).toBe(true);
    for (const invalid of ['latest', '', 'abc', 'a'.repeat(41), 'release', 'abc1234:tag']) {
      expect(pattern.test(invalid)).toBe(false);
    }
    const task = Object.values(template.Resources).find(
      (resource) => (resource as { Type: string }).Type === 'AWS::ECS::TaskDefinition',
    ) as { Properties: { ContainerDefinitions: Array<{ Image?: unknown }> } };
    delete task.Properties.ContainerDefinitions[0].Image;
    delete template.Parameters.ApiImageTag;
    expect(JSON.stringify(template)).not.toContain('ApiImageTag');
  });

  test('admin-only email users with optional TOTP and a public code-flow client', () => {
    const template = Template.fromStack(createStacks().auth);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      UserPoolTier: 'ESSENTIALS',
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          TemporaryPasswordValidityDays: 3,
        },
      },
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
      CallbackURLs: ['https://app.vamberic.com/', 'http://localhost:5173/'],
      LogoutURLs: ['https://app.vamberic.com/', 'http://localhost:5173/'],
      EnableTokenRevocation: true,
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    template.hasResourceProperties('AWS::Cognito::ManagedLoginBranding', {
      UseCognitoProvidedValues: true,
    });
    template.resourceCountIs('AWS::Cognito::UserPoolUser', 0);
    for (const name of [
      'CognitoUserPoolId',
      'CognitoClientId',
      'CognitoRegion',
      'CognitoDomain',
      'CognitoIssuer',
    ]) {
      template.hasOutput(name, {});
    }
  });

  test('upgrades the single API to TLS while preserving target group and runtime secrets', () => {
    const stacks = createStacks();
    const template = Template.fromStack(stacks.api);
    template.resourceCountIs('AWS::ECS::Service', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    expect(Object.keys(template.findResources('AWS::ECS::Service'))).toEqual([
      'ApiServiceC9037CF0',
    ]);
    expect(
      Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer')),
    ).toEqual(['ApiLoadBalancer779470C6']);
    expect(Object.keys(template.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))).toEqual(
      ['ApiLoadBalancerHttpListenerApiTargetsGroup70E80398'],
    );
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.arrayWith([Match.objectLike({ CertificateArn: Match.anyValue() })]),
      DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'forward' })]),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [
        {
          Type: 'redirect',
          RedirectConfig: {
            Protocol: 'HTTPS',
            Port: '443',
            StatusCode: 'HTTP_301',
          },
        },
      ],
    });
    const task = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
    const env = task.Properties.ContainerDefinitions[0].Environment;
    expect(env).toEqual(
      expect.arrayContaining([
        { Name: 'AWS_REGION', Value: 'eu-west-2' },
        { Name: 'COGNITO_USER_POOL_ID', Value: expect.any(Object) },
        { Name: 'COGNITO_CLIENT_ID', Value: expect.any(Object) },
        { Name: 'CORS_ORIGINS', Value: 'https://app.vamberic.com,http://localhost:5173' },
        { Name: 'PUBLIC_ENQUIRY_CORS_ORIGINS', Value: 'https://h-v-m.agency' },
      ]),
    );
    expect(
      env.find((entry: { Name: string }) => entry.Name === 'CORS_ORIGINS').Value,
    ).not.toContain('*');
    Template.fromStack(stacks.security).hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }),
      ]),
    });
    expect(stacks.api.dependencies).toContain(stacks.auth);
    expect(stacks.api.dependencies).toContain(stacks.certificate);
    const certificate = Template.fromStack(stacks.certificate!);
    certificate.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'api.vamberic.com',
      ValidationMethod: 'DNS',
    });
    certificate.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  test('supports an existing London certificate and rejects the CloudFront certificate for ALB', () => {
    const existingArn = 'arn:aws:acm:eu-west-2:755905325223:certificate/existing';
    const stacks = createStacks(existingArn);
    const template = Template.fromStack(stacks.api);
    expect(stacks.certificate).toBeUndefined();
    expect(stacks.app.node.tryFindChild('VambericDevApiCertificate')).toBeUndefined();
    expect(stacks.api.dependencies.map((stack) => stack.stackName)).not.toContain(
      'VambericDevApiCertificate',
    );
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Certificates: [{ CertificateArn: existingArn }],
    });
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    expect(() => createStacks(websiteConfig.certificateArn)).toThrow(/eu-west-2/);
  });

  test('hosts Vapp privately using OAC and leaves the complete public website template unchanged', () => {
    const app = new cdk.App({ context: { 'aws:cdk:enable-path-metadata': true } });
    const vapp = new VappStack(app, getEnvironmentConfig('dev'));
    const website = new WebsiteStack(app, websiteConfig);
    const template = Template.fromStack(vapp);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      WebsiteConfiguration: Match.absent(),
    });
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      },
    });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['app.vamberic.com'],
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: { Compress: true, ViewerProtocolPolicy: 'redirect-to-https' },
        Origins: Match.arrayWith([Match.objectLike({ OriginAccessControlId: Match.anyValue() })]),
        ViewerCertificate: { AcmCertificateArn: websiteConfig.certificateArn },
        CustomErrorResponses: [403, 404].map((code) => ({
          ErrorCode: code,
          ResponseCode: 200,
          ResponsePagePath: '/index.html',
          ErrorCachingMinTTL: 0,
        })),
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
          Match.objectLike({
            Effect: 'Allow',
            Principal: { Service: 'cloudfront.amazonaws.com' },
            Action: 's3:GetObject',
            Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::IAM::Role', 1);
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    for (const output of ['VappBucketName', 'VappDistributionId', 'VappDistributionDomainName']) {
      template.hasOutput(output, {});
    }
    const actual = Template.fromStack(website).toJSON();
    // CLI adds metadata/bootstrap rules; compare every production resource and output.
    const withoutMetadata = (resources: Record<string, { Type: string }>) =>
      Object.fromEntries(
        Object.entries(resources).filter(([, resource]) => resource.Type !== 'AWS::CDK::Metadata'),
      );
    expect(withoutMetadata(actual.Resources)).toEqual(
      withoutMetadata(productionWebsiteBaseline.Resources),
    );
    expect(actual.Outputs).toEqual(productionWebsiteBaseline.Outputs);
  });

  test('asset deployment role trusts only the immutable platform repository vapp subject', () => {
    const stack = new VappStack(new cdk.App(), getEnvironmentConfig('dev'));
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    template.resourceCountIs('AWS::IAM::Role', 1);
    const role = Object.values(template.findResources('AWS::IAM::Role'))[0];
    const statements = role.Properties.AssumeRolePolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Condition).toEqual({
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub':
          'repo:auriqa-dev@209590030/vamberic-platform-api@1362482756:environment:vapp',
      },
    });
    expect(JSON.stringify(statements[0].Principal.Federated)).toContain(
      ':oidc-provider/token.actions.githubusercontent.com',
    );
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:auriqa-dev@209590030/vamberic-platform-api@1362482756:environment:vapp',
              },
            },
          }),
        ]),
      },
    });
    for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
      for (const statement of policy.Properties.PolicyDocument.Statement) {
        expect(statement.Resource).not.toEqual('*');
        expect(statement.Action).not.toContain('s3:*');
      }
    }
    template.hasOutput('VappDeploymentRoleArn', {});
  });
});

describe('dev enquiry email notifications', () => {
  test('enables HVM mail and grants only diagnostic SendEmail on the application task role', () => {
    const template = Template.fromStack(createStacks().api);
    const task = Object.values(template.findResources('AWS::ECS::TaskDefinition'))[0];
    const env = Object.fromEntries(
      task.Properties.ContainerDefinitions[0].Environment.map(
        (entry: { Name: string; Value: unknown }) => [entry.Name, entry.Value],
      ),
    );
    expect(env.NOTIFICATION_EMAIL_ENABLED).toBe('true');
    expect(env.NOTIFICATION_EMAIL_FROM).toBe('notifications@vamberic.com');
    expect(JSON.parse(env.PRODUCT_ENQUIRY_NOTIFICATION_RECIPIENTS_JSON as string)).toEqual({
      product_01m2wffbf3p9p19d3nd1s2fp3x: ['notifications@vamberic.com'],
    });
    const roles = template.findResources('AWS::IAM::Role');
    const applicationRole = Object.keys(roles).find(
      (id) => roles[id].Properties.RoleName === 'vamberic-dev-api-task',
    )!;
    const executionRole = Object.keys(roles).find(
      (id) => roles[id].Properties.RoleName === 'vamberic-dev-api-execution',
    )!;
    expect(task.Properties.TaskRoleArn).toEqual({ 'Fn::GetAtt': [applicationRole, 'Arn'] });
    expect(task.Properties.ExecutionRoleArn).toEqual({ 'Fn::GetAtt': [executionRole, 'Arn'] });
    expect(roles[applicationRole].Properties.ManagedPolicyArns).toBeUndefined();
    const sesPolicies = Object.values(template.findResources('AWS::IAM::Policy')).filter((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes('ses:'),
    );
    expect(sesPolicies).toHaveLength(1);
    expect(sesPolicies[0].Properties.Roles).toEqual([{ Ref: applicationRole }]);
    expect(sesPolicies[0].Properties.Roles).not.toContainEqual({ Ref: executionRole });
    const statements = sesPolicies[0].Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toEqual({
      Effect: 'Allow',
      Action: 'ses:SendEmail',
      Resource: '*',
    });
    expect(statements[0]).not.toHaveProperty('Condition');
    expect(JSON.stringify(statements)).not.toContain('ses:SendRawEmail');
    expect(JSON.stringify(statements)).not.toContain('ses:*');
    expect(roles[executionRole].Properties.Policies).toBeUndefined();
    expect(roles[executionRole].Properties.ManagedPolicyArns).toEqual([
      {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
          ],
        ],
      },
    ]);
  });

  test('production does not enable enquiry email notifications', () => {
    expect(getEnvironmentConfig('prod').enquiryEmailNotifications).toBeUndefined();
  });
});
