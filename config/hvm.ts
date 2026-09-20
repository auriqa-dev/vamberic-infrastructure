export const hvmConfig = {
  certificateStackName: 'VambericProdHvmCertificate',
  websiteStackName: 'VambericProdHvmWebsite',
  region: 'eu-west-2',
  certificateRegion: 'us-east-1',
  domainName: 'h-v-m.agency',
  wwwDomainName: 'www.h-v-m.agency',
  deploymentEnvironment: 'hvm-prod',
  // Verified with GitHub repository and OIDC customization APIs on 2026-09-19.
  deploymentOidcRepository: 'auriqa-dev@209590030/henry-vincent-moss@1376972156',
};
