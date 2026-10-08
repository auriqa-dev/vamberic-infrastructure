#!/usr/bin/env node
import { loadPsuDeploymentInput } from '../lib/psu-deployment-input';
import { AgentRuntimeFoundationStack } from '../lib/agent-runtime-foundation-stack';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import { vappConfig } from '../config/vapp';
import { HvmAppStack, HvmAppCertificateStack } from '../lib/hvm-app-stack';
import * as cdk from 'aws-cdk-lib';
import { getEnvironmentConfig, resolveApiImageTag } from '../config/environment';
import { websiteConfig } from '../config/website';
import { deploymentAccount } from '../config/deployment';
import { AuthStack } from '../lib/auth-stack';
import { ApiCertificateStack } from '../lib/api-certificate-stack';
import { VappStack } from '../lib/vapp-stack';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { SecurityStack } from '../lib/security-stack';
import { WebsiteStack } from '../lib/website-stack';
import { HvmCertificateStack } from '../lib/hvm-certificate-stack';
import { HvmWebsiteStack } from '../lib/hvm-website-stack';
import { ApiDeploymentPermissionsStack } from '../lib/api-deployment-permissions-stack';

import { BuiltMattersCertificateStack } from '../lib/built-matters-certificate-stack';
import { BuiltMattersWebsiteStack } from '../lib/built-matters-website-stack';

const app = new cdk.App();
// Explicit opt-in; ordinary API/site deployments do not create HVMapp resources.
if (app.node.tryGetContext('hvmApp') === 'true') {
  new HvmAppCertificateStack(app, deploymentAccount);
  new HvmAppStack(app, deploymentAccount);
}
const environmentName = process.env.DEPLOY_ENV ?? app.node.tryGetContext('environment');
const baseConfig = getEnvironmentConfig(environmentName);
const config = {
  ...baseConfig,
  account: deploymentAccount,
  region: baseConfig.region,
};
// Dev releases own the CloudFormation parameter; ambient/context pins apply only to prod.
const imageTag =
  config.name === 'dev'
    ? undefined
    : resolveApiImageTag(config, process.env.API_IMAGE_TAG ?? app.node.tryGetContext('imageTag'));

const network = new NetworkStack(app, config);
const security = new SecurityStack(app, config, network);
const observability = new ObservabilityStack(app, config);
const registry = new RegistryStack(app, config);
// The app/api public hostnames belong to dev initially; do not claim them in prod.
const auth = config.name === 'dev' ? new AuthStack(app, config) : undefined;
const apiCertificate =
  config.name === 'dev'
    ? ((app.node.tryGetContext('apiCertificateArn') as string | undefined) ??
      config.apiCertificateArn ??
      new ApiCertificateStack(app, config).certificate)
    : undefined;
if (config.name === 'dev') {
  new VappStack(app, config);
  new ApiDeploymentPermissionsStack(app);
}
const agentRuntimeEnabled = app.node.tryGetContext('agentRuntime') === 'true';
const workerPackage = app.node.tryGetContext('psuWorkerPackage');
const releasePackage = app.node.tryGetContext('psuReleasePackage');
if ((workerPackage !== undefined || releasePackage !== undefined) && !agentRuntimeEnabled)
  throw new Error('PSU configuration requires Agent Runtime infrastructure.');
if (workerPackage !== undefined && releasePackage !== undefined)
  throw new Error('Select one PSU package stage.');
const psu = loadPsuDeploymentInput(
  releasePackage ?? workerPackage,
  releasePackage !== undefined ? 'api' : 'worker',
  config,
);

if (agentRuntimeEnabled && (!auth || config.name !== 'dev')) {
  throw new Error(
    'Initial Agent Runtime infrastructure requires the existing dev Cognito/TLS foundation.',
  );
}
const agentRuntime =
  agentRuntimeEnabled && auth ? new AgentRuntimeFoundationStack(app, config, auth) : undefined;
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
  agentRuntime,
  psu,
);
if (agentRuntime)
  new AgentRuntimeStack(
    app,
    config,
    network,
    api.cluster,
    agentRuntime,
    `https://${vappConfig.apiDomainName}`,
    psu,
  );
new WebsiteStack(app, {
  ...websiteConfig,
  account: deploymentAccount,
});

new HvmCertificateStack(app, deploymentAccount);
new HvmWebsiteStack(app, deploymentAccount);
new BuiltMattersCertificateStack(app);
new BuiltMattersWebsiteStack(app);

security.addStackDependency(network);
api.addStackDependency(network);
api.addStackDependency(security);
api.addStackDependency(observability);
api.addStackDependency(registry);
