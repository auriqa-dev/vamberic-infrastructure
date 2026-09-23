import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ApiDeploymentPermissionsStack } from '../lib/api-deployment-permissions-stack';

// Resolve only the known AWS partition in this account's synthesized ARN joins.
function resolveAws(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveAws);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.Ref === 'AWS::Partition') return 'aws';
    if (object['Fn::Join']) {
      const [separator, parts] = object['Fn::Join'] as [string, unknown[]];
      return parts.map(resolveAws).join(separator);
    }
    return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveAws(item)]));
  }
  return value;
}

test('release policy imports the existing role and grants only scoped pipeline permissions', () => {
  const stack = new ApiDeploymentPermissionsStack(new cdk.App());
  expect(stack.account).toBe('755905325223');
  expect(stack.region).toBe('eu-west-2');
  expect(stack.dependencies).toEqual([]);
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::IAM::Role', 0);
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('AWS::IAM::ManagedPolicy', 0);
  template.resourceCountIs('AWS::IAM::Policy', 1);
  const policy = Object.values(template.findResources('AWS::IAM::Policy'))[0].Properties;
  expect(policy.Roles).toEqual(['VambericGitHubApiDeployRole']);
  const stackArn = 'arn:aws:cloudformation:eu-west-2:755905325223:stack/VambericDevApi/*';
  expect(resolveAws(policy.PolicyDocument.Statement)).toEqual([
    {
      Effect: 'Allow',
      Action: [
        'cloudformation:DescribeStacks',
        'cloudformation:GetTemplate',
        'cloudformation:DescribeStackResource',
      ],
      Resource: stackArn,
    },
    {
      Effect: 'Allow',
      Action: 'cloudformation:CreateChangeSet',
      Resource: stackArn,
      Condition: { StringLike: { 'cloudformation:ChangeSetName': 'app-*' } },
    },
    {
      Effect: 'Allow',
      Action: [
        'cloudformation:DescribeChangeSet',
        'cloudformation:ExecuteChangeSet',
        'cloudformation:DeleteChangeSet',
      ],
      Resource: stackArn,
    },
    {
      Effect: 'Allow',
      Action: 'ecs:DescribeServices',
      Resource: 'arn:aws:ecs:eu-west-2:755905325223:service/vamberic-dev-api/vamberic-dev-api',
    },
    {
      Effect: 'Allow',
      Action: 'ecs:DescribeTasks',
      Resource: 'arn:aws:ecs:eu-west-2:755905325223:task/vamberic-dev-api/*',
    },
    {
      Effect: 'Allow',
      Action: 'ecs:ListTasks',
      Resource: '*',
      Condition: {
        ArnEquals: { 'ecs:cluster': 'arn:aws:ecs:eu-west-2:755905325223:cluster/vamberic-dev-api' },
      },
    },
    { Effect: 'Allow', Action: 'ecs:DescribeTaskDefinition', Resource: '*' },
    {
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: [
        'arn:aws:iam::755905325223:role/vamberic-dev-api-task',
        'arn:aws:iam::755905325223:role/vamberic-dev-api-execution',
      ],
      Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    },
  ]);
  const statements = resolveAws(policy.PolicyDocument.Statement) as Array<{
    Action: string | string[];
    Resource: string;
    Condition?: unknown;
  }>;
  for (const action of ['DescribeChangeSet', 'ExecuteChangeSet', 'DeleteChangeSet']) {
    const statement = statements.find((s) =>
      [s.Action].flat().includes('cloudformation:' + action),
    );
    expect(statement).toBeDefined();
    expect(statement!.Resource).toBe(stackArn);
    expect(statement).not.toHaveProperty('Condition');
  }
  const serialized = JSON.stringify(template.toJSON());
  for (const action of ['UpdateStack', 'DeleteStack', 'CreateStack']) {
    expect(serialized).not.toContain('cloudformation:' + action);
  }
  expect(serialized).not.toContain('AmazonECS_FullAccess');
  expect(serialized).not.toContain('AdministratorAccess');
  expect(serialized).not.toContain('ecs:UpdateService');
  expect(serialized).not.toContain('ecs:RegisterTaskDefinition');
  expect(serialized).not.toContain('ecr:'); // Existing ECR permissions are untouched.
});
