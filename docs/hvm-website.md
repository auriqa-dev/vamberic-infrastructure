# HVM production website

This repository defines independent static hosting for **Henry Vincent Moss Agency**, canonical URL `https://h-v-m.agency`. The React/Vite site source remains in `auriqa-dev/henry-vincent-moss`. No website files or deployment workflow are changed here. No deployment has been performed.

## Stacks and certificate handoff

- `VambericProdHvmCertificate` in `us-east-1`: a dedicated retained ACM certificate for `h-v-m.agency` and `www.h-v-m.agency`, using external DNS validation. It does not reuse the Vamberic certificate.
- `VambericProdHvmWebsite` in `eu-west-2`: its own retained private S3 bucket, CloudFront OAC/distribution, canonical redirect function and GitHub deployment role.

The existing Vamberic website imports an already-issued certificate; it does not create a certificate stack. HVM follows that import pattern, with a separate certificate stack to provision its new certificate first. Supply the issued ARN using the required CloudFormation parameter `HvmCertificateArn`. This explicit cross-region handoff avoids cross-region custom resources and dependencies on existing stacks. Do not deploy all stacks together; DNS validation must finish first. Both stacks are included in the normal CDK assembly regardless of the API environment selection.

The certificate must belong to the hosting AWS account, be in `us-east-1`, be `ISSUED`, and cover both aliases. The parameter rejects ARNs outside `us-east-1`; the operator must verify ownership and domain coverage. No fabricated certificate ARN or CloudFront target is configured.

## Hosting and deployment permissions

The bucket blocks all public access, uses S3-managed AES256 encryption, denies non-TLS access and has no S3 website endpoint. CloudFront reads it using signed OAC requests scoped to this distribution. The bucket is retained on deletion/replacement. CloudFront has both domain aliases, redirects HTTP to HTTPS, enables compression, serves `index.html` by default, and maps origin 403/404 responses to `/index.html` with status 200 and zero error-cache TTL for SPA routes. As with existing hosting, this fallback also applies to missing asset paths.

A viewer-request CloudFront function sends `www.h-v-m.agency` requests to `https://h-v-m.agency` with a permanent 301, preserving the path and query parameters, including repeated and percent-encoded values. Apex requests pass through. No public redirect bucket is needed.

The existing account GitHub OIDC provider is imported, not recreated. Read-only GitHub API checks on 2026-09-19 returned:

- Repository: `auriqa-dev/henry-vincent-moss`, ID `1376972156`.
- Owner ID: `209590030`.
- OIDC configuration: `use_default=true`, `use_immutable_subject=true`, prefix `repo:auriqa-dev@209590030/henry-vincent-moss@1376972156`.

The trust policy requires audience `sts.amazonaws.com` and exactly:

```text
repo:auriqa-dev@209590030/henry-vincent-moss@1376972156:environment:hvm-prod
```

No repository ID is outstanding. The website workflow must use GitHub Environment `hvm-prod`, with appropriate branch restrictions/review protection, and `permissions: { contents: read, id-token: write }`. It assumes the output role ARN through OIDC; no long-lived AWS keys are needed. Configure that workflow separately in the website repository when authorised. The role grants only `s3:ListBucket` on the HVM bucket, `s3:GetObject/PutObject/DeleteObject` on its objects, and `cloudfront:CreateInvalidation/GetInvalidation` on the HVM distribution. It cannot deploy infrastructure or access Vamberic resources or secrets.

Build the website with its existing Vite configuration and publish its `dist/` contents to the output bucket. Upload hashed assets with long immutable caching and entry HTML with revalidation/no-cache, then invalidate changed paths (or `/*`). No secrets belong in the static build. The existing public enquiry endpoint remains:

```text
https://api.vamberic.com/api/v1/public/products/product_01m2wffbf3p9p19d3nd1s2fp3x/enquiries
```

API/CORS is already deployed. This change makes no API, Cognito or CORS updates.

## Outputs

| Stack | Output | Use |
| --- | --- | --- |
| Certificate | `HvmCertificateArn` | Input to the hosting stack after issuance |
| Certificate | `HvmCertificateValidationDomains` | Domains whose exact CNAMEs must be retrieved from ACM |
| Website | `HvmBucketName` | Asset upload target |
| Website | `HvmDistributionId` | Cache invalidations |
| Website | `HvmDistributionDomainName` | DNS routing target |
| Website | `HvmDeploymentRoleArn` | GitHub OIDC role |
| Website | `HvmCertificateArnOutput` | Certificate used by CloudFront |

All outputs are non-secret. ACM validation CNAME tokens are allocated when the certificate is requested; CloudFormation does not expose their values as certificate attributes. Stack outputs will not be available until validation finishes, so use ACM or the certificate resource's physical ID during the pending deployment.

## Operator-controlled deployment and Namecheap DNS sequence

These are future operator steps, not actions performed by this change. Use credentials for the intended AWS account and confirm bootstrap readiness for `us-east-1` and `eu-west-2`. Keep existing Vamberic resources out of deployment commands.

1. Confirm where `h-v-m.agency` DNS is authoritative. Namecheap Advanced DNS records apply when using Namecheap BasicDNS, FreeDNS or PremiumDNS. If another provider is authoritative, apply equivalent records there; do not change nameservers casually or disturb mail records.
2. Deploy only the certificate stack:

   ```sh
   AWS_REGION=eu-west-2 AWS_DEFAULT_REGION=eu-west-2 npm run cdk -- deploy VambericProdHvmCertificate --exclusively
   ```

   DNS validation with external DNS keeps this operation pending. In another terminal, find the certificate ARN in the ACM `us-east-1` console or from the CloudFormation resource:

   ```sh
   aws cloudformation list-stack-resources --region us-east-1 \
     --stack-name VambericProdHvmCertificate \
     --query "StackResourceSummaries[?ResourceType=='AWS::CertificateManager::Certificate'].PhysicalResourceId" \
     --output text
   ```

3. Using that actual ARN, retrieve the exact records:

   ```sh
   aws acm describe-certificate --region us-east-1 --certificate-arn "$HVM_CERTIFICATE_ARN" \
     --query 'Certificate.{Status:Status,Validation:DomainValidationOptions[].{Domain:DomainName,Record:ResourceRecord}}'
   ```

   In Namecheap Advanced DNS, create every distinct ACM validation record:

   | Type | Host | Value | TTL |
   | --- | --- | --- | --- |
   | CNAME | ACM `ResourceRecord.Name` minus the trailing `.h-v-m.agency.` (typically `_token`) | Exact ACM `ResourceRecord.Value` (`_token.acm-validations.aws.`) | Automatic |
   | CNAME | Same transformation for the www validation record (typically `_token.www`) | Exact value returned for that record | Automatic |

   The `_token` notation is descriptive, not a value to enter. Do not append the zone twice in Namecheap's Host field. Use the actual ACM results, deduplicating only identical records. Keep these records for certificate renewal. If existing CAA records restrict issuance, ensure they permit Amazon certificate issuance.
4. Wait for ACM `ISSUED` and certificate stack completion. Record its `HvmCertificateArn` output. Deploy only HVM hosting using that ARN:

   ```sh
   AWS_REGION=eu-west-2 AWS_DEFAULT_REGION=eu-west-2 npm run cdk -- deploy VambericProdHvmWebsite --exclusively \
     --parameters "VambericProdHvmWebsite:HvmCertificateArn=$HVM_CERTIFICATE_ARN"
   ```

5. Record the website outputs. Configure/protect GitHub Environment `hvm-prod` and its deployment workflow separately, upload the built site, and wait for CloudFront status `Deployed`. Verify the distribution serves the build before routing public traffic.
6. Add these exact record types/hosts, substituting the **actual** `HvmDistributionDomainName` output (hostname only, no scheme or path):

   | Type | Host | Value | TTL |
   | --- | --- | --- | --- |
   | ALIAS | `@` | `HvmDistributionDomainName` output | Automatic |
   | CNAME | `www` | Same `HvmDistributionDomainName` output | Automatic |

   The ALIAS flattens the apex to CloudFront; do not use a root CNAME or hardcoded CloudFront IPs. Replace conflicting web-routing A/AAAA/CNAME/ALIAS/URL Redirect records only at these two hosts. Preserve MX, TXT and ACM validation records. HTTPS www redirection happens in CloudFront, so do not use Namecheap URL forwarding.
7. After propagation, verify HTTPS apex, HTTP-to-HTTPS, www-to-apex with a deep path/query, SPA deep links and asset loading, and a public enquiry submission. The existing API allowlist covers the apex origin; www redirects before serving the app.

Before deployment, the remaining operational inputs are DNS access/provider confirmation, the issued certificate ARN, AWS account/bootstrap/provider readiness, and a protected `hvm-prod` Environment/workflow. Final ACM CNAME values and CloudFront target become available only during deployment. No architecture decision or repository ID remains unresolved.

## Validation and references

Run `npm run build`, `npm run lint`, `npm test`, `AWS_REGION=eu-west-2 AWS_DEFAULT_REGION=eu-west-2 npm run synth`, and `git diff --check`. The HVM tests check isolation, the existing production website baseline, certificate, bucket/OAC, least-privilege OIDC and redirect behaviour. Existing API/Vapp/auth tests remain in place.

- [Namecheap ALIAS records and supported DNS services](https://www.namecheap.com/support/knowledgebase/article.aspx/10128/2237/how-to-create-an-alias-record/)
- [ACM DNS validation and renewal records](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
- [CloudFormation certificate validation with external DNS](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-certificatemanager-certificate.html)
- [GitHub immutable OIDC subject format](https://docs.github.com/en/actions/reference/security/oidc)
- [CloudFront Functions query-string handling](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html)
