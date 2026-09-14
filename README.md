# Vamberic Infrastructure

AWS CDK v2 infrastructure for the Vamberic Studio shared API runtime and public website.

This repository is intentionally infrastructure-only. It defines AWS resources, but it does not deploy anything by default and it does not connect to MongoDB Atlas.

## Architecture

The initial architecture is designed for separate `dev` and `prod` environments in `eu-west-2`:

- A VPC with public subnets for the load balancer and private application subnets for ECS tasks.
- A NAT Gateway with an AWS-managed Elastic IP for predictable outbound traffic to MongoDB Atlas.
- An ECS cluster running a Fargate service behind a public Application Load Balancer.
- An independently deployable ECR registry stack for the API container image.
- Separate task execution and application task IAM roles with least-privilege defaults.
- A Secrets Manager secret reserved for runtime application configuration.
- A CloudWatch log group with environment-specific retention.
- An ALB health check at `/health`.
- A production static website served from a private S3 bucket through CloudFront.

Product applications and the Vamberic console will call the shared API. They must not connect directly to MongoDB Atlas.

Route 53 records, new ACM certificates, MongoDB connectivity, queues, scheduled tasks, and agent infrastructure are intentionally out of scope. The website stack uses an existing CloudFront-compatible ACM certificate in `us-east-1`.

## Environments

Environment configuration lives in `config/`:

- `config/dev.ts` — one low-cost Fargate task, one NAT Gateway, and the currently approved immutable API image tag.
- `config/prod.ts` — two initial Fargate tasks and two NAT Gateways for higher availability. Production intentionally has no default image tag.

Each environment synthesizes five stacks:

- `VambericDevNetwork` / `VambericProdNetwork`
- `VambericDevSecurity` / `VambericProdSecurity`
- `VambericDevObservability` / `VambericProdObservability`
- `VambericDevRegistry` / `VambericProdRegistry`
- `VambericDevApi` / `VambericProdApi`

Development also synthesizes `VambericDevApiBootstrap`, a standalone IAM bootstrap stack for the existing API execution role. The CDK application also synthesizes `VambericProdWebsite`, a logically separate production stack for `www.vamberic.com`. Neither stack is part of the dev API deployment workflow.

The registry is deliberately separate from the API service. This allows a new account to create the repository, receive an API image, and only then create the Fargate service.

The CDK app synthesizes `dev` by default. Select an environment with either:

```bash
DEPLOY_ENV=prod npm run synth
```

or:

```bash
npm run cdk -- synth -c environment=prod
```

Stack deployment accounts come from the ambient `CDK_DEFAULT_ACCOUNT` when one is available. Existing-resource configuration contains the supplied complete ARNs for the ACM certificate and dev API runtime secret; those identifiers necessarily include their owning AWS account IDs. The region defaults to `eu-west-2` and can be overridden with `CDK_DEFAULT_REGION`.

## Production website

`VambericProdWebsite` contains:

- A private, S3-managed encrypted bucket with all public access blocked and a retain policy.
- A CloudFront distribution for `www.vamberic.com`.
- CloudFront Origin Access Control for signed access to the private bucket.
- The existing `us-east-1` ACM certificate configured in `config/website.ts`.
- HTTP-to-HTTPS redirection, compression, and `index.html` as the default root object.
- HTTP 403 and 404 responses mapped to `/index.html` with status 200 for client-side routes.

The stack outputs the bucket name, distribution ID, and distribution domain name. It does not create DNS records, upload website assets, or configure `app.vamberic.com`. The website source remains in `auriqa-dev/vamberic`; its deployment process should upload `dist/public` to the emitted bucket and invalidate CloudFront after a production build.

Review and deploy the website independently:

```bash
npm run cdk -- diff VambericProdWebsite
npm run cdk -- deploy VambericProdWebsite --exclusively
```

## Prerequisites

- Node.js 24
- npm 10 or newer
- AWS CDK CLI 2.x (`npm run cdk -- --version` uses the local dependency)
- AWS credentials are only required for future `cdk diff` or `cdk deploy` operations. They are not required for the local build, tests, or synthesis in this repository.

## Local commands

```bash
npm install
npm run build
npm run lint
npm test
npm run synth
npm run diff
```

`npm run synth` writes CloudFormation templates to `cdk.out/`. It does not create AWS resources.

## First deployment sequence

The initial account bootstrap and first staged deployment remain operator-controlled. A brand-new account should be brought up in stages.

The examples below use `dev`; substitute the `Prod` stack names and `-c environment=prod` for production.

1. Confirm the target account and region, then bootstrap CDK:

   ```bash
   npm run cdk -- bootstrap aws://ACCOUNT_ID/eu-west-2
   ```

2. Deploy the prerequisite stacks. This creates the network, security controls, logs, and empty ECR repository, but not the ECS service:

   ```bash
   npm run cdk -- deploy \
     VambericDevNetwork \
     VambericDevSecurity \
     VambericDevObservability \
     VambericDevRegistry
   ```

3. Build the API image, authenticate Docker to the emitted ECR repository URI, and push it with an immutable release tag. Dev currently uses `55cdd32`. Do not use `latest`.

4. Populate the runtime secret through an approved secret-management process.

5. Bootstrap the existing dev API execution role's runtime-secret access without deploying the API:

   ```bash
   npm run cdk -- deploy VambericDevApiBootstrap --require-approval never
   ```

   This standalone stack only attaches the scoped Secrets Manager read policy to `vamberic-dev-api-execution`. It does not register a task definition, update the ECS service, or start a task.

6. Review the API change. Dev uses its configured tag by default:

   ```bash
   npm run cdk -- diff VambericDevApi
   ```

7. Deploy the API service with the same configured immutable tag:

   ```bash
   npm run cdk -- deploy VambericDevApi
   ```

The dev tag is environment-specific and stored in `config/dev.ts`; it is not embedded in the API stack. Production intentionally remains unset and will fail synthesis until a production tag is supplied with `-c imageTag=...` or `API_IMAGE_TAG=...`. Overrides are also available for dev releases. The mutable `latest` tag is rejected in every environment.

CDK dependencies are explicit: security depends on network, and API depends on network, security, observability, and registry. Deploying prerequisites separately is still required so an image can be pushed before ECS begins service stabilization.

## One-off dev API tasks

`VambericDevApi` outputs the values needed to reuse the deployed API task definition for an operator-run Fargate task:

- `ApiClusterName`
- `ApiTaskDefinitionArn`
- `ApiPrivateSubnetIds`
- `ApiTaskSecurityGroupId`
- `ApiContainerName`

Reusing this task definition preserves its ECR access, CloudWatch logging, `NODE_ENV=production`, `DEPLOYMENT_ENV=dev`, and `MONGODB_URI` injection from `vamberic/dev/api`. A container command override does not alter the API service's default command.

After deploying the infrastructure change, an authorized operator can read those outputs and run the database setup dry-run in the same private application subnets and security group:

```bash
STACK_NAME=VambericDevApi

CLUSTER_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiClusterName'].OutputValue" --output text)
TASK_DEFINITION_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiTaskDefinitionArn'].OutputValue" --output text)
SUBNET_IDS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiPrivateSubnetIds'].OutputValue" --output text)
SECURITY_GROUP_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiTaskSecurityGroupId'].OutputValue" --output text)
CONTAINER_NAME=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiContainerName'].OutputValue" --output text)

aws ecs run-task \
  --cluster "$CLUSTER_NAME" \
  --task-definition "$TASK_DEFINITION_ARN" \
  --launch-type FARGATE \
  --network-configuration \
    "awsvpcConfiguration={subnets=[$SUBNET_IDS],securityGroups=[$SECURITY_GROUP_ID],assignPublicIp=DISABLED}" \
  --overrides \
    "{\"containerOverrides\":[{\"name\":\"$CONTAINER_NAME\",\"command\":[\"node\",\"--enable-source-maps\",\"/app/dist/db-setup.mjs\",\"--dry-run\"]}]}"
```

The operator identity needs `cloudformation:DescribeStacks`, `ecs:RunTask`, and `iam:PassRole` for the API task execution and application task roles. `ecs:DescribeTasks` and CloudWatch Logs read access are useful for monitoring the result. Do not include secret values in command overrides or shell output.

## GitHub Actions deployment

Development infrastructure can be deployed manually with the **Deploy dev infrastructure** workflow in GitHub Actions. The workflow has only a `workflow_dispatch` trigger, so pushes do not deploy infrastructure automatically.

The deployment model separates development from deployment identity:

- Replit is the development environment used to edit, test, and synthesize the CDK application.
- GitHub Actions is the deployment identity. Its `dev` Environment assumes an AWS IAM role through GitHub's OpenID Connect provider.
- No long-lived AWS access keys are stored in this repository or passed to the workflow.

Configure these GitHub repository or `dev` Environment variables before running the workflow:

- `AWS_DEPLOY_ROLE_ARN` — the ARN of the AWS IAM role whose trust policy permits this repository's GitHub OIDC identity to assume it.
- `AWS_REGION` — the target AWS region, currently `eu-west-2`.

The AWS account must already be bootstrapped for CDK. After checkout and deterministic `npm ci` installation, the workflow runs the build, lint, tests, and synthesis before deploying only:

- `VambericDevNetwork`
- `VambericDevSecurity`
- `VambericDevObservability`
- `VambericDevRegistry`
- `VambericDevApi`

Deployment uses `--require-approval never` because GitHub Actions is non-interactive. The workflow does not deploy production.

## ECR retention and rollback

- Image tags are immutable, preventing an existing release tag from being overwritten.
- Images are scanned when pushed.
- Dev retains the 20 most recent tagged images.
- Prod retains the 50 most recent tagged images.
- Untagged images expire after seven days.
- The production repository is retained if its stack is removed.
- The development repository may be removed with the stack, including its images.

This keeps enough historical releases for rollback without retaining every image indefinitely. Adjust the bounded counts in `config/dev.ts` and `config/prod.ts` if release frequency changes materially.

## Cost considerations

Synthesis and tests have no AWS cost. A future deployment may incur ongoing cost from:

- NAT Gateway hourly charges and per-GB processing.
- Application Load Balancer hourly and LCU charges.
- Fargate task vCPU and memory runtime.
- ECR storage and image transfer.
- CloudWatch log ingestion and storage.
- Secrets Manager monthly secret storage and API calls.
- VPC public IPv4 address charges, including NAT Gateway Elastic IPs.
- S3 website asset storage and requests.
- CloudFront data transfer, requests, and invalidations beyond the free allowance.

The dev configuration deliberately starts with one Fargate task and one NAT Gateway, but the NAT Gateway and ALB still incur charges while deployed.
