# Vamberic Infrastructure

AWS CDK v2 infrastructure for the Vamberic Studio shared API runtime.

This repository is intentionally infrastructure-only. It defines the AWS resources that will eventually host the shared API, but it does not deploy anything by default and it does not connect to MongoDB Atlas.

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

Product applications and the Vamberic console will call the shared API. They must not connect directly to MongoDB Atlas.

Route 53 records, ACM certificates, MongoDB connectivity, CI/CD, queues, scheduled tasks, and agent infrastructure are intentionally out of scope for this initial project.

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

The registry is deliberately separate from the API service. This allows a new account to create the repository, receive an API image, and only then create the Fargate service.

The CDK app synthesizes `dev` by default. Select an environment with either:

```bash
DEPLOY_ENV=prod npm run synth
```

or:

```bash
npm run cdk -- synth -c environment=prod
```

Account IDs are never hard-coded. CDK uses the ambient `CDK_DEFAULT_ACCOUNT` when one is available, and otherwise synthesizes environment-agnostic templates. The region defaults to `eu-west-2` and can be overridden with `CDK_DEFAULT_REGION`.

## Prerequisites

- Node.js 20 or newer
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

Deployment is intentionally not automated or performed by this repository. A brand-new account should be brought up in stages.

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

3. Build the API image, authenticate Docker to the emitted ECR repository URI, and push it with an immutable release tag. Dev currently uses `0.1.0-8da657e`. Do not use `latest`.

4. Populate the runtime secret through an approved secret-management process.

5. Review the API change. Dev uses its configured tag by default:

   ```bash
   npm run cdk -- diff VambericDevApi
   ```

6. Deploy the API service with the same configured immutable tag:

   ```bash
   npm run cdk -- deploy VambericDevApi
   ```

The dev tag is environment-specific and stored in `config/dev.ts`; it is not embedded in the API stack. Production intentionally remains unset and will fail synthesis until a production tag is supplied with `-c imageTag=...` or `API_IMAGE_TAG=...`. Overrides are also available for dev releases. The mutable `latest` tag is rejected in every environment.

CDK dependencies are explicit: security depends on network, and API depends on network, security, observability, and registry. Deploying prerequisites separately is still required so an image can be pushed before ECS begins service stabilization.

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

The dev configuration deliberately starts with one Fargate task and one NAT Gateway, but the NAT Gateway and ALB still incur charges while deployed.
