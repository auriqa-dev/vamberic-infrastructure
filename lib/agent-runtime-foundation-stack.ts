import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { stackName, type EnvironmentConfig } from '../config/environment';
import type { AuthStack } from './auth-stack';

/** Explicit opt-in foundation. No human-client mutation or worker activation. */
export class AgentRuntimeFoundationStack extends cdk.Stack {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly repository: ecr.Repository;
  readonly logGroup: logs.LogGroup;
  readonly client: cognito.UserPoolClient;
  readonly secret: secretsmanager.Secret;
  readonly resourceServer: string;
  readonly issuer: string;
  readonly tokenEndpoint: string;
  constructor(scope: Construct, config: EnvironmentConfig, auth: AuthStack) {
    super(scope, stackName(config, 'AgentRuntimeFoundation'), {
      env: { account: config.account, region: config.region },
    });
    this.resourceServer = `vamberic-${config.name}-agent-runtime`;
    this.issuer = `https://cognito-idp.${config.region}.amazonaws.com/${auth.userPool.userPoolId}`;
    this.tokenEndpoint = `https://vamberic-${config.name}-vapp-${this.account}.auth.${config.region}.amazoncognito.com/oauth2/token`;
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${this.resourceServer}-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: this.resourceServer,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const cfnDlq = this.deadLetterQueue.node.defaultChild as sqs.CfnQueue;
    cfnDlq.redriveAllowPolicy = {
      redrivePermission: 'byQueue',
      sourceQueueArns: [this.formatArn({ service: 'sqs', resource: this.resourceServer })],
    };
    const scopes = [
      'claim',
      'heartbeat',
      'context',
      'outcome',
      'receipt',
      'usage',
      'capacity',
      'execution_evidence',
    ].map(
      (name) =>
        new cognito.ResourceServerScope({
          scopeName: name,
          scopeDescription: `Agent workload ${name}`,
        }),
    );
    const server = new cognito.UserPoolResourceServer(this, 'ResourceServer', {
      userPool: auth.userPool,
      identifier: this.resourceServer,
      scopes,
    });
    this.client = new cognito.UserPoolClient(this, 'MachineClient', {
      userPool: auth.userPool,
      userPoolClientName: this.resourceServer,
      generateSecret: true,
      accessTokenValidity: cdk.Duration.minutes(5),
      oAuth: {
        flows: { clientCredentials: true },
        scopes: scopes.map((s) => cognito.OAuthScope.resourceServer(server, s)),
      },
      authFlows: { userSrp: false, userPassword: false, adminUserPassword: false, custom: false },
      preventUserExistenceErrors: true,
    });
    this.secret = new secretsmanager.Secret(this, 'MachineSecret', {
      secretName: `vamberic/${config.name}/agent-runtime-m2m`,
      secretObjectValue: {
        clientId: cdk.SecretValue.unsafePlainText(this.client.userPoolClientId),
        clientSecret: this.client.userPoolClientSecret,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: this.resourceServer,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Do not expire tagged images that may be pinned by paused Runs.
    });
    this.logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/vamberic/${config.name}/agent-runtime`,
      retention: config.logRetentionDays,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cdk.CfnOutput(this, 'RepositoryUri', { value: this.repository.repositoryUri });
    new cdk.CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    // Client secret is deliberately absent from outputs.
  }
}
