import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { NetworkStack } from '../lib/network-stack';
import { AuthStack } from '../lib/auth-stack';
import { AgentRuntimeFoundationStack } from '../lib/agent-runtime-foundation-stack';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import * as ecs from 'aws-cdk-lib/aws-ecs';
function stacks() {
  const app = new cdk.App();
  const config = getEnvironmentConfig('dev');
  const network = new NetworkStack(app, config);
  const auth = new AuthStack(app, config);
  const foundation = new AgentRuntimeFoundationStack(app, config, auth);
  const host = new cdk.Stack(app, 'Host', {
    env: { account: config.account, region: config.region },
  });
  const cluster = new ecs.Cluster(host, 'Cluster', { vpc: network.vpc });
  const worker = new AgentRuntimeStack(
    app,
    config,
    network,
    cluster,
    foundation,
    'https://api.example.com',
  );
  return { app, foundation, worker, auth };
}
test('encrypted Standard queue and restricted DLQ retain state', () => {
  const { foundation } = stacks();
  const template = Template.fromStack(foundation);
  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'vamberic-dev-agent-runtime',
    SqsManagedSseEnabled: true,
    VisibilityTimeout: 120,
    ReceiveMessageWaitTimeSeconds: 20,
    RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
  });
  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'vamberic-dev-agent-runtime-dlq',
    MessageRetentionPeriod: 1209600,
    RedriveAllowPolicy: Match.objectLike({ redrivePermission: 'byQueue' }),
  });
  template.hasResourceProperties('AWS::SQS::QueuePolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
      ]),
    }),
  });
});
test('machine client is confidential and separated from browser client, secret never output', () => {
  const { foundation, auth } = stacks();
  const template = Template.fromStack(foundation);
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: true,
    AllowedOAuthFlows: ['client_credentials'],
    AccessTokenValidity: 5,
    AllowedOAuthScopes: Match.arrayWith([
      { 'Fn::Join': ['', [{ Ref: Match.anyValue() }, '/claim']] },
    ]),
  });
  Template.fromStack(auth).hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
    AllowedOAuthFlows: ['code'],
  });
  expect(JSON.stringify(template.toJSON().Outputs)).not.toMatch(/ClientSecret|SecretString/);
});
test('inactive private worker has no Mongo/API secret, no ingress and no ALB', () => {
  const { app, worker } = stacks();
  const template = Template.fromStack(worker);
  template.hasResourceProperties('AWS::ECS::Service', {
    DesiredCount: 0,
    NetworkConfiguration: { AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: 'DISABLED' }) },
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        ReadonlyRootFilesystem: true,
        User: '1000:1000',
        StopTimeout: 60,
        Secrets: Match.absent(),
        PortMappings: Match.absent(),
      }),
    ]),
  });
  template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  const text = JSON.stringify(template.toJSON());
  expect(text).not.toMatch(/MONGODB_URI|vamberic\/dev\/api|ses:|AdministratorAccess/);
  expect(text).toContain('sqs:ReceiveMessage');
  expect(text).not.toContain('sqs:SendMessage');
  expect(text).toContain('secretsmanager:GetSecretValue');
  expect(() => app.synth()).not.toThrow();
});
