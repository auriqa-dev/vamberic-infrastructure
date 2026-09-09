import { devConfig } from './dev';
import { prodConfig } from './prod';

export type EnvironmentName = 'dev' | 'prod';

export interface EnvironmentConfig {
  readonly name: EnvironmentName;
  readonly nodeEnvironment: 'production';
  readonly deploymentEnvironment: EnvironmentName;
  readonly account?: string;
  readonly region: string;
  readonly maxAzs: number;
  readonly natGateways: number;
  readonly desiredCount: number;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly containerPort: number;
  readonly logRetentionDays: number;
  readonly healthCheckPath: string;
  readonly repositoryRetainedImageCount: number;
  readonly apiImageTag?: string;
}

export function resolveApiImageTag(
  config: EnvironmentConfig,
  override: string | undefined,
): string {
  const imageTag = override ?? config.apiImageTag;

  if (!imageTag) {
    throw new Error(
      `No API image tag configured for ${config.name}. Provide -c imageTag=... or API_IMAGE_TAG=...`,
    );
  }
  if (imageTag === 'latest') {
    throw new Error('The mutable "latest" image tag is not permitted.');
  }

  return imageTag;
}

export function getEnvironmentConfig(name: string | undefined): EnvironmentConfig {
  switch (name ?? 'dev') {
    case 'dev': {
      return devConfig;
    }
    case 'prod': {
      return prodConfig;
    }
    default:
      throw new Error(`Unsupported environment "${name}". Expected "dev" or "prod".`);
  }
}

export function stackName(config: EnvironmentConfig, component: string): string {
  return `Vamberic${capitalize(config.name)}${component}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
