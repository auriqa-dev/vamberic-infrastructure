import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from '../config/environment';
import { stackName } from '../config/environment';

export class RegistryStack extends cdk.Stack {
  public readonly apiRepository: ecr.Repository;

  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'Registry'), {
      env: {
        account: config.account,
        region: config.region,
      },
      description: `Vamberic ${config.name} container registry`,
    });

    this.apiRepository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: `vamberic-${config.name}-api`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: config.name === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: config.name !== 'prod',
      lifecycleRules: [
        {
          description: `Retain the most recent ${config.repositoryRetainedImageCount} tagged images for rollback`,
          tagStatus: ecr.TagStatus.TAGGED,
          tagPatternList: ['*'],
          maxImageCount: config.repositoryRetainedImageCount,
          rulePriority: 1,
        },
        {
          description: 'Remove untagged images after seven days',
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(7),
          rulePriority: 2,
        },
      ],
    });

    new cdk.CfnOutput(this, 'ApiRepositoryUri', {
      value: this.apiRepository.repositoryUri,
      description: `Push the Vamberic ${config.name} API image here before deploying the API stack`,
    });
  }
}
