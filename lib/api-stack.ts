import { psuAppInput } from './psu-app-input';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { PsuDeploymentInput } from './psu-deployment-input';
import type { AgentRuntimeFoundationStack } from './agent-runtime-foundation-stack';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';
import { vappConfig } from '../config/vapp';
import type { AuthStack } from './auth-stack';
import type { NetworkStack } from './network-stack';
import type { ObservabilityStack } from './observability-stack';
import type { RegistryStack } from './registry-stack';
import type { SecurityStack } from './security-stack';

export class ApiStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public constructor(
    scope: Construct,
    config: EnvironmentConfig,
    network: NetworkStack,
    security: SecurityStack,
    observability: ObservabilityStack,
    registry: RegistryStack,
    imageTag: string | undefined,
    auth?: AuthStack,
    apiCertificate?: acm.ICertificate | string,
    agentRuntime?: AgentRuntimeFoundationStack,
    psu?: PsuDeploymentInput,
  ) {
    super(scope, stackName(config, 'Api'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} ECS API runtime`,
    });

    if (
      typeof apiCertificate === 'string' &&
      !/^arn:aws:acm:eu-west-2:\d{12}:certificate\/.+$/.test(apiCertificate)
    ) {
      throw new Error('apiCertificateArn must be an ACM certificate ARN in eu-west-2.');
    }
    const certificate =
      typeof apiCertificate === 'string'
        ? acm.Certificate.fromCertificateArn(this, 'ExistingApiCertificate', apiCertificate)
        : apiCertificate;
    if (config.name === 'dev' && config.region !== 'eu-west-2') {
      throw new Error('Vapp API HTTPS must be deployed in eu-west-2.');
    }
    if (config.name === 'dev' && (!auth || !certificate)) {
      throw new Error('Dev API requires Vapp authentication and a regional TLS certificate.');
    }

    const deployedImageTag =
      config.name === 'dev'
        ? new cdk.CfnParameter(this, 'ApiImageTag', {
            type: 'String',
            allowedPattern: '[a-f0-9]{7,40}',
            description:
              'Immutable application image tag; retained across infrastructure deployments',
            constraintDescription:
              'Use an immutable hexadecimal commit tag (7–40 characters), never latest.',
          }).valueAsString
        : imageTag;
    if (!deployedImageTag) throw new Error('Production API requires an explicit image tag.');

    const cluster = new ecs.Cluster(this, 'ApiCluster', {
      clusterName: `vamberic-${config.name}-api`,
      vpc: network.vpc,
      containerInsightsV2:
        config.name === 'prod' ? ecs.ContainerInsights.ENABLED : ecs.ContainerInsights.DISABLED,
    });

    this.cluster = cluster;

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `vamberic-${config.name}-api-execution`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskRole = new iam.Role(this, 'ApplicationTaskRole', {
      roleName: `vamberic-${config.name}-api-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Application permissions start empty and are granted per feature',
    });

    if (agentRuntime)
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sqs:SendMessage'],
          resources: [agentRuntime.queue.queueArn],
        }),
      );

    if (agentRuntime) {
      // Observation only: workload reports never establish their own deployment identity.
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DescribeServices'],
          resources: [
            this.formatArn({
              service: 'ecs',
              resource: 'service',
              resourceName: `vamberic-${config.name}-api/vamberic-${config.name}-agent-runtime`,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      );
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ecs:DescribeTasks'],
          resources: [
            this.formatArn({
              service: 'ecs',
              resource: 'task',
              resourceName: `vamberic-${config.name}-api/*`,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      );
    }

    const notifications = config.enquiryEmailNotifications;
    if (notifications) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          // TEMPORARY DIAGNOSTIC: isolate SES resource-level authorization failures.
          // Restore identity ARN scoping from notifications.senderIdentities after diagnosis.
          resources: ['*'],
        }),
      );
    }

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `vamberic-${config.name}-api`,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
      },
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      executionRole,
      taskRole,
    });

    const taskExecutionRole = taskDefinition.executionRole;
    if (!taskExecutionRole) {
      throw new Error('The API task definition must have an execution role.');
    }
    const appPsu = psuAppInput(this.node.tryGetContext('psuApp'), config.account, config.region);
    const psuSecret = appPsu ? secretsmanager.Secret.fromSecretCompleteArn(this, 'PsuAppProviderKey', appPsu.secretArn) : undefined;
    psuSecret?.grantRead(taskExecutionRole);
    const secretReadGrant = security.apiRuntimeSecret.grantRead(taskExecutionRole);
    const cfnTaskDefinition = taskDefinition.node.defaultChild;
    if (!(cfnTaskDefinition instanceof ecs.CfnTaskDefinition)) {
      throw new Error('The API task definition must synthesize an ECS task definition resource.');
    }
    secretReadGrant.assertSuccess();
    const taskExecutionPolicy = taskExecutionRole.node.tryFindChild('DefaultPolicy');
    if (!(taskExecutionPolicy instanceof iam.Policy)) {
      throw new Error('The API task execution role must synthesize a default policy.');
    }
    cfnTaskDefinition.node.addDependency(taskExecutionPolicy);

    const empressSubjects = config.hvmAuth?.empressSubjects ?? [];
    if (
      empressSubjects.length > 20 ||
      empressSubjects.some(
        (subject) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(subject),
      )
    ) {
      throw new Error('HVM Empress subjects must be at most 20 Cognito UUIDs');
    }
    const brandImages = this.node.tryGetContext('brandImagesEnabled') === true
      ? new s3.Bucket(this, 'BrandImages', {
          bucketName: `vamberic-${config.name}-brand-images-${config.account}`,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          versioned: true,
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        })
      : undefined;
    if (brandImages) taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject', 's3:GetObjectVersion'],
      resources: [brandImages.arnForObjects('brand-images/*')],
    }));
    taskDefinition.addContainer('ApiContainer', {
      image: ecs.ContainerImage.fromEcrRepository(registry.apiRepository, deployedImageTag),
      containerName: 'api',
      logging: ecs.LogDrivers.awsLogs({
        logGroup: observability.apiLogGroup,
        streamPrefix: 'ecs',
      }),
      portMappings: [{ containerPort: config.containerPort, protocol: ecs.Protocol.TCP }],
      environment: {
        ...(appPsu ? { HVM_PSU_OPENAI_PROJECT: appPsu.projectId, HVM_PSU_MODEL: appPsu.model } : psu?.apiEnvironment),
        ...(brandImages ? { BRAND_IMAGES_BUCKET: brandImages.bucketName } : {}),
        AGENT_DISPATCH_ENABLED: 'false',
        ...(agentRuntime
          ? {
              AGENT_WORKLOAD_ISSUER: agentRuntime.issuer,
              AGENT_WORKLOAD_CLIENT_ID: agentRuntime.client.userPoolClientId,
              AGENT_WORKLOAD_RESOURCE_SERVER: agentRuntime.resourceServer,
              AGENT_QUEUE_URL: agentRuntime.queue.queueUrl,
            }
          : {}),
        ...(config.hvmAuth
          ? {
              HVM_AUTH_ENABLED: 'true',
              HVM_EMPRESS_SUBJECTS: empressSubjects.join(','),
              HVM_COGNITO_CLIENT_ID: config.hvmAuth.clientId,
              HVM_CORS_ORIGINS: config.hvmAuth.corsOrigins.join(','),
            }
          : {}),
        NODE_ENV: config.nodeEnvironment,
        DEPLOYMENT_ENV: config.deploymentEnvironment,
        ...(notifications
          ? {
              NOTIFICATION_EMAIL_ENABLED: 'true',
              NOTIFICATION_EMAIL_FROM: notifications.from,
              PRODUCT_ENQUIRY_NOTIFICATION_RECIPIENTS_JSON: JSON.stringify(
                notifications.recipientsByProduct,
              ),
            }
          : {}),
        ...(config.publicEnquiryCorsOrigins
          ? { PUBLIC_ENQUIRY_CORS_ORIGINS: config.publicEnquiryCorsOrigins.join(',') }
          : {}),
        ...(auth
          ? {
              AWS_REGION: this.region,
              COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
              COGNITO_CLIENT_ID: auth.client.userPoolClientId,
              CORS_ORIGINS: vappConfig.corsOrigins.join(','),
            }
          : {}),
      },
      secrets: {
        MONGODB_URI: ecs.Secret.fromSecretsManager(security.apiRuntimeSecret, 'MONGODB_URI'),
        ...(psuSecret ? { HVM_PSU_API_KEY: ecs.Secret.fromSecretsManager(psuSecret, 'OPENAI_API_KEY') } : {}),
      },
      healthCheck: {
        command: [
          'CMD',
          'node',
          '-e',
          `fetch('http://127.0.0.1:${config.containerPort}${config.healthCheckPath}').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    const service = new ecs.FargateService(this, 'ApiService', {
      serviceName: `vamberic-${config.name}-api`,
      cluster,
      taskDefinition,
      desiredCount: config.desiredCount,
      securityGroups: [security.serviceSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      circuitBreaker: { rollback: true },
      enableECSManagedTags: true,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApiLoadBalancer', {
      loadBalancerName: `vamberic-${config.name}-api`,
      vpc: network.vpc,
      internetFacing: true,
      securityGroup: security.loadBalancerSecurityGroup,
    });
    const listener = loadBalancer.addListener('HttpListener', {
      port: 80,
      open: false,
      ...(certificate
        ? {
            defaultAction: elbv2.ListenerAction.redirect({
              protocol: 'HTTPS',
              port: '443',
              permanent: true,
            }),
          }
        : {}),
    });
    // Preserve the existing target group's construct path/logical ID.
    const targetGroup = new elbv2.ApplicationTargetGroup(listener, 'ApiTargetsGroup', {
      vpc: network.vpc,
      port: config.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: config.healthCheckPath,
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(30),
      },
    });

    if (certificate) {
      loadBalancer.addListener('HttpsListener', {
        port: 443,
        open: false,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
      });
      new cdk.CfnOutput(this, 'ApiDomainName', { value: vappConfig.apiDomainName });
      new cdk.CfnOutput(this, 'ApiBaseUrl', { value: `https://${vappConfig.apiDomainName}` });
    } else {
      listener.addTargetGroups('ForwardApi', { targetGroups: [targetGroup] });
    }

    new cdk.CfnOutput(this, 'ApiLoadBalancerDnsName', {
      value: loadBalancer.loadBalancerDnsName,
    });
    new cdk.CfnOutput(this, 'ApiClusterName', {
      value: cluster.clusterName,
      description: 'ECS cluster for API services and operator-run one-off tasks',
    });
    new cdk.CfnOutput(this, 'ApiTaskDefinitionArn', {
      value: taskDefinition.taskDefinitionArn,
      description: 'API task definition to reuse with a container command override',
    });
    new cdk.CfnOutput(this, 'ApiPrivateSubnetIds', {
      value: cdk.Fn.join(
        ',',
        network.vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        }).subnetIds,
      ),
      description: 'Comma-separated private application subnet IDs for one-off Fargate tasks',
    });
    new cdk.CfnOutput(this, 'ApiTaskSecurityGroupId', {
      value: security.serviceSecurityGroup.securityGroupId,
      description: 'Security group for API services and one-off Fargate tasks',
    });
    new cdk.CfnOutput(this, 'ApiContainerName', {
      value: 'api',
      description: 'Container name to target in an ECS command override',
    });
  }
}
