import "dotenv/config";
import fs from "node:fs";
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { S3Client, ListBucketsCommand } from "@aws-sdk/client-s3";

const region = process.env.AWS_REGION || "ap-south-1";
const regions = (process.env.AWS_REGIONS || region).split(",").map((r) => r.trim()).filter(Boolean);
const roleArn = process.env.AWS_ROLE_ARN || "";
const externalId = process.env.AWS_EXTERNAL_ID || "";

const toCreds = (c) =>
  c
    ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken }
    : undefined;

async function getIdentity() {
  const sts = new STSClient({ region });
  return sts.send(new GetCallerIdentityCommand({}));
}

async function assumeRole() {
  const sts = new STSClient({ region });
  const res = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "cybrx-connectivity-test",
      ExternalId: externalId || undefined
    })
  );
  return res.Credentials;
}

async function listInstances(ec2, reg, rawSink) {
  const out = [];
  let token;
  do {
    const res = await ec2.send(new DescribeInstancesCommand({ NextToken: token }));
    for (const r of res.Reservations || []) {
      for (const i of r.Instances || []) {
        rawSink?.push(i);
        const tags = Object.fromEntries((i.Tags || []).map((t) => [t.Key, t.Value]));
        out.push({
          resourceID: i.InstanceId,
          name: tags.Name || null,
          state: i.State?.Name || null,
          instanceType: i.InstanceType || null,
          privateIp: i.PrivateIpAddress || null,
          publicIp: i.PublicIpAddress || null,
          platform: i.Platform || null,
          platformDetails: i.PlatformDetails || null,
          launchTime: i.LaunchTime?.toISOString() || null,
          region: reg,
          availabilityZone: i.Placement?.AvailabilityZone || null,
          vpcId: i.VpcId || null,
          subnetId: i.SubnetId || null,
          tags
        });
      }
    }
    token = res.NextToken;
  } while (token);
  return out;
} 

async function listVolumes(ec2, reg, rawSink) {
  const out = [];
  let token;
  do {
    const res = await ec2.send(new DescribeVolumesCommand({ NextToken: token }));
    for (const v of res.Volumes || []) {
      rawSink?.push(v);
      const tags = Object.fromEntries((v.Tags || []).map((t) => [t.Key, t.Value]));
      out.push({
        resourceID: v.VolumeId,
        name: tags.Name || null,
        state: v.State || null,
        sizeGiB: v.Size || null,
        volumeType: v.VolumeType || null,
        encrypted: v.Encrypted ?? null,
        region: reg,
        availabilityZone: v.AvailabilityZone || null,
        attachments: (v.Attachments || []).map((a) => ({ instanceId: a.InstanceId, device: a.Device })),
        tags
      });
    }
    token = res.NextToken;
  } while (token);
  return out;
}

async function listBuckets(reg, credentials, rawSink) {
  const s3 = new S3Client({ region: reg, credentials: toCreds(credentials) });
  const res = await s3.send(new ListBucketsCommand({}));
  rawSink?.push(...(res.Buckets || []));
  return (res.Buckets || []).map((b) => ({
    resourceID: b.Name,
    name: b.Name,
    creationDate: b.CreationDate?.toISOString() || null
  }));
}

async function main() {
  console.log("Region:", region, "| Regions:", regions);

  const identity = await getIdentity();
  console.log("Base identity:", identity.Account, identity.Arn);

  let credentials;
  if (roleArn) {
    credentials = await assumeRole();
    console.log("Assumed role:", roleArn, "| expires:", credentials.Expiration?.toISOString());
  }

  const instances = [];
  const volumes = [];
  const buckets = [];

  const raw = {
    fetchedAt: new Date().toISOString(),
    account: identity.Account,
    identityArn: identity.Arn,
    assumedRole: roleArn || null,
    regions,
    ec2: {},
    ebs: {},
    s3: []
  };

  for (const reg of regions) {
    const ec2 = new EC2Client({ region: reg, credentials: toCreds(credentials) });
    raw.ec2[reg] = [];
    raw.ebs[reg] = [];

    try {
      const found = await listInstances(ec2, reg, raw.ec2[reg]);
      instances.push(...found);
      console.log(`${reg}: ${found.length} instance(s)`);
    } catch (err) {
      console.error(`${reg}: DescribeInstances failed -> ${err.name}: ${err.message}`);
    }

    try {
      const found = await listVolumes(ec2, reg, raw.ebs[reg]);
      volumes.push(...found);
      console.log(`${reg}: ${found.length} volume(s)`);
    } catch (err) {
      console.error(`${reg}: DescribeVolumes failed -> ${err.name}: ${err.message}`);
    }
  }

  try {
    buckets.push(...(await listBuckets(region, credentials, raw.s3)));
    console.log(`S3: ${buckets.length} bucket(s)`);
  } catch (err) {
    console.error(`S3 failed -> ${err.name}: ${err.message}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.mkdirSync("raw", { recursive: true });
  fs.writeFileSync(`raw/aws-raw-${stamp}.json`, JSON.stringify(raw, null, 2));
  fs.writeFileSync("raw/aws-raw-latest.json", JSON.stringify(raw, null, 2));
  console.log("\nRaw AWS JSON saved: raw/aws-raw-latest.json");

  console.log("\nEC2 instances:\n" + JSON.stringify(instances, null, 2));
  console.log("\nEBS volumes:\n" + JSON.stringify(volumes, null, 2));
  console.log("\nS3 buckets:\n" + JSON.stringify(buckets, null, 2));
}

main().catch((err) => {
  console.error(`FATAL: ${err.name}: ${err.message}`);
  process.exitCode = 1;
});
