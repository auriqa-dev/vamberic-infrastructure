import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { runInNewContext } from 'node:vm';
import { HvmCertificateStack } from '../lib/hvm-certificate-stack';
import { HvmWebsiteStack } from '../lib/hvm-website-stack';
import { WebsiteStack } from '../lib/website-stack';
import { websiteConfig } from '../config/website';
import productionWebsiteBaseline from './fixtures/production-website.template.json';

function setup() {
  const app = new cdk.App();
  const certificate = new HvmCertificateStack(app);
  const website = new HvmWebsiteStack(app);
  return { app, certificate, website, template: Template.fromStack(website) };
}

test('HVM certificate is dedicated, retained, DNS validated and in us-east-1', () => {
  const { certificate } = setup();
  expect(certificate.region).toBe('us-east-1');
  const template = Template.fromStack(certificate);
  template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
  template.hasResource('AWS::CertificateManager::Certificate', {
    Properties: {
      DomainName: 'h-v-m.agency',
      SubjectAlternativeNames: ['www.h-v-m.agency'],
      ValidationMethod: 'DNS',
    },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  template.hasOutput('HvmCertificateArn', {});
  template.hasOutput('HvmCertificateValidationDomains', {});
});

test('HVM hosting uses its own retained private encrypted bucket and OAC distribution', () => {
  const { website, template } = setup();
  expect(website.region).toBe('eu-west-2');
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResource('AWS::S3::Bucket', {
    Properties: {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      WebsiteConfiguration: Match.absent(),
    },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: {
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
    },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
        Match.objectLike({
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
        }),
      ]),
    },
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Aliases: ['h-v-m.agency', 'www.h-v-m.agency'],
      DefaultRootObject: 'index.html',
      ViewerCertificate: {
        AcmCertificateArn: { Ref: 'HvmCertificateArn' },
        SslSupportMethod: 'sni-only',
      },
      DefaultCacheBehavior: {
        Compress: true,
        ViewerProtocolPolicy: 'redirect-to-https',
        FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
      },
      CustomErrorResponses: [403, 404].map((code) => ({
        ErrorCode: code,
        ResponseCode: 200,
        ResponsePagePath: '/index.html',
        ErrorCachingMinTTL: 0,
      })),
      Origins: [
        Match.objectLike({
          OriginAccessControlId: Match.anyValue(),
          S3OriginConfig: { OriginAccessIdentity: '' },
        }),
      ],
    },
  });
  expect(template.toJSON().Parameters.HvmCertificateArn.Default).toBeUndefined();
  for (const name of [
    'HvmBucketName',
    'HvmDistributionId',
    'HvmDistributionDomainName',
    'HvmDeploymentRoleArn',
    'HvmCertificateArnOutput',
  ]) {
    template.hasOutput(name, {});
  }
});

test('HVM role trusts only the verified immutable repository subject and hvm-prod', () => {
  const { template } = setup();
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('AWS::IAM::Role', 1);
  template.hasResourceProperties('AWS::IAM::Role', {
    ManagedPolicyArns: Match.absent(),
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Principal: { Federated: Match.anyValue() },
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub':
                'repo:auriqa-dev@209590030/henry-vincent-moss@1376972156:environment:hvm-prod',
            },
          },
        },
      ],
    },
  });
  const resources = template.toJSON().Resources;
  const bucketId = Object.keys(template.findResources('AWS::S3::Bucket'))[0];
  const distributionId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  expect(policies).toHaveLength(1);
  expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
    { Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': [bucketId, 'Arn'] } },
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, '/*']] },
    },
    {
      Effect: 'Allow',
      Action: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      Resource: {
        'Fn::Join': [
          '',
          [
            'arn:',
            { Ref: 'AWS::Partition' },
            ':cloudfront::',
            { Ref: 'AWS::AccountId' },
            ':distribution/',
            { Ref: distributionId },
          ],
        ],
      },
    },
  ]);
  expect(
    Object.values(resources).some((resource: unknown) =>
      JSON.stringify(resource).includes('vamberic-platform-api'),
    ),
  ).toBe(false);
});

test('www redirects to apex with encoded and repeated query values preserved; apex passes through', () => {
  const { template } = setup();
  const code = Object.values(template.findResources('AWS::CloudFront::Function'))[0].Properties
    .FunctionCode;
  const request = {
    headers: { host: { value: 'www.h-v-m.agency' } },
    uri: '/contact',
    querystring: {
      next: { value: '%2Fhello%3Fx%3D1' },
      tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
    },
  };
  const result = runInNewContext(code + '\nhandler(event);', { event: { request } });
  expect(result.statusCode).toBe(301);
  expect(result.headers.location.value).toBe(
    'https://h-v-m.agency/contact?next=%2Fhello%3Fx%3D1&tag=a&tag=b',
  );
  request.headers.host.value = 'h-v-m.agency';
  expect(runInNewContext(code + '\nhandler(event);', { event: { request } })).toBe(request);
  request.headers.host.value = 'www.h-v-m.agency';
  expect(
    runInNewContext(code + '\nhandler(event);', {
      event: { request: { ...request, uri: '/', querystring: {} } },
    }).headers.location.value,
  ).toBe('https://h-v-m.agency/');
});

test('adding HVM leaves all existing production website resources and outputs unchanged', () => {
  const app = new cdk.App();
  const hvm = new HvmWebsiteStack(app);
  const certificate = new HvmCertificateStack(app);
  const website = new WebsiteStack(app, websiteConfig);
  const actual = Template.fromStack(website).toJSON();
  const withoutMetadata = (resources: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(resources)
        .filter(([, resource]) => (resource as { Type: string }).Type !== 'AWS::CDK::Metadata')
        .map(([key, resource]) => {
          const copy = { ...(resource as Record<string, unknown>) };
          delete copy.Metadata;
          return [key, copy];
        }),
    );
  expect(withoutMetadata(actual.Resources)).toEqual(
    withoutMetadata(productionWebsiteBaseline.Resources),
  );
  expect(actual.Outputs).toEqual(productionWebsiteBaseline.Outputs);
  expect(hvm.dependencies).toEqual([]);
  expect(certificate.dependencies).toEqual([]);
  const hvmJson = JSON.stringify(Template.fromStack(hvm).toJSON());
  expect(hvmJson).not.toContain('Fn::ImportValue');
  expect(hvmJson).not.toContain(websiteConfig.certificateArn);
  expect(hvmJson).not.toContain(websiteConfig.domainName);
});
