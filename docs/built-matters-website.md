# Built Matters public marketing hosting

This is separate production infrastructure for the existing Vite/prerender site in `auriqa-dev/built-matters`. Account: `755905325223`. Canonical origin: `https://built-matters.com`. The Built Matters repository, its build settings, and all app/API resources are unchanged. `app.built-matters.com` is deliberately absent from aliases, certificates, DNS outputs and role trust.

## Existing pattern and stacks

The Vamberic and HVM websites use private, retained S3 buckets behind CloudFront Origin Access Control (OAC), with ACM certificates in `us-east-1`. HVM also uses a dedicated GitHub OIDC deployment role and a CloudFront canonical-domain redirect. Built Matters follows those controls and the HVM staged certificate-ARN handoff.

- `VambericProdBuiltMattersCertificate`: `us-east-1`, dedicated retained DNS-validated ACM certificate.
- `VambericProdBuiltMattersWebsite`: `eu-west-2`, its own bucket, CloudFront distribution/OAC, routing function, cache policy and deployment role. The required `BuiltMattersCertificateArn` parameter imports the issued certificate; it has no default and accepts only account `755905325223` in `us-east-1`.

Both stacks always synthesize, independent of ambient CLI region or API environment selection. No Route 53 hosted zone or DNS resource is assumed. There is no automatic cross-region certificate dependency: complete external validation before supplying the ARN to the website stack.

`lib/static-site-resources.ts` shares the established HVM private-bucket and deployment-role implementation. HVM keeps its existing construct paths/logical IDs, properties and outputs. No existing website distribution, certificate, policy or API configuration is changed.

## Security, routing and caching

The bucket blocks all public access, uses S3-managed AES256 encryption, denies non-TLS access, has no S3 website endpoint, and is retained on deletion/replacement. CloudFront uses the S3 REST origin with signed OAC requests; the bucket grants reads only to that distribution. Viewers are redirected from HTTP to HTTPS; minimum TLS is 1.2 and compression is enabled.

Inspection of `package.json`, `vite.config.ts`, `scripts/prerender.mjs` and `src/App.tsx` found that `npm run build` creates `dist/` with prerendered route directories, `404.html`, hashed assets and legacy redirect pages. The production build uses the `.com` canonical origin; preview builds are not intended for indexing. The infrastructure does not build the site or change its settings.

The viewer-request function first redirects these hosts with a permanent 301 to `https://built-matters.com`, preserving URI and query values (including repeated and percent-encoded parameters):

- `www.built-matters.com`
- `built-matters.co.uk`
- `www.built-matters.co.uk`

For canonical-host requests, `/` maps to `/index.html`, `/energy/` and `/energy` map to `/energy/index.html`, and other extensionless paths receive the same directory-index treatment. Asset/file paths are unchanged. Existing generated legacy redirect pages remain usable. This preserves page-specific prerendered HTML and metadata instead of serving the homepage as a blanket SPA fallback.

Missing S3 objects may return 403 or 404; both map to `/404.html` with an HTTP **404** response and zero configured error-cache TTL. Deployments must include `dist/404.html`. Missing assets do not receive a 200 homepage response. The cache policy has minimum TTL 0, default 300 seconds and maximum 365 days, with gzip/Brotli variants; it honours object Cache-Control for HTML revalidation and immutable hashed assets. Query strings/cookies are not part of the origin cache key; the build is static and campaign queries are retained in browser URLs and redirects.

## GitHub deployment preparation

HVM's existing `.github/workflows/deploy-prod.yml` uses manual dispatch, an environment-scoped GitHub OIDC role, `npm ci`, `npm run build`, `aws s3 sync dist/ ... --delete`, and a CloudFront invalidation. Built Matters can use the same model later, with its own outputs and environment. No workflow or repository was modified here.

Read-only GitHub API verification on 2026-09-28 returned owner ID `209590030`, repository ID `1383211665`, `use_default=true`, and `use_immutable_subject=true`. The new role trusts only the existing account OIDC provider, audience `sts.amazonaws.com`, and this subject:

```text
repo:auriqa-dev@209590030/built-matters@1383211665:environment:built-matters-prod
```

Prepare a protected GitHub Environment named `built-matters-prod` with the intended production branch restrictions. A future workflow needs `contents: read`, `id-token: write`, the output role ARN, region `eu-west-2`, and Node 20 matching the site's current engine range (`>=20.19.0 <21`). Use `npm ci` and **`npm run build`**, not the preview build. Verify `dist/index.html`, `dist/energy/index.html` and `dist/404.html` before publishing. Publish only `dist/`, not source files or `.prerender/`.

Permissions are only `s3:ListBucket` on this bucket; `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` on its objects; and `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` on this distribution. No new OIDC provider, access keys, administrator privileges or access to HVM/Vamberic buckets is created. Existing role trusts are unchanged.

For later deployment tooling, use short/revalidating HTML caching and long immutable caching only for content-hashed assets. A simple initial publication can use `aws s3 sync dist/ "s3://$BUILT_MATTERS_BUCKET" --delete --cache-control 'public,max-age=300'`, then upload `dist/assets/` with `public,max-age=31536000,immutable` and HTML with `no-cache` using `aws s3 cp --recursive` and appropriate include/exclude filters. Unlike sync, copying ensures metadata changes apply to existing keys. Invalidate `/*` after publication and wait for completion using the output distribution ID. These are future website deployment steps, not actions executed by this infrastructure task.

## Outputs

| Stack | Output | Purpose |
| --- | --- | --- |
| Certificate | `BuiltMattersCertificateArn` | Issued ARN to pass to hosting |
| Certificate | `BuiltMattersCertificateValidationDomains` | All four names requiring DNS validation |
| Website | `BuiltMattersBucketName` | `dist/` upload target |
| Website | `BuiltMattersDistributionId` | Invalidation target |
| Website | `BuiltMattersDistributionDomainName` | Actual CloudFront DNS hostname |
| Website | `BuiltMattersDeploymentRoleArn` | GitHub OIDC role ARN |
| Website | `BuiltMattersCertificateArnOutput` | Certificate used by hosting |
| Website | `BuiltMattersDnsRecords` | Both zones' ALIAS/CNAME routing records with deployed target |

ACM generates validation tokens only when the certificate is requested. CloudFormation does not expose those CNAMEs as certificate attributes, and certificate-stack outputs are unavailable while validation is pending. Retrieve the actual ARN via the certificate resource's physical ID, then use `acm describe-certificate` as below. No validation token or final CloudFront hostname is fabricated.

## Future operator deployment sequence — not run by this task

1. Confirm access to account `755905325223`, CDK bootstrap readiness in `us-east-1` and `eu-west-2`, and authoritative DNS control of **both** domains. Confirm the existing GitHub OIDC provider. Keep application and unrelated website stacks out of these deployment commands.

2. Deploy only the certificate stack:

   ```sh
   npm run cdk -- deploy VambericProdBuiltMattersCertificate --exclusively --profile vamberic-admin
   ```

   While the operation waits for DNS validation, use another terminal (or ACM console in `us-east-1`):

   ```sh
   aws cloudformation list-stack-resources --profile vamberic-admin --region us-east-1 \
     --stack-name VambericProdBuiltMattersCertificate \
     --query "StackResourceSummaries[?ResourceType=='AWS::CertificateManager::Certificate'].PhysicalResourceId" --output text
   ```

   Set `BUILT_MATTERS_CERTIFICATE_ARN` to that actual ARN, then retrieve every validation record:

   ```sh
   aws acm describe-certificate --profile vamberic-admin --region us-east-1 \
     --certificate-arn "$BUILT_MATTERS_CERTIFICATE_ARN" \
     --query 'Certificate.{Status:Status,Validation:DomainValidationOptions[].{Domain:DomainName,Record:ResourceRecord}}'
   ```

3. In Namecheap Advanced DNS, add the actual ACM CNAME records in the corresponding zone. Namecheap's Host field is relative to the zone:

   | Validated name | Namecheap zone | Type | Host field | Value |
   | --- | --- | --- | --- | --- |
   | `built-matters.com` | `built-matters.com` | CNAME | ACM Name minus `.built-matters.com.`; typically `_token` | Exact ACM Value |
   | `www.built-matters.com` | `built-matters.com` | CNAME | Same suffix removal; typically `_token.www` | Exact ACM Value |
   | `built-matters.co.uk` | `built-matters.co.uk` | CNAME | ACM Name minus `.built-matters.co.uk.`; typically `_token` | Exact ACM Value |
   | `www.built-matters.co.uk` | `built-matters.co.uk` | CNAME | Same suffix removal; typically `_token.www` | Exact ACM Value |

   `_token` is notation, not a value to enter. Use the actual returned name/value, do not duplicate the zone suffix, and deduplicate only identical records. Use Automatic TTL. Leave validation records in place for renewal. All four names must validate; routing traffic to `.co.uk` can wait, but its certificate validation cannot. If existing CAA records restrict issuance, ensure they permit Amazon certificate issuance.

4. Wait for certificate `ISSUED` and stack completion, then deploy only hosting:

   ```sh
   npm run cdk -- deploy VambericProdBuiltMattersWebsite --exclusively --profile vamberic-admin \
     --parameters "VambericProdBuiltMattersWebsite:BuiltMattersCertificateArn=$BUILT_MATTERS_CERTIFICATE_ARN"
   ```

5. Record the outputs, upload the production build through the future GitHub workflow or an authorised local identity, and wait for CloudFront `Deployed`. Verify the CloudFront hostname serves the expected pages, assets and 404 before routing public traffic.

6. Add these Namecheap routing records, with the actual `BuiltMattersDistributionDomainName` output as the target (hostname only; no scheme/path):

   | Zone | Type | Host | Value | TTL |
   | --- | --- | --- | --- | --- |
   | `built-matters.com` | ALIAS | `@` | CloudFront hostname output | 5 minutes |
   | `built-matters.com` | CNAME | `www` | Same hostname | Automatic |
   | `built-matters.co.uk` | ALIAS | `@` | Same hostname | 5 minutes |
   | `built-matters.co.uk` | CNAME | `www` | Same hostname | Automatic |

   Namecheap ALIAS supports apex routing on BasicDNS/FreeDNS/PremiumDNS. If authoritative nameservers are elsewhere, add equivalent records at that provider instead. Replace conflicting web-routing records at these hosts only; preserve mail/TXT/ACM records. Do not use an apex CNAME, fixed CloudFront IPs, or Namecheap URL forwarding. The HTTPS redirects are handled by CloudFront with the certificate covering all aliases. Do not add `app` records.

7. Check apex HTTPS, HTTP-to-HTTPS, all three alias redirects (deep paths and queries), `/energy/` and `/energy`, static assets, `/robots.txt`, sitemap, legacy route pages and genuine 404 responses. Confirm production metadata/canonical URLs are `.com`. No API/CORS change is part of this task; any future live enquiry integration must be validated separately.

## Validation and references

Use `npm run build`, `npm run lint`, `npm test`, `npm run synth`, and `git diff --check`. New routing/security tests and existing HVM/website regression tests cover the shared helpers and stack isolation. Individual new stacks can be synthesized without certificate issuance:

```sh
npm run synth -- VambericProdBuiltMattersCertificate --exclusively
npm run synth -- VambericProdBuiltMattersWebsite --exclusively
```

- [Namecheap ALIAS setup and DNS service support](https://www.namecheap.com/support/knowledgebase/article.aspx/10128/2237/how-to-create-an-alias-record/)
- [CloudFront directory-index rewriting](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/example_cloudfront_functions_url_rewrite_single_page_apps_section.html)
- [ACM manual DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
