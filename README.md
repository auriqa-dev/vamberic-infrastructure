# Vamberic Infrastructure

AWS CDK v2 infrastructure for the Vamberic Studio shared API runtime.

This repository is intentionally infrastructure-only. It defines the AWS resources that will eventually host the shared API, but it does not deploy anything by default and it does not connect to MongoDB Atlas.

## Architecture

The initial architecture is designed for separate `dev` and `prod` environments in `eu-west-2`:

- A VPC with public subnets for the load balancer and private application subnets for ECS tasks.
- A NAT Gateway with an AWS-managed Elastic IP for predictable outbound traffic to MongoDB Atlas.
- An ECS cluster running a Fargate service behind a public Application Load Balancer.
- An ECR repository for the API container image.
- Separate task execution and application task IAM roles with least-privilege defaults.
- A Secrets Manager secret reserved for runtime application configuration.
- A CloudWatch log group with environment-specific retention.
- An ALB health check at `/health`.

Product applications and the Vamberic console will call the shared API. They must not connect directly to MongoDB Atlas.

Route 53 records, ACM certificates, MongoDB connectivity, CI/CD, queues, scheduled tasks, and agent infrastructure are intentionally out of scope for this initial project.

## Environments

Environment configuration lives in `config/`:

- `config/dev.ts` — one low-cost Fargate task and one NAT Gateway.
- `config/prod.ts` — two initial Fargate tasks and two NAT Gateways for higher availability.

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

## Future deployment process

Deployment is intentionally not configured yet. Before the first deployment:

1. Confirm the target AWS account and region.
2. Bootstrap CDK in the target account and region.
3. Build and publish the API image to the environment's ECR repository.
4. Populate the runtime secret through an approved secret-management process.
5. Review `cdk diff` for the selected environment.
6. Deploy only after an explicit change review.
7. Add Route 53 and ACM resources separately when the API domain is ready.

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
