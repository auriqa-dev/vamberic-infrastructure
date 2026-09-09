#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { getEnvironmentConfig } from '../config/environment';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';

const app = new cdk.App();
const environmentName = process.env.DEPLOY_ENV ?? app.node.tryGetContext('environment');
const baseConfig = getEnvironmentConfig(environmentName);
const config = {
  ...baseConfig,
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? baseConfig.region,
};
const imageTag =
  process.env.API_IMAGE_TAG ?? app.node.tryGetContext('imageTag') ?? 'local-synth-only';

const network = new NetworkStack(app, config);
const security = new SecurityStack(app, config, network);
const observability = new ObservabilityStack(app, config);
const registry = new RegistryStack(app, config);
const api = new ApiStack(app, config, network, security, observability, registry, imageTag);

security.addStackDependency(network);
api.addStackDependency(network);
api.addStackDependency(security);
api.addStackDependency(observability);
api.addStackDependency(registry);
