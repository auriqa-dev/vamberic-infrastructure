import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
          API_IMAGE_TAG: 'test-environment',
          AWS_REGION: ambientRegion,
          AWS_DEFAULT_REGION: ambientRegion,
          CDK_DEFAULT_REGION: ambientRegion,
          CDK_DEFAULT_ACCOUNT: '111111111111',
          CDK_OUTDIR: outdir,
          CDK_CONTEXT_JSON: JSON.stringify({
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
        VambericProdWebsite: 'aws://755905325223/eu-west-2',
        VambericProdHvmCertificate: 'aws://755905325223/us-east-1',
        VambericProdHvmWebsite: 'aws://755905325223/eu-west-2',
      });
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
