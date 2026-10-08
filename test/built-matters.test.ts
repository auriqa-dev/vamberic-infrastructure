import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { runInNewContext } from 'node:vm';
import { BuiltMattersCertificateStack } from '../lib/built-matters-certificate-stack';
import { BuiltMattersWebsiteStack } from '../lib/built-matters-website-stack';

const domains = [
  'built-matters.com',
  'www.built-matters.com',
  'built-matters.co.uk',
  'www.built-matters.co.uk',
];
function setup() {
  const app = new cdk.App();
  const certificate = new BuiltMattersCertificateStack(app);
  const website = new BuiltMattersWebsiteStack(app);
  return { certificate, website, template: Template.fromStack(website) };
}

test('Built Matters has a separate retained US certificate covering only its four public domains', () => {
  const { certificate, website } = setup();
  expect(certificate.account).toBe('755905325223');
  expect(certificate.region).toBe('us-east-1');
  expect(website.account).toBe('755905325223');
  expect(website.region).toBe('eu-west-2');
  expect(website.dependencies).toEqual([]);
  const template = Template.fromStack(certificate);
  template.resourceCountIs('AWS::CertificateManager::Certificate', 1);
  template.resourceCountIs('AWS::Route53::RecordSet', 0);
  template.hasResource('AWS::CertificateManager::Certificate', {
    Properties: {
      DomainName: domains[0],
      SubjectAlternativeNames: domains.slice(1),
      ValidationMethod: 'DNS',
    },
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  template.hasOutput('BuiltMattersCertificateArn', {});
  template.hasOutput('BuiltMattersCertificateValidationDomains', { Value: domains.join(',') });
});

test('Built Matters uses a private retained TLS-only bucket and signed CloudFront OAC', () => {
  const { template } = setup();
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
  const distributionId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
        Match.objectLike({
          Effect: 'Allow',
          Action: 's3:GetObject',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Condition: {
            StringEquals: {
              'AWS:SourceArn': {
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
          },
        }),
      ]),
    },
  });
  const serialized = JSON.stringify(template.toJSON());
  expect(serialized).not.toContain('app.built-matters.com');
  expect(serialized).not.toContain('Fn::ImportValue');
  expect(serialized).not.toContain('h-v-m.agency');
  expect(serialized).not.toContain('www.vamberic.com');
});

test('hosting serves prerendered pages with proper 404s, HTTPS and bounded cache TTLs', () => {
  const { template } = setup();
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: {
      Aliases: domains,
      DefaultRootObject: 'index.html',
      ViewerCertificate: {
        AcmCertificateArn: { Ref: 'BuiltMattersCertificateArn' },
        MinimumProtocolVersion: 'TLSv1.2_2021',
        SslSupportMethod: 'sni-only',
      },
      DefaultCacheBehavior: {
        Compress: true,
        ViewerProtocolPolicy: 'redirect-to-https',
        CachePolicyId: Match.anyValue(),
        FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
      },
      CustomErrorResponses: [403, 404].map((code) => ({
        ErrorCode: code,
        ResponseCode: 404,
        ResponsePagePath: '/404.html',
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
  template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: { MinTTL: 0, DefaultTTL: 300, MaxTTL: 31536000 },
  });
  const parameter = template.toJSON().Parameters.BuiltMattersCertificateArn;
  expect(parameter.Default).toBeUndefined();
  expect(parameter.AllowedPattern).toContain('us-east-1:755905325223');
  for (const name of [
    'BuiltMattersBucketName',
    'BuiltMattersDistributionId',
    'BuiltMattersDistributionDomainName',
    'BuiltMattersDeploymentRoleArn',
    'BuiltMattersCertificateArnOutput',
    'BuiltMattersDnsRecords',
  ])
    template.hasOutput(name, {});
});

test('all alternate hosts redirect with paths/queries intact; canonical paths map to prerendered files', () => {
  const { template } = setup();
  const code = Object.values(template.findResources('AWS::CloudFront::Function'))[0].Properties
    .FunctionCode;
  function invoke(host: string, uri: string, querystring = {}) {
    return runInNewContext(code + '\nhandler(event);', {
      event: { request: { headers: { host: { value: host } }, uri, querystring } },
    });
  }
  for (const host of domains.slice(1)) {
    const result = invoke(host, '/energy/', {
      next: { value: '%2Fcontact%3Fx%3D1' },
      tag: { value: 'a', multiValue: [{ value: 'a' }, { value: 'b' }] },
    });
    expect(result.statusCode).toBe(301);
    expect(result.headers.location.value).toBe(
      'https://built-matters.com/energy/?next=%2Fcontact%3Fx%3D1&tag=a&tag=b',
    );
    expect(invoke(host, '/').headers.location.value).toBe('https://built-matters.com/');
  }
  for (const [input, expected] of [
    ['/', '/index.html'],
    ['/energy/', '/energy/index.html'],
    ['/energy', '/energy/index.html'],
    ['/not-found', '/not-found/index.html'],
    ['/assets/main.js', '/assets/main.js'],
    ['/404.html', '/404.html'],
    ['/robots.txt', '/robots.txt'],
  ]) {
    expect(invoke(domains[0], input).uri).toBe(expected);
  }
});

test('deployment role trusts only the verified Built Matters repository/environment and scopes all actions', () => {
  const { template } = setup();
  template.resourceCountIs('AWS::IAM::Role', 1);
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
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
                'repo:auriqa-dev@209590030/built-matters@1383211665:environment:built-matters-prod',
            },
          },
        },
      ],
    },
  });
  const bucket = Object.keys(template.findResources('AWS::S3::Bucket'))[0];
  const distribution = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  expect(policies).toHaveLength(1);
  expect(policies[0].Properties.PolicyDocument.Statement).toEqual([
    { Effect: 'Allow', Action: 's3:ListBucket', Resource: { 'Fn::GetAtt': [bucket, 'Arn'] } },
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [bucket, 'Arn'] }, '/*']] },
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
            ':cloudfront::755905325223:distribution/',
            { Ref: distribution },
          ],
        ],
      },
    },
  ]);
});
