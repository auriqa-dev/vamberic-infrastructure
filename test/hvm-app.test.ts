import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { HvmAppStack, HvmAppCertificateStack } from '../lib/hvm-app-stack';
import { runInNewContext } from 'node:vm';
test('HVMapp is private, HTTPS, scoped OIDC, CSP and SPA paths', () => {
  const app = new cdk.App();
  const t = Template.fromStack(new HvmAppStack(app, '755905325223'));
  t.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Aliases: ['app.h-v-m.agency'],
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
    }),
  });
  t.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:auriqa-dev@209590030/hvm-app@1392322706:environment:hvmapp',
            },
          },
        }),
      ]),
    }),
  });
  const headers = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]
    .Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  expect(headers.ContentSecurityPolicy.ContentSecurityPolicy).toContain('https://api.vamberic.com');
  expect(headers.ContentSecurityPolicy.ContentSecurityPolicy).not.toContain('unsafe-inline');
  const code = Object.values(t.findResources('AWS::CloudFront::Function'))[0].Properties
    .FunctionCode;
  for (const uri of [
    '/',
    '/auth/callback',
    '/queen',
    '/queen/clients',
    '/queen/clients/workspace_abc',
    '/client',
    '/client/setup',
    '/client/brand',
    '/client/integrations',
    '/client/team',
    '/client/swarm',
    '/client/activity',
  ])
    expect(runInNewContext(code + '; handler({request:{uri: input}})', { input: uri }).uri).toBe(
      '/index.html',
    );
  expect(
    runInNewContext(code + '; handler({request:{uri: input}})', { input: '/assets/main.js' }).uri,
  ).toBe('/assets/main.js');
});
test('dedicated app certificate does not alter the website certificate', () => {
  const t = Template.fromStack(new HvmAppCertificateStack(new cdk.App(), '755905325223'));
  t.hasResourceProperties('AWS::CertificateManager::Certificate', {
    DomainName: 'app.h-v-m.agency',
    ValidationMethod: 'DNS',
  });
});
