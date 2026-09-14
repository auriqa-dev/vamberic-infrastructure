---
name: ECS execution-policy ordering
description: Ensuring execution-role permissions exist before ECS registers and launches a replacement task definition.
---

When an ECS execution role receives startup-critical permissions through a CDK grant, make the generated CloudFormation task-definition resource depend on the role’s concrete policy resource.

**Why:** The final synthesized policy was correctly scoped and attached, but CloudFormation could register the replacement task definition and launch service tasks before the lazily generated default policy completed. Adding a dependency to the L2 task-definition construct or the grant itself did not synthesize `DependsOn`.

**How to apply:** After the grant creates the role’s default policy, locate that concrete policy construct and add it as a dependency of the underlying `CfnTaskDefinition`. Assert the policy’s role attachment, resource scope, and the task definition’s synthesized `DependsOn`.