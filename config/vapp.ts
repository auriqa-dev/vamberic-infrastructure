import { websiteConfig } from './website';

export const vappConfig = {
  apiDomainName: 'api.vamberic.com',
  domainName: 'app.vamberic.com',
  // Existing us-east-1 certificate confirmed to cover app.vamberic.com.
  certificateArn: websiteConfig.certificateArn,
  deploymentRepository: 'auriqa-dev/vamberic-platform-api',
  deploymentEnvironment: 'vapp',
  callbackUrls: ['https://app.vamberic.com/', 'http://localhost:5173/'],
  logoutUrls: ['https://app.vamberic.com/', 'http://localhost:5173/'],
  corsOrigins: ['https://app.vamberic.com', 'http://localhost:5173'],
};
