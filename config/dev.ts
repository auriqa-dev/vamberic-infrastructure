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
  apiImageTag: '5116deb',
  publicEnquiryCorsOrigins: ['https://h-v-m.agency'],
  apiCertificateArn:
    'arn:aws:acm:eu-west-2:755905325223:certificate/dba9f811-56bd-4168-8618-0523efa1a118',
  apiRuntimeSecretName: 'vamberic/dev/api',
  apiRuntimeSecretCompleteArn:
    'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/api-vDW6XL',
};
