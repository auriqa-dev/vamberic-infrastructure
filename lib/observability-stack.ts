import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';

export class ObservabilityStack extends cdk.Stack {
  public readonly apiLogGroup: logs.LogGroup;

  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'Observability'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} observability resources`,
    });

    this.apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/vamberic/${config.name}/api`,
      retention: retentionDays(config.logRetentionDays),
      removalPolicy: config.name === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'ApiLogGroupName', {
      value: this.apiLogGroup.logGroupName,
    });
  }
}

function retentionDays(days: number): logs.RetentionDays {
  const supported = Object.values(logs.RetentionDays) as number[];
  if (!supported.includes(days)) {
    throw new Error(`Unsupported CloudWatch retention period: ${days} days`);
  }
  return days as logs.RetentionDays;
}
