#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getEnvironmentConfig, resolveApiImageTag } from '../config/environment';
import { websiteConfig } from '../config/website';
import { AuthStack } from '../lib/auth-stack';
import { ApiCertificateStack } from '../lib/api-certificate-stack';
import { VappStack } from '../lib/vapp-stack';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';
import { WebsiteStack } from '../lib/website-stack';

const app = new cdk.App();
const environmentName = process.env.DEPLOY_ENV ?? app.node.tryGetContext('environment');
const baseConfig = getEnvironmentConfig(environmentName);
const config = {
  ...baseConfig,
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? baseConfig.region,
};
const imageTag = resolveApiImageTag(
  config,
  process.env.API_IMAGE_TAG ?? app.node.tryGetContext('imageTag'),
);

const network = new NetworkStack(app, config);
const security = new SecurityStack(app, config, network);
const observability = new ObservabilityStack(app, config);
const registry = new RegistryStack(app, config);
// The app/api public hostnames belong to dev initially; do not claim them in prod.
const auth = config.name === 'dev' ? new AuthStack(app, config) : undefined;
const apiCertificate =
  config.name === 'dev'
    ? ((app.node.tryGetContext('apiCertificateArn') as string | undefined) ??
      new ApiCertificateStack(app, config).certificate)
    : undefined;
if (config.name === 'dev') new VappStack(app, config);
const api = new ApiStack(
  app,
  config,
  network,
  security,
  observability,
  registry,
  imageTag,
  auth,
  apiCertificate,
);
new WebsiteStack(app, {
  ...websiteConfig,
  account: process.env.CDK_DEFAULT_ACCOUNT,
});

security.addStackDependency(network);
api.addStackDependency(network);
api.addStackDependency(security);
api.addStackDependency(observability);
api.addStackDependency(registry);
