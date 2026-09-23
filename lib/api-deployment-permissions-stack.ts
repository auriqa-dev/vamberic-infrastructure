import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { deploymentAccount } from '../config/deployment';

/** Adds release permissions to the existing, externally owned GitHub role. */
export class ApiDeploymentPermissionsStack extends cdk.Stack {
  public constructor(scope: Construct) {
    super(scope, 'VambericDevApiDeploymentPermissions', {
      env: { account: deploymentAccount, region: 'eu-west-2' },
      description: 'Scoped Platform API release permissions for the existing GitHub dev role',
    });
    // Preserve existing immutable OIDC trust and ECR push policy. Rollout must separately
    // detach the legacy AmazonECS_FullAccess managed policy; see docs/dev-release-pipeline.md.
    const role = iam.Role.fromRoleName(this, 'ApiDeploymentRole', 'VambericGitHubApiDeployRole');
    const stackArn = `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/VambericDevApi/*`;
    const ecsArn = `arn:${this.partition}:ecs:${this.region}:${this.account}`;
    const policy = new iam.Policy(this, 'ApiReleasePolicy', {
      policyName: 'VambericDevApiRelease',
      statements: [
        new iam.PolicyStatement({
          actions: [
            'cloudformation:DescribeStacks',
            'cloudformation:GetTemplate',
            'cloudformation:DescribeStackResource',
          ],
          resources: [stackArn],
        }),
        new iam.PolicyStatement({
          actions: [
            'cloudformation:CreateChangeSet',
            'cloudformation:DescribeChangeSet',
            'cloudformation:ExecuteChangeSet',
            'cloudformation:DeleteChangeSet',
          ],
          resources: [stackArn],
          conditions: { StringLike: { 'cloudformation:ChangeSetName': 'app-*' } },
        }),
        new iam.PolicyStatement({
          actions: ['ecs:DescribeServices'],
          resources: [`${ecsArn}:service/vamberic-dev-api/vamberic-dev-api`],
        }),
        new iam.PolicyStatement({
          actions: ['ecs:DescribeTasks'],
          resources: [`${ecsArn}:task/vamberic-dev-api/*`],
        }),
        new iam.PolicyStatement({
          actions: ['ecs:ListTasks'],
          resources: ['*'],
          conditions: { ArnEquals: { 'ecs:cluster': `${ecsArn}:cluster/vamberic-dev-api` } },
        }),
        // DescribeTaskDefinition has no resource-level IAM support.
        new iam.PolicyStatement({
          actions: ['ecs:DescribeTaskDefinition'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: ['vamberic-dev-api-task', 'vamberic-dev-api-execution'].map(
            (name) => `arn:${this.partition}:iam::${this.account}:role/${name}`,
          ),
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      ],
    });
    policy.attachToRole(role);
    new cdk.CfnOutput(this, 'ApiDeploymentRoleArn', { value: role.roleArn });
  }
}
