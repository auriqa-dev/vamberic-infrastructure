# Platform API and Vapp dev release prerequisites

CDK owns the API task definition, ECS service, networking, roles, secrets injection, runtime configuration and website infrastructure. The application release workflow in `auriqa-dev/vamberic-platform-api` owns the value of the **`ApiImageTag` CloudFormation parameter** on `VambericDevApi`. No application SHA is pinned in dev config.

## Image parameter and retention

`ApiStack` creates a String parameter named `ApiImageTag` for dev, with no default and `AllowedPattern: [a-f0-9]{7,40}`. Its only reference is the final tag component of the `api` container image. Short legacy hexadecimal commit tags are accepted for bootstrap; the application workflow enforces full 40-character SHAs for routine releases. `latest` is rejected. The ECR repository remains immutable.

Dev ignores `API_IMAGE_TAG`, `-c imageTag`, and any legacy constructor image argument. Production keeps the existing explicit image resolution behaviour. The image parameter is not used by runtime environment variables, CPU, networking, or other resources.

CDK retains previous CloudFormation parameter values by default. Later infrastructure deployments must omit the `ApiImageTag` override and retain `--previous-parameters true`; the manual infrastructure workflow now states that flag explicitly. Do not use `--previous-parameters false`. A new stack or the first migration requires an explicit tag because there is deliberately no default.

The application workflow creates an `app-*` UPDATE change set using `--use-previous-template`, sets only `ApiImageTag`, and supplies `UsePreviousValue: true` for every other stack parameter. It validates that the only changes are the API image/task revision and the existing service task reference. It never runs CDK or uploads a replacement template. Schedule infrastructure changes outside application releases. IAM stack scoping does not enforce the workflow's image-only rule: main protection, workflow review and protected GitHub Environments are still required.

## Verified live bootstrap evidence (2026-09-23)

Read-only inspection with `vamberic-admin` confirmed account `755905325223`, region `eu-west-2`:

- ECS service has one completed deployment, task definition `vamberic-dev-api:21`.
- CloudFormation's `ApiTaskDefinition51EA709E` physical ID matches revision `21`; no task-revision drift was observed.
- Running task `9a86b8c0101e42a28d2cc95f00201c65` is RUNNING and its API container is HEALTHY.
- Image is `755905325223.dkr.ecr.eu-west-2.amazonaws.com/vamberic-dev-api:5f15a3e`.
- Running container and ECR tag share digest `sha256:121bd2d04889c2cd212eee9d5c98b82450017958efb45c8d29fe01b9d5f36b5f`.

Thus the verified bootstrap value at inspection is **`5f15a3e`**, superseding the older `a830200`. This is recorded evidence, not a new configuration default. Recheck immediately before rollout; do not deploy a stale recorded tag over a newer release.

## Deployment roles

`VambericDevApiDeploymentPermissions` is a separate, dependency-free stack in account `755905325223`, `eu-west-2`. It attaches the inline policy `VambericDevApiRelease` to the existing **`VambericGitHubApiDeployRole`**, without recreating/importing ownership of the role or changing its trust. Live trust was verified as audience `sts.amazonaws.com` and exactly:

```text
repo:auriqa-dev@209590030/vamberic-platform-api@1362482756:environment:dev
```

The new policy permits:

- CloudFormation `DescribeStacks`, `GetTemplate`, `DescribeStackResource` on `arn:aws:cloudformation:eu-west-2:755905325223:stack/VambericDevApi/*`.
- `CreateChangeSet`, `DescribeChangeSet`, `ExecuteChangeSet`, `DeleteChangeSet` on that same stack, with `cloudformation:ChangeSetName` matching `app-*`.
- ECS `DescribeServices` on the exact dev API service and `DescribeTasks` on tasks in its cluster.
- ECS `ListTasks` with `Resource: *` and `ecs:cluster` restricted to the dev API cluster; `DescribeTaskDefinition` with `Resource: *` because this action has no resource-level IAM support.
- `iam:PassRole` for only `vamberic-dev-api-task` and `vamberic-dev-api-execution`, with `iam:PassedToService = ecs-tasks.amazonaws.com`.

No direct ECS update/register permission, CloudFormation create/delete/update-stack action, IAM administration, or AdministratorAccess is added to GitHub. Existing ECR permissions are untouched, including the live `AmazonEC2ContainerRegistryPowerUser` attachment. The workflow uses its current ECR repository; this change does not narrow that pre-existing managed policy.

**Required legacy-policy removal:** live inspection found `AmazonECS_FullAccess` attached to the GitHub API role. Adding the scoped inline policy does not cancel its broad permissions. The role is externally owned; this CDK stack does not manage its existing policy attachments. After the new inline policy is installed, an operator must detach `AmazonECS_FullAccess` using the command below before enabling releases. This is a required rollout prerequisite, not an optional hardening suggestion. Do not detach the ECR policy.

The deployed API stack already uses `arn:aws:iam::755905325223:role/cdk-hnb659fds-cfn-exec-role-755905325223-eu-west-2`. The workflow omits `--role-arn` and reuses that association, so it needs no new PassRole grant to the CloudFormation role. CloudFormation performs ECS mutations under its existing execution role. Live inspection found the standard bootstrap role's existing `AdministratorAccess` attachment; it is unchanged and is not attached to GitHub. Restricting bootstrap execution permissions is separate work. This explains why permission to execute this stack's change sets must remain protected even though the GitHub role itself has no AdministratorAccess.

Vapp keeps its existing role/trust, bucket actions and distribution scope. Only `cloudfront:GetInvalidation` is added alongside `CreateInvalidation`, allowing the application's invalidation waiter to complete. HVM and the production website are unchanged.

## Exact one-time operator rollout

Nothing in this task deploys, changes live IAM, commits, pushes, or modifies platform-api. The following commands are future operator actions. Pause application releases during bootstrap and have the infrastructure change available in the checkout to deploy.

1. Renew `vamberic-admin` if needed and verify the account and running state:

   ```sh
   aws sts get-caller-identity --profile vamberic-admin
   aws ecs describe-services --profile vamberic-admin --region eu-west-2 \
     --cluster vamberic-dev-api --services vamberic-dev-api \
     --query 'services[0].{taskDefinition:taskDefinition,deployments:deployments,desired:desiredCount,running:runningCount,pending:pendingCount}'
   aws cloudformation describe-stack-resource --profile vamberic-admin --region eu-west-2 \
     --stack-name VambericDevApi --logical-resource-id ApiTaskDefinition51EA709E
   aws ecs describe-task-definition --profile vamberic-admin --region eu-west-2 \
     --task-definition vamberic-dev-api:21 \
     --query 'taskDefinition.containerDefinitions[?name==`api`].image'
   aws ecs list-tasks --profile vamberic-admin --region eu-west-2 \
     --cluster vamberic-dev-api --service-name vamberic-dev-api
   ```

   Use the service's actual revision if it has advanced. Describe every returned running task to verify its image/digest; compare with `aws ecr describe-images --repository-name vamberic-dev-api --image-ids imageTag=<verified-tag> --profile vamberic-admin --region eu-west-2`. Stop if ECS and CloudFormation disagree, a rollout is active, or the running digest does not match ECR. Do not infer the tag from this repository's old source pin.

2. Run build/lint/tests/synth and inspect the infrastructure diff. Confirm the API differs only in image parameterization, the new permissions stack contains only the inline policy/output, and Vapp differs only by `GetInvalidation`. Review live drift separately; synthesis comparisons do not prove the deployed template has no other differences.

   ```sh
   npm run build
   npm run lint
   npm test
   npm run synth
   git diff --check
   npm run cdk -- diff VambericDevApiDeploymentPermissions VambericDevApi VambericDevVapp \
     --profile vamberic-admin
   ```

3. Install the new scoped policy on the existing GitHub role:

   ```sh
   npm run cdk -- deploy VambericDevApiDeploymentPermissions --exclusively \
     --profile vamberic-admin
   aws iam get-role-policy --profile vamberic-admin \
     --role-name VambericGitHubApiDeployRole --policy-name VambericDevApiRelease
   ```

4. Remove the legacy broad ECS attachment, preserving the ECR attachment and trust:

   ```sh
   aws iam detach-role-policy --profile vamberic-admin \
     --role-name VambericGitHubApiDeployRole \
     --policy-arn arn:aws:iam::aws:policy/AmazonECS_FullAccess
   aws iam list-attached-role-policies --profile vamberic-admin \
     --role-name VambericGitHubApiDeployRole
   ```

   Verify only the previously existing ECR managed policy remains and the new inline policy is present. Do not enable releases while the broad ECS policy is still attached.

5. Bootstrap the image parameter with the freshly verified running tag. At this task's inspection it was `5f15a3e`:

   ```sh
   npm run cdk -- deploy VambericDevApi --exclusively --profile vamberic-admin \
     --previous-parameters true --parameters VambericDevApi:ApiImageTag=5f15a3e
   ```

   Substitute a later tag only if step 1 verified it. This registers a replacement task revision using the same image and preserves the service/configuration. Wait for CloudFormation/ECS stability, verify the stored parameter and CloudFormation execution role, and check `/health` and `/ready`.

6. Deploy the Vapp waiter permission:

   ```sh
   npm run cdk -- deploy VambericDevVapp --exclusively --profile vamberic-admin
   ```

7. Confirm GitHub `dev` and `vapp` Environments restrict deployment to reviewed `main`, and that the application workflow uses the existing role ARNs. Enable/run the application release workflow only after all prerequisites above are complete. Verify its image-only change set, ECS digest and health/readiness, followed by Vapp sync and invalidation completion. Future infrastructure updates omit the image override:

   ```sh
   npm run cdk -- deploy VambericDevApi --exclusively --profile vamberic-admin \
     --previous-parameters true
   ```

Do not restore a static dev tag after an application release. Rollbacks should use an explicitly reviewed, still-present immutable ECR tag through the same CloudFormation parameter path, preserving other parameter values.

## References

- [CDK deployment parameter retention](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-deploy.html)
- [CloudFormation change-set parameters and existing execution roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_CreateChangeSet.html)
- [CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [ECS IAM examples and task-definition scope limitations](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security_iam_id-based-policy-examples.html)
