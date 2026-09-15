---
name: CDK synth region input
description: How to keep local CDK synthesis aligned with the configured AWS region.
---

When synthesizing this project for development, set `AWS_REGION` and `AWS_DEFAULT_REGION` to `eu-west-2` when the shell's AWS default differs.

**Why:** The CDK CLI recalculates `CDK_DEFAULT_REGION` for its child process from the AWS SDK environment, so setting only `CDK_DEFAULT_REGION` can still produce an environment mismatch.

**How to apply:** For dev synthesis in an environment with another AWS default, run the existing synth command with both AWS SDK region variables set to `eu-west-2`; do not weaken the stack's ARN/environment validation.