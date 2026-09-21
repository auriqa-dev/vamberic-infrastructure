import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  public constructor(
    scope: Construct,
    config: EnvironmentConfig,
    network: NetworkStack,
    security: SecurityStack,
    observability: ObservabilityStack,
    registry: RegistryStack,
    imageTag: string,
    auth?: AuthStack,
    apiCertificate?: acm.ICertificate | string,
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

    const cluster = new ecs.Cluster(this, 'ApiCluster', {
      clusterName: `vamberic-${config.name}-api`,
      vpc: network.vpc,
      containerInsightsV2:
        config.name === 'prod' ? ecs.ContainerInsights.ENABLED : ecs.ContainerInsights.DISABLED,
    });

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

    const notifications = config.enquiryEmailNotifications;
    if (notifications) {
      taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: notifications.senderIdentities.map((identity) =>
            this.formatArn({
              service: 'ses',
              resource: 'identity',
              resourceName: identity,
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ),
        }),
      );
    }

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `vamberic-${config.name}-api`,
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      executionRole,
      taskRole,
    });

    const taskExecutionRole = taskDefinition.executionRole;
    if (!taskExecutionRole) {
      throw new Error('The API task definition must have an execution role.');
    }
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

    taskDefinition.addContainer('ApiContainer', {
      image: ecs.ContainerImage.fromEcrRepository(registry.apiRepository, imageTag),
      containerName: 'api',
      logging: ecs.LogDrivers.awsLogs({
        logGroup: observability.apiLogGroup,
        streamPrefix: 'ecs',
      }),
      portMappings: [{ containerPort: config.containerPort, protocol: ecs.Protocol.TCP }],
      environment: {
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
