import type { EnvironmentConfig } from './environment.js';

export const devConfig: EnvironmentConfig = {
  name: 'dev',
  nodeEnvironment: 'production',
  deploymentEnvironment: 'dev',
  region: 'eu-west-2',
  maxAzs: 2,
  natGateways: 1,
  desiredCount: 1,
  cpu: 256,
  memoryMiB: 512,
  containerPort: 3000,
  logRetentionDays: 7,
  healthCheckPath: '/health',
  repositoryRetainedImageCount: 20,
  apiImageTag: '033dd7d',
};
