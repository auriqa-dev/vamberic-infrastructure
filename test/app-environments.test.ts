import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import baseline from './fixtures/pipeline-baseline.json';

// Exercise the actual CLI entrypoint, not a duplicate of its stack wiring.
test.each(['us-east-1', 'eu-west-2'])(
  'app pins account and regional destinations with ambient region %s',
  (ambientRegion) => {
    const outdir = mkdtempSync(join(tmpdir(), 'vamberic-env-test-'));
    try {
      execFileSync(process.execPath, ['-r', 'ts-node/register', 'bin/vamberic-infrastructure.ts'], {
        cwd: resolve(__dirname, '..'),
        env: {
          ...process.env,
          DEPLOY_ENV: 'dev',
          API_IMAGE_TAG: 'latest', // Dev must ignore legacy image overrides.
          AWS_REGION: ambientRegion,
          AWS_DEFAULT_REGION: ambientRegion,
          CDK_DEFAULT_REGION: ambientRegion,
          CDK_DEFAULT_ACCOUNT: '111111111111',
          CDK_OUTDIR: outdir,
          CDK_CONTEXT_JSON: JSON.stringify({
            imageTag: 'also-ignored',
            'availability-zones:account=755905325223:region=eu-west-2': [
              'eu-west-2a',
              'eu-west-2b',
              'eu-west-2c',
            ],
          }),
        },
        stdio: 'pipe',
        timeout: 30000,
      });
      const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
      const destinations = Object.fromEntries(
        Object.entries(manifest.artifacts)
          .filter(
            ([, artifact]) => (artifact as { type: string }).type === 'aws:cloudformation:stack',
          )
          .map(([name, artifact]) => [name, (artifact as { environment: string }).environment]),
      );
      expect(destinations).toEqual({
        VambericDevNetwork: 'aws://755905325223/eu-west-2',
        VambericDevSecurity: 'aws://755905325223/eu-west-2',
        VambericDevObservability: 'aws://755905325223/eu-west-2',
        VambericDevRegistry: 'aws://755905325223/eu-west-2',
        VambericDevAuth: 'aws://755905325223/eu-west-2',
        VambericDevVapp: 'aws://755905325223/eu-west-2',
        VambericDevApi: 'aws://755905325223/eu-west-2',
        VambericDevApiDeploymentPermissions: 'aws://755905325223/eu-west-2',
        VambericProdWebsite: 'aws://755905325223/eu-west-2',
        VambericProdHvmCertificate: 'aws://755905325223/us-east-1',
        VambericProdHvmWebsite: 'aws://755905325223/eu-west-2',
      });
      for (const [name, previous] of Object.entries(baseline)) {
        const actual = JSON.parse(readFileSync(join(outdir, `${name}.template.json`), 'utf8'));
        // These tests run without CLI metadata and with a fixed AZ context. Compare
        // resources/outputs, excluding metadata only, and permit precisely two changes.
        const expected = JSON.parse(JSON.stringify(previous));
        if (name === 'VambericDevApi') {
          expect(actual.Parameters.ApiImageTag).toMatchObject({
            Type: 'String',
            AllowedPattern: '[a-f0-9]{7,40}',
          });
          expect(actual.Parameters.ApiImageTag).not.toHaveProperty('Default');
          const taskId = 'ApiTaskDefinition51EA709E';
          const image = actual.Resources[taskId].Properties.ContainerDefinitions[0].Image;
          expect(image['Fn::Join'][1].at(-1)).toEqual({ Ref: 'ApiImageTag' });
          // Only the image may refer to the parameter.
          actual.Resources[taskId].Properties.ContainerDefinitions[0].Image =
            expected.Resources[taskId].Properties.ContainerDefinitions[0].Image;
          delete actual.Parameters.ApiImageTag;
          expect(JSON.stringify(actual)).not.toContain('ApiImageTag');
        }
        if (name === 'VambericDevVapp') {
          for (const resource of Object.values(expected.Resources) as Array<{
            Type: string;
            Properties: { PolicyDocument?: { Statement: Array<{ Action: string | string[] }> } };
          }>) {
            for (const statement of resource.Properties?.PolicyDocument?.Statement ?? []) {
              if (statement.Action === 'cloudfront:CreateInvalidation') {
                statement.Action = ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'];
              }
            }
          }
        }
        const cleanResources = (resources: Record<string, { Type: string; Metadata?: unknown }>) =>
          Object.fromEntries(
            Object.entries(resources)
              .filter(([, r]) => r.Type !== 'AWS::CDK::Metadata')
              .map(([key, resource]) => {
                const copy = { ...resource };
                delete copy.Metadata;
                return [key, copy];
              }),
          );
        expect(cleanResources(actual.Resources)).toEqual(cleanResources(expected.Resources));
        expect(actual.Outputs).toEqual(expected.Outputs);
      }
      // Existing CloudFront certificates remain imported from us-east-1.
      for (const name of ['VambericDevVapp', 'VambericProdWebsite']) {
        const template = JSON.parse(readFileSync(join(outdir, `${name}.template.json`), 'utf8'));
        const distribution = Object.values(template.Resources).find(
          (resource) => (resource as { Type: string }).Type === 'AWS::CloudFront::Distribution',
        ) as {
          Properties: { DistributionConfig: { ViewerCertificate: { AcmCertificateArn: string } } };
        };
        expect(distribution.Properties.DistributionConfig.ViewerCertificate.AcmCertificateArn).toBe(
          'arn:aws:acm:us-east-1:755905325223:certificate/aee93e4c-7a6e-4b1b-9838-eb836b3e76f8',
        );
      }
      const hvm = JSON.parse(
        readFileSync(join(outdir, 'VambericProdHvmWebsite.template.json'), 'utf8'),
      );
      expect(hvm.Parameters.HvmCertificateArn.AllowedPattern).toContain('us-east-1');
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  },
  40000,
);
