import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import fixture from './fixtures/psu-worker.json';
import { loadPsuDeploymentInput } from '../lib/psu-deployment-input';
import { getEnvironmentConfig } from '../config/environment';
import { ApiStack } from '../lib/api-stack';
import { AgentRuntimeStack } from '../lib/agent-runtime-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { AuthStack } from '../lib/auth-stack';
import { AgentRuntimeFoundationStack } from '../lib/agent-runtime-foundation-stack';
const config = { ...getEnvironmentConfig('dev'), account: '123456789012' };
function withFile(value: unknown, run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'psu-input-'));
  const path = join(dir, 'input.json');
  try {
    writeFileSync(path, JSON.stringify(value));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function full() {
  const release = Object.fromEntries(
    Object.entries(fixture.worker.configuration.release).filter(
      ([k]) => k !== 'taskDefinitionFamily',
    ),
  );
  return {
    ...fixture,
    api: {
      release: {
        ...release,
        taskDefinitionArn:
          'arn:aws:ecs:eu-west-2:123456789012:task-definition/vamberic-dev-agent-runtime:42',
      },
      qualification: fixture.worker.qualification,
    },
  };
}
test('absence stays disabled; canonical worker package has no API revision', () => {
  expect(loadPsuDeploymentInput(undefined, 'worker', config)).toBeUndefined();
  withFile(fixture, (path) => {
    const p = loadPsuDeploymentInput(path, 'worker', config)!;
    expect(p.apiEnvironment).toEqual({});
    expect(p.providerSecretArn).toBe(fixture.worker.configuration.secretArn);
    expect(p.workerEnvironment.PSU_PRODUCTION_CONFIG).not.toContain('taskDefinitionArn');
  });
});
test('canonical full package transports exact API release', () => {
  withFile(full(), (path) => {
    const p = loadPsuDeploymentInput(path, 'api', config)!;
    expect(JSON.parse(p.apiEnvironment.PSU_PRODUCTION_RELEASE).taskDefinitionArn).toMatch(/:42$/);
  });
});
test('invalid, unknown, cross-account, oversized and incomplete files fail closed', () => {
  for (const value of [
    { ...fixture, OPENAI_API_KEY: 'synthetic-sensitive-marker' },
    { worker: { ...fixture.worker, qualification: {} } },
    'x'.repeat(32769),
    {},
    {
      ...full(),
      api: { ...full().api, release: { ...full().api.release, taskDefinitionArn: 'bad' } },
    },
  ])
    withFile(value, (path) =>
      expect(() => loadPsuDeploymentInput(path, 'api', config)).toThrow(
        'Invalid PSU deployment input; no configuration synthesized.',
      ),
    );
  withFile(fixture, (path) =>
    expect(() =>
      loadPsuDeploymentInput(path, 'worker', { ...config, account: '999999999999' }),
    ).toThrow(),
  );
});
for (const stage of ['worker', 'api'] as const)
  test(`${stage} stage synthesizes without cycles and keeps activation disabled`, () => {
    withFile(stage === 'worker' ? fixture : full(), (path) => {
      const psu = loadPsuDeploymentInput(path, stage, config)!;
      const app = new cdk.App();
      const network = new NetworkStack(app, config);
      const security = new SecurityStack(app, config, network);
      const observability = new ObservabilityStack(app, config);
      const registry = new RegistryStack(app, config);
      const auth = new AuthStack(app, config);
      const foundation = new AgentRuntimeFoundationStack(app, config, auth);
      const api = new ApiStack(
        app,
        config,
        network,
        security,
        observability,
        registry,
        undefined,
        auth,
        'arn:aws:acm:eu-west-2:123456789012:certificate/synthetic',
        foundation,
        psu,
      );
      const worker = new AgentRuntimeStack(
        app,
        config,
        network,
        api.cluster,
        foundation,
        'https://synthetic.invalid',
        psu,
      );
      const w = Template.fromStack(worker),
        a = Template.fromStack(api);
      expect(() => app.synth()).not.toThrow();
      w.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0 });
      const wt = JSON.stringify(w.toJSON());
      const at = JSON.stringify(a.toJSON());
      expect(wt).toContain('PSU_PRODUCTION_CONFIG');
      expect(wt).toContain('secretsmanager:GetSecretValue');
      expect(wt).toContain(fixture.worker.configuration.secretArn);
      expect(wt).toContain('@sha256:');
      expect(at).toContain('AGENT_DISPATCH_ENABLED');
      expect(at).toContain('"Value":"false"');
      expect(at.includes('PSU_PRODUCTION_RELEASE')).toBe(stage === 'api');
      expect(at).not.toContain('"Resource":"' + fixture.worker.configuration.secretArn + '"');
    });
  });
