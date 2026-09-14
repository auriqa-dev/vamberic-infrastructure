export interface WebsiteConfig {
  readonly stackName: string;
  readonly account?: string;
  readonly region: string;
  readonly domainName: string;
  readonly certificateArn: string;
}

export const websiteConfig: WebsiteConfig = {
  stackName: 'VambericProdWebsite',
  region: 'eu-west-2',
  domainName: 'www.vamberic.com',
  certificateArn:
    'arn:aws:acm:us-east-1:755905325223:certificate/aee93e4c-7a6e-4b1b-9838-eb836b3e76f8',
};
