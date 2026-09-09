import { getEnvironmentConfig, stackName } from '../config/environment';

describe('environment configuration', () => {
  test('defaults to the low-cost London dev environment', () => {
    const config = getEnvironmentConfig(undefined);

    expect(config.name).toBe('dev');
    expect(config.region).toBe('eu-west-2');
    expect(config.desiredCount).toBe(1);
    expect(config.natGateways).toBe(1);
    expect(config.repositoryRetainedImageCount).toBe(20);
  });

  test('keeps production settings distinct from development', () => {
    const config = getEnvironmentConfig('prod');

    expect(config.name).toBe('prod');
    expect(config.desiredCount).toBeGreaterThan(1);
    expect(config.natGateways).toBeGreaterThan(1);
    expect(config.repositoryRetainedImageCount).toBe(50);
    expect(stackName(config, 'Api')).toBe('VambericProdApi');
  });

  test('rejects unsupported environments', () => {
    expect(() => getEnvironmentConfig('staging')).toThrow(/Unsupported environment/);
  });
});
