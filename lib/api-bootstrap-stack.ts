import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';

export class ApiBootstrapStack extends cdk.Stack {
  public constructor(scope: Construct, config: EnvironmentConfig) {
    const bootstrap = bootstrapConfiguration(config);
    super(scope, stackName(config, 'ApiBootstrap'), {
      env: bootstrap.environment,
      description: 'Bootstrap secret access for the Vamberic dev API execution role',
    });

    const executionRole = iam.Role.fromRoleName(
      this,
      'ApiExecutionRole',
      `vamberic-${config.name}-api-execution`,
    );
    const apiSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'ApiRuntimeSecret',
      bootstrap.secretArn,
    );

    apiSecret.grantRead(executionRole).assertSuccess();
  }
}

function bootstrapConfiguration(config: EnvironmentConfig): {
  readonly environment: cdk.Environment;
  readonly secretArn: string;
} {
  if (config.name !== 'dev') {
    throw new Error('The API bootstrap stack is only supported for development.');
  }
  if (!config.apiRuntimeSecretCompleteArn) {
    throw new Error('The API bootstrap stack requires the complete runtime secret ARN.');
  }

  const [prefix, , service, region, account] = config.apiRuntimeSecretCompleteArn.split(':');
  if (
    prefix !== 'arn' ||
    service !== 'secretsmanager' ||
    region !== config.region ||
    !/^\d{12}$/.test(account)
  ) {
    throw new Error('The API bootstrap secret ARN must identify the configured AWS environment.');
  }

  return {
    environment: { account, region },
    secretArn: config.apiRuntimeSecretCompleteArn,
  };
}
