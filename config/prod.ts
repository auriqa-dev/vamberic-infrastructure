import type { EnvironmentConfig } from './environment.js';

export const prodConfig: EnvironmentConfig = {
  name: 'prod',
  nodeEnvironment: 'production',
  deploymentEnvironment: 'prod',
  region: 'eu-west-2',
  maxAzs: 2,
  natGateways: 2,
  desiredCount: 2,
  cpu: 512,
  memoryMiB: 1024,
  containerPort: 3000,
  logRetentionDays: 30,
  healthCheckPath: '/health',
  repositoryRetainedImageCount: 50,
};
