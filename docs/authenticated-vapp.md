# Authenticated Vapp deployment guide

These changes are infrastructure only. Nothing has been deployed, no user has been created, and no Vapp assets have been uploaded. `platform-api` was not changed. The public website stack and its configuration remain unchanged, with a captured pre-change template regression assertion.

## Resources and scope

The dev API reuses its VPC, NAT, ECS cluster, Fargate service, ALB, target group, ECR repository, logs, task roles and complete Secrets Manager ARN. The existing target group, service and ALB retain their logical IDs. Health checks remain `/health`; `MONGODB_URI` remains a Secrets Manager JSON-key injection.

New stacks:

- `VambericDevAuth`: retained, deletion-protected Cognito pool, public browser client, Cognito domain and managed-login branding.
- `VambericDevApiCertificate`: retained fallback implementation for environments without a supplied certificate. It is omitted from the current dev assembly because `config/dev.ts` supplies the issued London certificate. No new certificate or validation record is requested.
- `VambericDevVapp`: separate retained private S3 bucket, CloudFront distribution and OAC. Imports the public website's existing `us-east-1` certificate. A tightly scoped GitHub deployment role trusts the `vapp` Environment in `auriqa-dev/vamberic-platform-api`, which contains the Vapp frontend workspace. No separate frontend repository is used.

Dev API/security updates add port 443, TLS termination, port 80 permanent HTTPS redirect, and Cognito/CORS task environment variables. No second API service is created. These public app/API hostnames are assigned only to dev; production API configuration remains separate.

## Cognito and application contract

- Case-insensitive email sign-in; self-registration disabled; an administrator creates each user after deployment through Cognito. No CloudFormation user resources or separate password database.
- Passwords: minimum 12 characters, upper/lowercase, number and symbol; temporary passwords expire after three days.
- Email verification and email-only account recovery. Administrators must ensure each user's recovery email is verified.
- Optional TOTP MFA is configured now; MFA can later become required. SMS is disabled. Optional MFA enrollment requires application/Cognito account-management support and is not implemented here.
- Essentials tier with managed login v2 and Cognito-provided branding. Account-qualified domain prefix: `vamberic-dev-vapp-ACCOUNT_ID`.
- Public client without a secret. Only OAuth authorization-code grant is enabled; implicit/client-credentials grants are disabled. Scopes: `openid email profile`.
- Access/ID tokens last one hour; refresh tokens last one day; revocation enabled.
- Callback/logout URLs: `https://app.vamberic.com/` and `http://localhost:5173/`. Exact trailing slashes matter.
- Vapp must implement PKCE using S256, state and nonce verification. PKCE is requested by the browser; there is no CDK client setting that enforces it. See [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html).
- `CognitoDomain` is the full `https://...auth.eu-west-2.amazoncognito.com` URL. `CognitoIssuer` is the distinct `https://cognito-idp.eu-west-2.amazonaws.com/POOL_ID` token issuer. The app's OAuth endpoints are on the managed-login domain; JWT discovery/JWKS use the issuer.

ECS receives `AWS_REGION=eu-west-2`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and `CORS_ORIGINS=https://app.vamberic.com,http://localhost:5173`. The CORS value is a comma-separated list, never `*`. Confirm the API image parses that format, permits bearer authorization/preflight requests, validates signature/issuer/expiry, `token_use=access` and the access token's `client_id`, and protects intended routes while leaving health checks available. Infrastructure does not implement JWT validation. The approved immutable dev API image tag is `582d26d`, configured in `config/dev.ts`. No custom API scope/authorization model is assumed.

The dev API also receives `PUBLIC_ENQUIRY_CORS_ORIGINS=https://h-v-m.agency` from `config/dev.ts` for public enquiries. This server-side allowlist is separate from authenticated Vapp `CORS_ORIGINS`; HVM is not added to the private Vapp allowlist. Neither allowlist uses wildcard CORS.

## Certificate and DNS preflight

Repository inspection found one imported certificate:

`arn:aws:acm:us-east-1:755905325223:certificate/aee93e4c-7a6e-4b1b-9838-eb836b3e76f8`

The existing certificate is confirmed to cover `app.vamberic.com` and is imported for Vapp CloudFront; no new app certificate is created. It cannot serve the London ALB. [AWS requires a certificate in the load balancer's region](https://docs.aws.amazon.com/elasticloadbalancing/latest/classic/ssl-server-cert.html).

Live AWS inventory was unavailable because no AWS credentials were configured. Before deploying, run read-only checks under the intended account:

```bash
aws sts get-caller-identity
aws acm describe-certificate --region us-east-1 \
  --certificate-arn arn:aws:acm:us-east-1:755905325223:certificate/aee93e4c-7a6e-4b1b-9838-eb836b3e76f8 \
  --query 'Certificate.{Status:Status,Names:SubjectAlternativeNames}'
aws acm list-certificates --region eu-west-2 --certificate-statuses ISSUED PENDING_VALIDATION
```

The issued London certificate is confirmed and persisted in `config/dev.ts`:

`arn:aws:acm:eu-west-2:755905325223:certificate/dba9f811-56bd-4168-8618-0523efa1a118`

The default deployment imports this certificate; no context override or new certificate stack is required. An explicit `-c apiCertificateArn=...` can override the configured ARN when deliberately changing certificates. Only if neither configuration nor context supplies an ARN does CDK synthesize the fallback certificate stack. Keep all existing certificates and DNS validation records. Omitting an already-deployed certificate stack from this CDK assembly does not delete it; do not run stack destruction or remove its retained certificate. Confirm the imported certificates and GitHub OIDC provider belong to the target account. Check existing CloudFront aliases before assigning `app.vamberic.com`.

Public DNS inspection on 2026-09-17 returned `dns1.registrar-servers.com` and `dns2.registrar-servers.com`, consistent with Namecheap DNS. Queries returned no CNAME for `app` or `api`; this is not a full DNS zone inventory. No Route 53 hosted zone or records are created.

Required records at the current authoritative DNS provider:

| Type  | Host                                            | Value                                                  |
| ----- | ----------------------------------------------- | ------------------------------------------------------ |
| CNAME | `api`                                           | `VambericDevApi.ApiLoadBalancerDnsName`                |
| CNAME | `app`                                           | `VambericDevVapp.VappDistributionDomainName`           |
| CNAME | ACM-provided validation host, e.g. `_TOKEN.api` | Exact ACM-provided `_TOKEN.acm-validations.aws.` value |

Use DNS hostnames only, without `https://` or paths. For Namecheap, enter the relative host portion when the UI appends `vamberic.com`. Inspect existing A/AAAA/CNAME/URL redirect records at those same names before changing them; leave apex and `www` records untouched. Retain ACM validation records for renewal. The Cognito-managed domain needs no customer DNS record.

The following validation procedure applies only to a future new certificate, not the currently imported issued certificate. ACM validation tokens do not exist before AWS requests a certificate. During certificate-stack deployment, find the certificate ARN in CloudFormation Events or ACM, then inspect:

```bash
aws acm describe-certificate --region eu-west-2 --certificate-arn REQUESTED_ARN \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

The certificate stack waits for external validation; its final output is unavailable until validation completes. Publish the exact CNAME while that deployment is pending. If a matching validation record already exists, reuse it. Review CAA restrictions if issuance is blocked.

## Operator-controlled deployment order

Run build, lint, tests and synth, then review AWS-aware CDK diffs. No deploy commands have been executed as part of this task.

1. Confirm the intended account/region. Use the issued London API certificate configured above and reuse the existing app certificate.
2. Skip `VambericDevApiCertificate` for this deployment: the issued certificate is imported. Preserve any existing certificate stack/resources and all validation DNS records.
3. Deploy `VambericDevAuth` and `VambericDevVapp` after reviewing their diff. The Vapp stack includes the deployment role for `auriqa-dev/vamberic-platform-api`; no repository context argument is needed. There is no asset deployment custom resource; the distribution serves no usable app until a build is uploaded.
4. Deploy `VambericDevSecurity` and `VambericDevApi` with their dependencies and an approved auth-capable immutable image. CDK connects auth/certificate outputs to the task/listener automatically. This rolls the existing ECS service. Existing clients using the ALB's plain HTTP hostname must switch to `https://api.vamberic.com`; its AWS hostname is not covered by the certificate.
5. Set the `api` CNAME, deploy the Vapp build, then set the `app` CNAME. Create the first human user through the administrator-controlled Cognito process. Check login, logout, deep links, invalid/expired JWT rejection, preflight, health checks and MongoDB connectivity.

Use `AWS_REGION=eu-west-2 AWS_DEFAULT_REGION=eu-west-2` for CLI synthesis/deployment. The CDK CLI recalculates its child region; setting only `CDK_DEFAULT_REGION` is insufficient. Do not deploy `--all`, which would include the public website stack.

## Outputs

| Stack                                    | Outputs                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `VambericDevAuth`                        | `CognitoUserPoolId`, `CognitoClientId`, `CognitoRegion`, `CognitoDomain`, `CognitoIssuer`                                            |
| `VambericDevApiCertificate` (if created) | `ApiCertificateArn`                                                                                                                  |
| `VambericDevApi`                         | New `ApiDomainName`, `ApiBaseUrl`; existing `ApiLoadBalancerDnsName` and task/cluster/subnet/security-group/container outputs remain |
| `VambericDevVapp`                        | `VappBucketName`, `VappDistributionId`, `VappDistributionDomainName`; `VappDeploymentRoleArn`                                        |

All outputs are non-secret. No MongoDB values or credentials are output.

## GitHub Actions implications

The repository's `deploy-dev.yml`, database setup workflows and execution-role diagnostic workflow use OIDC. None deploy Vapp assets. Read-only inspection also confirmed the existing platform repository uses pnpm 10.26.1 with Node 24. No workflows or external application repositories were modified here.

Before running the existing infrastructure deployment workflow:

- The current dev configuration imports an issued certificate, so no certificate validation stage is required. Do not add `VambericDevApiCertificate` to the deployment list.
- Add `VambericDevAuth` and `VambericDevVapp` to its explicit deployment list. Auth/certificate are also inferred dependencies of API. Keep `VambericProdWebsite` excluded and retain the manual trigger.
- The London certificate ARN is persisted in `config/dev.ts`; synth and deploy need no certificate context argument. If deliberately overriding it, use the same override in both commands. The repository and GitHub Environment are fixed in `config/vapp.ts`; no repository override is accepted by the stack.
- Confirm its OIDC/CDK deployment identity can provision Cognito, ACM, S3, CloudFront and the scoped IAM role. Do not add access keys.
- The API image does not need Cognito build-time variables. CDK places them on the task definition. An image release workflow must preserve this task environment and secret injection; it must not overwrite them with a reduced task definition. An infrastructure deployment rolls tasks to pick up changes. Existing one-off database task workflows reuse the same task definition.

In `auriqa-dev/vamberic-platform-api`, create a protected GitHub Environment named `vapp`, restrict permitted deployment branches, and set these non-secret variables from outputs:

```text
VITE_PLATFORM_API_BASE_URL=https://api.vamberic.com
VITE_COGNITO_REGION=eu-west-2
VITE_COGNITO_USER_POOL_ID=<CognitoUserPoolId>
VITE_COGNITO_CLIENT_ID=<CognitoClientId>
VITE_COGNITO_DOMAIN=<CognitoDomain, full https URL>
AWS_DEPLOY_ROLE_ARN=<VappDeploymentRoleArn>
VAPP_BUCKET_NAME=<VappBucketName>
VAPP_DISTRIBUTION_ID=<VappDistributionId>
```

Vite embeds these values at build time; changing them requires rebuilding. Confirm the frontend consumes a full URL for `VITE_COGNITO_DOMAIN`; if its library expects a hostname, normalize at that application boundary. Never put application secrets in `VITE_*` variables.

Proposed workflow in `auriqa-dev/vamberic-platform-api`: install at the monorepo root, build only `@workspace/vapp` (`artifacts/vapp`), and upload `artifacts/vapp/dist/public`. These paths and the required `PORT`/`BASE_PATH` settings were verified from its package and Vite configuration. The root build script builds other workspaces too and is not used for this asset deployment.

```yaml
name: Deploy Vapp
on:
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: vapp
    concurrency: vapp-deployment
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.26.1
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @workspace/vapp run build
        env:
          NODE_ENV: production
          PORT: '5173'
          BASE_PATH: /
          VITE_PLATFORM_API_BASE_URL: https://api.vamberic.com
          VITE_COGNITO_REGION: eu-west-2
          VITE_COGNITO_USER_POOL_ID: ${{ vars.VITE_COGNITO_USER_POOL_ID }}
          VITE_COGNITO_CLIENT_ID: ${{ vars.VITE_COGNITO_CLIENT_ID }}
          VITE_COGNITO_DOMAIN: ${{ vars.VITE_COGNITO_DOMAIN }}
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: eu-west-2
      - name: Upload Vapp and invalidate cache
        env:
          VAPP_BUCKET_NAME: ${{ vars.VAPP_BUCKET_NAME }}
          VAPP_DISTRIBUTION_ID: ${{ vars.VAPP_DISTRIBUTION_ID }}
        run: |
          test -n "$VAPP_BUCKET_NAME"
          test -n "$VAPP_DISTRIBUTION_ID"
          test -f artifacts/vapp/dist/public/index.html
          aws s3 sync artifacts/vapp/dist/public/ "s3://$VAPP_BUCKET_NAME/" --exclude index.html --cache-control 'public,max-age=31536000,immutable'
          aws s3 cp artifacts/vapp/dist/public/index.html "s3://$VAPP_BUCKET_NAME/index.html" --cache-control 'no-cache' --content-type text/html
          aws cloudfront create-invalidation --distribution-id "$VAPP_DISTRIBUTION_ID" --paths '/*'
```

Only use long immutable caching for fingerprinted assets; adjust the example if the build emits other mutable files. Old hashed assets are retained so already-open browser sessions keep working; use a separate deliberate cleanup policy later. CloudFront's minimum default-cache TTL can cache `index.html` briefly; invalidation refreshes it after each release.

The role uses GitHub's immutable subject format, including owner ID `209590030` and repository ID `1362482756`. It imports the account's existing GitHub OIDC provider and trusts only `repo:auriqa-dev@209590030/vamberic-platform-api@1362482756:environment:vapp` with audience `sts.amazonaws.com`. Permissions are limited to this Vapp bucket's list/write/delete and this distribution's invalidation. It cannot deploy the public website, change infrastructure or read runtime secrets. Confirm the provider already exists before deploying the stack. The role is separate from the API image deployment role but trusts the same repository, scoped to its protected `vapp` Environment.

## Decisions before deployment

The repository and CloudFront certificate reuse are confirmed. The London certificate and API image `582d26d` are also confirmed. Remaining prerequisites are the existing GitHub OIDC provider, protected `vapp` Environment setup in `auriqa-dev/vamberic-platform-api`, and release image/application readiness. `localhost:5173/`, comma-separated CORS and a full-URL Cognito domain are the explicit integration defaults. Dev will own `app.vamberic.com` and `api.vamberic.com` initially; plan any later production cutover separately. No extra human approval is needed to review or synthesize these changes.


## HVM enquiry notification email

Dev config enables `NOTIFICATION_EMAIL_ENABLED=true`, sets `NOTIFICATION_EMAIL_FROM=notifications@vamberic.com`, and sets `PRODUCT_ENQUIRY_NOTIFICATION_RECIPIENTS_JSON={"product_01m2wffbf3p9p19d3nd1s2fp3x":["notifications@vamberic.com"]}`. The API image remains `582d26d`.

The application task role `vamberic-dev-api-task` receives only `ses:SendEmail`, scoped to `arn:aws:ses:eu-west-2:755905325223:identity/vamberic.com` and `arn:aws:ses:eu-west-2:755905325223:identity/notifications@vamberic.com`, supporting domain or individual address verification. Conditions restrict both the sender and all recipients to `notifications@vamberic.com`. The local API provider uses structured `SendEmailCommand`; no `ses:SendRawEmail` or SES administration permission is granted. The execution role retains its existing secret/log/image permissions. Authentication uses ECS task credentials with no AWS keys in runtime configuration.

Before deployment, confirm the domain or sender address is verified for SES sending in `eu-west-2`. If the account is in the SES sandbox, the recipient must also be verified (the configured recipient is the same address). This infrastructure change does not create/verify SES identities, request production access, deploy, or send mail; live SES status has not been checked. See [AWS SES IAM scoping](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html) and [SES SendEmail prerequisites](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html).
