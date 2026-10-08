import { psuAppInput } from '../lib/psu-app-input';
test('PSU application configuration is independent of Agent release or entitlement', () => {
  const config = {
    secretArn:
      'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/agent-runtime-openai-tZWGIR',
    projectId: 'proj_example',
    model: 'gpt-6.1-sol',
  };
  expect(psuAppInput(config, '755905325223', 'eu-west-2')).toEqual(config);
  expect(psuAppInput(undefined, '755905325223', 'eu-west-2')).toBeUndefined();
  expect(() =>
    psuAppInput({ ...config, apiKey: 'never-allowed' }, '755905325223', 'eu-west-2'),
  ).toThrow();
  expect(() => psuAppInput(config, '000000000000', 'eu-west-2')).toThrow();
});

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { AuthStack } from '../lib/auth-stack';
import { ApiCertificateStack } from '../lib/api-certificate-stack';
test('API uses a scoped ECS secret injection and has no PSU workload release dependency', () => {
  const secretArn =
    'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/agent-runtime-openai-tZWGIR';
  const app = new cdk.App({
    context: { psuApp: { secretArn, projectId: 'proj_example', model: 'gpt-6.1-sol' } },
  });
  const config = { ...getEnvironmentConfig('dev'), account: '755905325223' };
  const network = new NetworkStack(app, config),
    security = new SecurityStack(app, config, network),
    observability = new ObservabilityStack(app, config),
    registry = new RegistryStack(app, config),
    auth = new AuthStack(app, config),
    cert = new ApiCertificateStack(app, config);
  const api = new ApiStack(
    app,
    config,
    network,
    security,
    observability,
    registry,
    'test-abcdef0',
    auth,
    cert.certificate,
  );
  const template = Template.fromStack(api).toJSON();
  const resources = template.Resources as Record<
    string,
    {
      Type: string;
      Properties: {
        ContainerDefinitions: {
          Secrets: unknown[];
          Environment: { Name: string; Value: string }[];
        }[];
      };
    }
  >;
  const tasks = Object.values(resources).filter((r) => r.Type === 'AWS::ECS::TaskDefinition');
  const container = tasks[0].Properties.ContainerDefinitions[0];
  expect(container.Secrets).toContainEqual({
    Name: 'HVM_PSU_API_KEY',
    ValueFrom: secretArn + ':OPENAI_API_KEY::',
  });
  expect(container.Environment).toContainEqual({ Name: 'HVM_PSU_MODEL', Value: 'gpt-6.1-sol' });
  expect(
    container.Environment.some(
      (v) => v.Name === 'PSU_PRODUCTION_RELEASE' || v.Name === 'HVM_PSU_API_KEY',
    ),
  ).toBe(false);
});
