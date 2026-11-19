# CYBRX AWS Connectivity Probe

Single-file, minimal Node.js project to verify AWS connectivity and inspect raw
discovered data before integrating into CYBRX.

- Node.js >= 22 (matches CYBRX / local v22.17.1)
- ESM (`"type": "module"`), same as CYBRX backend
- AWS SDK for JavaScript v3 only
- No database, no Express, no TypeScript

## What it does

1. STS `GetCallerIdentity`
2. Optional STS `AssumeRole` with External ID (cross-account)
3. EC2 `DescribeInstances` + `DescribeVolumes` per region (paginated)
4. S3 `ListBuckets`
5. Prints normalized JSON

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
```

`AWS_REGIONS=ap-southeast-2,us-east-1` is optional (multi-region scan).

## Run

```powershell
npm start
```

## IAM policy for the test user / discovery role

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "ec2:DescribeInstances",
      "ec2:DescribeVolumes",
      "ec2:DescribeVpcs",
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
      "ec2:DescribeAddresses",
      "s3:ListAllMyBuckets",
      "s3:GetBucketLocation",
      "rds:DescribeDBInstances",
      "sts:GetCallerIdentity"
    ],
    "Resource": "*"
  }]
}
```

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
| `UnauthorizedOperation` | Missing read-only policy above |
| `ENOTFOUND sts.<x>` | `AWS_REGION` is wrong (use a region, not an AZ like `-2a`) |
| `AccessDenied` on AssumeRole | Trust policy / External ID mismatch |

## Next step

Reuse this discovery logic inside CYBRX `modules/cloud/services/aws/` after
implementing the Phase 1 models.
