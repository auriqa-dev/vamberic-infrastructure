import { getEnvironmentConfig, resolveApiImageTag, stackName } from '../config/environment';

describe('environment configuration', () => {
  test('defaults to the low-cost London dev environment', () => {
    const config = getEnvironmentConfig(undefined);

    expect(config.name).toBe('dev');
    expect(config.nodeEnvironment).toBe('production');
    expect(config.deploymentEnvironment).toBe('dev');
    expect(config.region).toBe('eu-west-2');
    expect(config.desiredCount).toBe(1);
    expect(config.natGateways).toBe(1);
    expect(config.repositoryRetainedImageCount).toBe(20);
    expect(config).not.toHaveProperty('apiImageTag');
    expect(config.apiCertificateArn).toBe(
      'arn:aws:acm:eu-west-2:755905325223:certificate/dba9f811-56bd-4168-8618-0523efa1a118',
    );
    expect(config.apiRuntimeSecretName).toBe('vamberic/dev/api');
    expect(config.apiRuntimeSecretCompleteArn).toBe(
      'arn:aws:secretsmanager:eu-west-2:755905325223:secret:vamberic/dev/api-vDW6XL',
    );
  });

  test('keeps production settings distinct from development', () => {
    const config = getEnvironmentConfig('prod');

    expect(config.name).toBe('prod');
    expect(config.nodeEnvironment).toBe('production');
    expect(config.deploymentEnvironment).toBe('prod');
    expect(config.desiredCount).toBeGreaterThan(1);
    expect(config.natGateways).toBeGreaterThan(1);
    expect(config.repositoryRetainedImageCount).toBe(50);
    expect(config.apiImageTag).toBeUndefined();
    expect(config.apiCertificateArn).toBeUndefined();
    expect(config.apiRuntimeSecretName).toBeUndefined();
    expect(config.apiRuntimeSecretCompleteArn).toBeUndefined();
    expect(stackName(config, 'Api')).toBe('VambericProdApi');
    expect(() => resolveApiImageTag(config, undefined)).toThrow(/No API image tag configured/);
  });

  test('rejects latest even when provided as an override', () => {
    expect(() => resolveApiImageTag(getEnvironmentConfig('dev'), 'latest')).toThrow(
      /not permitted/,
    );
  });

  test('rejects unsupported environments', () => {
    expect(() => getEnvironmentConfig('staging')).toThrow(/Unsupported environment/);
  });
});
