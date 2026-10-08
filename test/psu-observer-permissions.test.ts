import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { getEnvironmentConfig } from '../config/environment';
import { ApiStack } from '../lib/api-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecurityStack } from '../lib/security-stack';
import { ObservabilityStack } from '../lib/observability-stack';
import { RegistryStack } from '../lib/registry-stack';
import { AuthStack } from '../lib/auth-stack';
import { AgentRuntimeFoundationStack } from '../lib/agent-runtime-foundation-stack';
interface Resource {
  Type: string;
  Properties: {
    PolicyDocument?: { Statement: { Action: string | string[]; Resource: unknown }[] };
    ContainerDefinitions?: { Environment?: { Name: string; Value: string }[] }[];
  };
}
function template(enabled: boolean) {
  const app = new cdk.App();
  const config = { ...getEnvironmentConfig('dev'), account: '123456789012' };
  const network = new NetworkStack(app, config);
  const security = new SecurityStack(app, config, network);
  const observability = new ObservabilityStack(app, config);
  const registry = new RegistryStack(app, config);
  const auth = new AuthStack(app, config);
  const foundation = enabled ? new AgentRuntimeFoundationStack(app, config, auth) : undefined;
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
  );
  const result = Template.fromStack(api).toJSON();
  expect(() => app.synth()).not.toThrow();
  return result;
}
test('observer IAM is absent from ordinary API deployments', () => {
  const result = template(false);
  expect(JSON.stringify(result)).not.toMatch(/ecs:DescribeServices|ecs:DescribeTasks/);
});
test('opt-in API observer is read-only and scoped to worker service and cluster tasks', () => {
  const result = template(true);
  const statements = (Object.values(result.Resources) as Resource[]).flatMap((r) =>
    r.Type === 'AWS::IAM::Policy' ? r.Properties.PolicyDocument!.Statement : [],
  );
  const observer = statements.filter((s) => JSON.stringify(s.Action).includes('ecs:'));
  expect(observer).toHaveLength(2);
  expect(JSON.stringify(observer)).not.toMatch(/ecs:\*|ecs:Update|ecs:RunTask|ecs:StopTask/);
  expect(observer[0].Action).toBe('ecs:DescribeServices');
  expect(JSON.stringify(observer[0].Resource)).toContain(
    'service/vamberic-dev-api/vamberic-dev-agent-runtime',
  );
  expect(observer[1].Action).toBe('ecs:DescribeTasks');
  expect(JSON.stringify(observer[1].Resource)).toContain('task/vamberic-dev-api/*');
  const tasks = (Object.values(result.Resources) as Resource[]).filter(
    (r) => r.Type === 'AWS::ECS::TaskDefinition',
  );
  const env = tasks.flatMap((t) =>
    t.Properties.ContainerDefinitions!.flatMap((c) => c.Environment ?? []),
  );
  expect(env).toContainEqual({ Name: 'AGENT_DISPATCH_ENABLED', Value: 'false' });
  expect(env.some((e) => e.Name.startsWith('PSU_'))).toBe(false);
  expect(env).toContainEqual({
    Name: 'HVM_EMPRESS_SUBJECTS',
    Value: 'c60222c4-30d1-7044-8edd-bd144d587afb',
  });
});
