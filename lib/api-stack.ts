import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';
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
  ) {
    super(scope, stackName(config, 'Api'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} ECS API runtime`,
    });

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

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      family: `vamberic-${config.name}-api`,
      cpu: config.cpu,
      memoryLimitMiB: config.memoryMiB,
      executionRole,
      taskRole,
    });

    taskDefinition.addContainer('ApiContainer', {
      image: ecs.ContainerImage.fromEcrRepository(registry.apiRepository, imageTag),
      containerName: 'api',
      logging: ecs.LogDrivers.awsLogs({
        logGroup: observability.apiLogGroup,
        streamPrefix: 'ecs',
      }),
      portMappings: [{ containerPort: config.containerPort, protocol: ecs.Protocol.TCP }],
      secrets: {
        API_RUNTIME_CONFIG: ecs.Secret.fromSecretsManager(security.apiRuntimeSecret),
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
    });
    listener.addTargets('ApiTargets', {
      port: config.containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: config.healthCheckPath,
        healthyHttpCodes: '200-399',
        interval: cdk.Duration.seconds(30),
      },
    });

    new cdk.CfnOutput(this, 'ApiLoadBalancerDnsName', {
      value: loadBalancer.loadBalancerDnsName,
    });
  }
}
