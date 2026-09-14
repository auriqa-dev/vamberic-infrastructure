---
name: ECS secret ARN imports
description: Why ECS JSON-key secret injection must use the existing Secrets Manager secret's complete ARN.
---

For ECS task-definition secrets that select a JSON key, import the existing Secrets Manager secret with its complete AWS-generated suffixed ARN.

**Why:** A name-based CDK import synthesized a partial ARN followed by the JSON-key selector. ECS treated it as an ARN and Secrets Manager returned `ResourceNotFoundException` before container startup.

**How to apply:** Preserve `ecs.Secret.fromSecretsManager(secret, jsonKey)` and scoped `secret.grantRead(...)`, but ensure the imported `ISecret` has a complete ARN including the generated suffix. Assert the exact synthesized `ValueFrom` shape.