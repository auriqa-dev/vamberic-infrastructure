---
name: ECS execution-policy ordering
description: Ensuring execution-role permissions exist before ECS registers and launches a replacement task definition.
---

When an ECS execution role receives startup-critical permissions through a CDK grant, make the generated CloudFormation task-definition resource depend on the role’s concrete policy resource.

**Why:** The final synthesized policy was correctly scoped and attached, but CloudFormation could register the replacement task definition and launch service tasks before the lazily generated default policy completed. Adding a dependency to the L2 task-definition construct or the grant itself did not synthesize `DependsOn`.

**How to apply:** After the grant creates the role’s default policy, locate that concrete policy construct and add it as a dependency of the underlying `CfnTaskDefinition`. Assert the policy’s role attachment, resource scope, and the task definition’s synthesized `DependsOn`.

For a new startup-critical permission on an existing ECS execution role, establish the permission in a separate bootstrap stack before updating the service-owning stack.

**Why:** When one CloudFormation update both adds the permission and rolls the service, an immediate ECS startup failure can trigger the deployment circuit breaker and roll the permission back with the service.

**How to apply:** Import the named role and exact resource into an account-pinned bootstrap stack that owns only the scoped policy. Keep it dependency-free from the API stack and deploy it alone before the API rollout.