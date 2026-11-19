# CYBRX AWS Asset Discovery

Read-only AWS inventory that writes both the full API inventory and an
application-shaped asset array.

- Node.js >= 22 (matches CYBRX / local v22.17.1)
- ESM (`"type": "module"`), same as CYBRX backend
- AWS SDK for JavaScript v3 only
- No database, no Express, no TypeScript

## What it collects

- All enabled AWS regions by default; set `AWS_REGIONS=ap-southeast-2,us-east-1`
  to restrict the scan, or `AWS_REGIONS=all` to scan all enabled regions.
- EC2 instances, EBS volumes/snapshots, VPCs, subnets, security groups, network
  ACLs, route tables, internet/NAT gateways, network interfaces, elastic IPs,
  owned AMIs, and key-pair metadata.
- RDS instances, clusters, and snapshots; Lambda function configuration;
  load balancers, listeners, target groups and attributes; DynamoDB table
  metadata and tags; ECS clusters and services.
- S3 bucket location, versioning, encryption, public-access-block settings,
  CORS, policy status, tags, lifecycle, logging, notification, ownership,
  replication, and website configuration.
- IAM users, roles, groups, customer-managed policy metadata, and account
  summary. Access keys, secret values, object contents, and Lambda environment
  variable values are not collected.

Each resource becomes a record using the outer structure in the repository's
`asset.json` sample. `properties.awsProperties` preserves the AWS resource
metadata, including tags and the original API response. The app-shaped output
is written to `aws-connectivity/asset.json`. EC2 instances are classified as
`servers/windows`, `servers/linux`, or `servers/mac`; other resources use
`cloud/aws/<resource-type>`. For now, `assetCategoryID` and
`assetSubCategoryID` are plain strings (`servers`, `cloud`, and the applicable
OS name), and `organizationID` is omitted. The full inventory and any
per-operation errors are written to `aws-connectivity/raw/`.

## Setup

```powershell
cd C:\Users\ADMIN\Documents\My-Work\Integrations\aws-connectivity
npm install
notepad .env
```

`.env` keys:

```env
AWS_REGION=ap-southeast-2
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_SESSION_TOKEN=
AWS_ROLE_ARN=
AWS_EXTERNAL_ID=
AWS_ORGANIZATION_ID=
```

`AWS_REGIONS` is optional. When omitted, the collector discovers the regions
enabled in the account. `AWS_ORGANIZATION_ID` is optional and, if supplied,
must be the 24-character MongoDB ObjectId used by the application.

## Run

```powershell
npm start
```

## Permissions

For a complete inventory, attach AWS managed `ReadOnlyAccess` to the discovery
identity (or an equivalent least-privilege policy for the listed APIs). It also
needs `sts:GetCallerIdentity`; cross-account discovery additionally needs
`sts:AssumeRole` on the target role. `ec2:DescribeRegions` is needed to discover
enabled regions automatically. Explicitly listing `AWS_REGIONS` avoids that
region-discovery call.

Cross-account trust policy (replace principal + external ID):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::<BOOTSTRAP_ACCOUNT_ID>:root" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "<EXTERNAL_ID>" } }
  }]
}
```

## Common errors

| Error | Meaning |
|---|---|
| `CredentialsProviderError` | No keys in `.env` / profile |
| `InvalidClientTokenId` | Access key invalid/disabled |
| `UnauthorizedOperation` / `AccessDenied` | A service or optional detail call is not allowed; the error is recorded in the raw inventory |
| `ENOTFOUND sts.<x>` | `AWS_REGION` is wrong (use a region, not an AZ like `-2a`) |
| `AccessDenied` on AssumeRole | Trust policy / External ID mismatch |

The scanner continues after individual service/API failures and includes them
in the raw output's `collectionErrors` array. The resulting asset file may
therefore be partial; review that array before importing it.
