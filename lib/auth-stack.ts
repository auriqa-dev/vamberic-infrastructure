import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type { Construct } from 'constructs';
import { stackName, type EnvironmentConfig } from '../config/environment';
import { vappConfig } from '../config/vapp';

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly client: cognito.UserPoolClient;

  public constructor(scope: Construct, config: EnvironmentConfig) {
    super(scope, stackName(config, 'Auth'), {
      env: { account: config.account, region: config.region },
      description: 'Administrator-managed Vapp browser authentication',
    });
    this.userPool = new cognito.UserPool(this, 'VappUserPool', {
      userPoolName: `vamberic-${config.name}-vapp`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      keepOriginal: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(3),
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.client = this.userPool.addClient('VappBrowserClient', {
      userPoolClientName: `vamberic-${config.name}-vapp-browser`,
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: vappConfig.callbackUrls,
        logoutUrls: vappConfig.logoutUrls,
      },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
      refreshTokenValidity: cdk.Duration.days(1),
    });
    const domain = this.userPool.addDomain('ManagedLoginDomain', {
      cognitoDomain: { domainPrefix: `vamberic-${config.name}-vapp-${this.account}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });
    const branding = new cognito.CfnManagedLoginBranding(this, 'ManagedLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'CognitoClientId', { value: this.client.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoRegion', { value: this.region });
    new cdk.CfnOutput(this, 'CognitoDomain', { value: domain.baseUrl() });
    new cdk.CfnOutput(this, 'CognitoIssuer', {
      value: `https://cognito-idp.${this.region}.${this.urlSuffix}/${this.userPool.userPoolId}`,
    });
  }
}
