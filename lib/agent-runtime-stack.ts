import type { PsuDeploymentInput } from './psu-deployment-input';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type { Construct } from 'constructs';
import { stackName, type EnvironmentConfig } from '../config/environment';
import type { NetworkStack } from './network-stack';
import type { AgentRuntimeFoundationStack } from './agent-runtime-foundation-stack';
export class AgentRuntimeStack extends cdk.Stack {
  constructor(
    scope: Construct,
    config: EnvironmentConfig,
    network: NetworkStack,
    cluster: ecs.ICluster,
    foundation: AgentRuntimeFoundationStack,
    platformOrigin: string,
    psu?: PsuDeploymentInput,
  ) {
    super(scope, stackName(config, 'AgentRuntime'), {
      env: { account: config.account, region: config.region },
    });
    const imageDigest =
      psu?.imageDigest ??
      new cdk.CfnParameter(this, 'WorkerImageDigest', {
        type: 'String',
        allowedPattern: 'sha256:[a-f0-9]{64}',
        description: 'Reviewed immutable worker image digest. No latest fallback.',
      }).valueAsString;
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    foundation.repository.grantPull(executionRole);
    foundation.logGroup.grantWrite(executionRole);
    // Bootstrap secret is fetched by the worker task, not injected into a shared task definition.
    foundation.secret.grantRead(taskRole);
    if (psu)
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [psu.providerSecretArn],
        }),
      );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
        resources: [foundation.queue.queueArn],
      }),
    );
    const group = new ec2.SecurityGroup(this, 'WorkerSecurityGroup', {
      vpc: network.vpc,
      allowAllOutbound: false,
    });
    group.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS Platform, Cognito and AWS APIs',
    );
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      family: `vamberic-${config.name}-agent-runtime`,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole,
      executionRole,
    });
    task.addContainer('Worker', {
      containerName: 'worker',
      image: ecs.ContainerImage.fromRegistry(
        `${foundation.repository.repositoryUri}@${imageDigest}`,
      ),
      logging: ecs.LogDrivers.awsLogs({ logGroup: foundation.logGroup, streamPrefix: 'ecs' }),
      readonlyRootFilesystem: true,
      user: '1000:1000',
      stopTimeout: cdk.Duration.seconds(60),
      environment: {
        ...psu?.workerEnvironment,
        NODE_ENV: 'production',
        DEPLOYMENT_ENV: config.name,
        AWS_REGION: config.region,
        AGENT_QUEUE_URL: foundation.queue.queueUrl,
        AGENT_PLATFORM_ORIGIN: platformOrigin,
        AGENT_WORKLOAD_CLIENT_ID: foundation.client.userPoolClientId,
        AGENT_TOKEN_ENDPOINT: foundation.tokenEndpoint,
        AGENT_WORKLOAD_SECRET_ARN: foundation.secret.secretArn,
      },
    });
    new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: task,
      serviceName: `vamberic-${config.name}-agent-runtime`,
      desiredCount: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [group],
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    new cloudwatch.Alarm(this, 'DeadLetters', {
      metric: foundation.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
    });
    new cloudwatch.Alarm(this, 'QueueAge', {
      metric: foundation.queue.metricApproximateAgeOfOldestMessage(),
      threshold: 300,
      evaluationPeriods: 2,
    });
  }
}
