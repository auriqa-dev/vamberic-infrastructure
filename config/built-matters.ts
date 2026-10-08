export const builtMattersConfig = {
  websiteStackName: 'VambericProdBuiltMattersWebsite',
  certificateStackName: 'VambericProdBuiltMattersCertificate',
  region: 'eu-west-2',
  certificateRegion: 'us-east-1',
  domainName: 'built-matters.com',
  redirectDomains: ['www.built-matters.com', 'built-matters.co.uk', 'www.built-matters.co.uk'],
  deploymentEnvironment: 'built-matters-prod',
  // Verified with GitHub repository and OIDC customization APIs on 2026-09-28.
  deploymentOidcRepository: 'auriqa-dev@209590030/built-matters@1383211665',
};
