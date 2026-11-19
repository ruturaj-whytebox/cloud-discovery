import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand
} from "@aws-sdk/client-sts";
import {
  EC2Client,
  DescribeAddressesCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeKeyPairsCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkAclsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSnapshotsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  DescribeRegionsCommand
} from "@aws-sdk/client-ec2";
import {
  S3Client,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyStatusCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketReplicationCommand,
  GetBucketWebsiteCommand,
  ListBucketsCommand
} from "@aws-sdk/client-s3";
import {
  RDSClient,
  DescribeDBClustersCommand,
  DescribeDBClusterSnapshotsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand
} from "@aws-sdk/client-rds";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import {
  ElasticLoadBalancingV2Client,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetGroupAttributesCommand
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  DynamoDBClient,
  DescribeTableCommand,
  ListTablesCommand,
  ListTagsOfResourceCommand
} from "@aws-sdk/client-dynamodb";
import {
  ECSClient,
  DescribeClustersCommand,
  DescribeServicesCommand,
  ListClustersCommand,
  ListServicesCommand
} from "@aws-sdk/client-ecs";
import {
  IAMClient,
  GetAccountSummaryCommand,
  ListGroupsCommand,
  ListPoliciesCommand,
  ListRolesCommand,
  ListUsersCommand
} from "@aws-sdk/client-iam";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const region = process.env.AWS_REGION || "ap-south-1";
const configuredRegions = (process.env.AWS_REGIONS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const roleArn = process.env.AWS_ROLE_ARN || "";
const externalId = process.env.AWS_EXTERNAL_ID || "";
const organizationId = process.env.AWS_ORGANIZATION_ID || "";

const toCreds = (credentials) =>
  credentials
    ? {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken
      }
    : undefined;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stableUuid(value) {
  const hash = sha256(value).slice(0, 32).split("");
  hash[12] = "5";
  hash[16] = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  const hex = hash.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

function getResourceId(resource, idField) {
  return resource[idField] || resource.ARN || resource.Arn ||
    resource.ResourceName || resource.Name || resource.name || "unknown";
}

function getResourceArn(resource) {
  return Object.entries(resource).find(
    ([key, value]) => /arn$/i.test(key) && typeof value === "string"
  )?.[1] || null;
}

function getResourceName(resource, nameField, tags) {
  return tags?.Name || resource[nameField] || resource.Name || resource.name || null;
}

function getAssetClassification(resourceType, resource) {
  if (resourceType !== "ec2-instance") {
    return {
      category: `cloud/aws/${resourceType}`,
      assetCategoryID: "cloud"
    };
  }

  const platform = String(resource.PlatformDetails || resource.Platform || "").toLowerCase();
  const operatingSystem = platform.includes("windows")
    ? "windows"
    : platform.includes("mac")
      ? "mac"
      : "linux";

  return {
    category: `servers/${operatingSystem}`,
    assetCategoryID: "servers",
    assetSubCategoryID: operatingSystem
  };
}

function getResourceStatus(resource) {
  const state =
    resource.State?.Name ||
    resource.State?.Code ||
    resource.State ||
    resource.Status ||
    resource.DBInstanceStatus ||
    resource.DBClusterStatus ||
    resource.TableStatus ||
    resource.FunctionState ||
    resource.status ||
    resource.state ||
    "";
  const normalized = String(state).toLowerCase();
  if (["stopped", "stopping", "deleted", "deleting", "failed", "terminated", "inactive"].includes(normalized)) {
    return "offline";
  }
  return "online";
}

export function toAssetRecord({
  account,
  region: resourceRegion,
  resourceType,
  resource,
  idField,
  nameField,
  fetchedAt,
  tags = resource.Tags || []
}) {
  const resourceId = getResourceId(resource, idField);
  const tagMap = Object.fromEntries(tags
    .map((tag) => [tag.Key ?? tag.key, tag.Value ?? tag.value])
    .filter(([key]) => key));
  const name = getResourceName(resource, nameField, tagMap);
  const stableKey = `aws:${account}:${resourceRegion || "global"}:${resourceType}:${resourceId}`;
  const oid = (field) => ({ $oid: sha256(`${stableKey}:${field}`).slice(0, 24) });
  const logicalProcessors = resource.CpuOptions
    ? (resource.CpuOptions.CoreCount || 0) * (resource.CpuOptions.ThreadsPerCore || 0)
    : null;
  const createdAt =
    resource.LaunchTime ||
    resource.CreateTime ||
    resource.CreationDate ||
    resource.CreateDate ||
    resource.createdAt ||
    fetchedAt;
  const classification = getAssetClassification(resourceType, resource);
  const organization = organizationId
    ? { $oid: organizationId }
    : undefined;
  const record = {
    _id: oid("asset"),
    uuid: stableUuid(stableKey),
    serialNo: resourceId,
    assetType: "IT Asset",
    assetName: name || resourceId,
    ...(organization ? { organizationID: organization } : {}),
    updateSource: "agentless",
    assetID: `AWS:${resourceType}:${resourceId}`,
    ...classification,
    properties: {
      commonProperties: {
        macAddress: resource.NetworkInterfaces?.[0]?.MacAddress || null,
        serialNumber: resourceId,
        hostname:
          resource.PrivateDnsName ||
          resource.DNSName ||
          resource.Endpoint?.Address ||
          name ||
          resourceId,
        alias: name || resourceId,
        ipAddress: null,
        _id: oid("commonProperties")
      },
      osProperties: resource.PlatformDetails
        ? {
            osName: resource.PlatformDetails,
            osVersion: null,
            osServicePack: null,
            osInstallDate: null,
            osInstalledBy: null,
            buildNumber: null,
            productID: null,
            lastBootUpTime: null,
            bootDevice: null,
            windowsDirectory: null,
            productKey: null,
            virtualMemory: null,
            systemDirectory: null,
            licenseStatus: null,
            _id: oid("osProperties")
          }
        : null,
      cpuProperties: resource.CpuOptions
        ? {
            cpuSpeed: null,
            logicalProcessors: String(logicalProcessors),
            cpuStepping: null,
            cpuCoresCount: String(resource.CpuOptions.CoreCount ?? ""),
            _id: oid("cpuProperties")
          }
        : null,
      biosProperties: null,
      diskProperties: [],
      monitorProperties: null,
      keyboardProperties: null,
      mouseProperties: null,
      driverDetailsProperties: [],
      processorProperties: resource.InstanceType
        ? {
            name: resource.InstanceType,
            manufacturer: null,
            numberOfCores: resource.CpuOptions?.CoreCount ?? null,
            maxClockSpeed: null,
            uUID: resourceId,
            logicalProcessors,
            _id: oid("processorProperties")
          }
        : null,
      uSBControllerProperties: [],
      baseBoardDetailProperties: null,
      printerDetailsProperties: [],
      soundCardProperties: [],
      videoCardProperties: [],
      ramProperties: null,
      awsProperties: {
        cloudProvider: "aws",
        accountId: account,
        region: resourceRegion || null,
        resourceType,
        resourceId,
        resourceArn: getResourceArn(resource),
        tags,
        data: resource
      },
      _id: oid("properties"),
      hostDiscoveryProperties: []
    },
    decom: false,
    status: getResourceStatus(resource),
    managedBy: [],
    usedBy: [],
    createdAt: { $date: new Date(createdAt).toISOString() },
    updatedAt: { $date: fetchedAt },
    __v: 0
  };
  return record;
}

async function listAll(client, Command, resultField, request = {}, tokenField = "NextToken", responseField = tokenField) {
  const items = [];
  let token;
  do {
    const response = await client.send(
      new Command({ ...request, ...(token ? { [tokenField]: token } : {}) })
    );
    items.push(...(response[resultField] || []));
    token = response[responseField];
  } while (token);
  return items;
}

async function collectSection(raw, errors, service, resourceRegion, operation) {
  try {
    return await operation();
  } catch (error) {
    const failure = {
      service,
      region: resourceRegion || null,
      name: error.name || "Error",
      message: error.message || String(error)
    };
    errors.push(failure);
    console.error(`${service}${resourceRegion ? ` (${resourceRegion})` : ""} failed: ${failure.name}: ${failure.message}`);
    return null;
  }
}

const missingBucketConfigurationErrors = new Set([
  "NoSuchBucketPolicy",
  "NoSuchCORSConfiguration",
  "NoSuchLifecycleConfiguration",
  "NoSuchPublicAccessBlockConfiguration",
  "NoSuchTagSet",
  "NoSuchWebsiteConfiguration",
  "OwnershipControlsNotFoundError",
  "ReplicationConfigurationNotFoundError",
  "ServerSideEncryptionConfigurationNotFoundError"
]);

async function getBucketConfiguration(client, bucket, key, Command, errors, resourceRegion) {
  try {
    return await client.send(new Command({ Bucket: bucket }));
  } catch (error) {
    if (missingBucketConfigurationErrors.has(error.name)) return null;
    const failure = {
      service: `s3:${bucket}:${key}`,
      region: resourceRegion,
      name: error.name || "Error",
      message: error.message || String(error)
    };
    errors.push(failure);
    console.error(`${failure.service} (${resourceRegion}) failed: ${failure.name}: ${failure.message}`);
    return null;
  }
}

function addResources({ assets, account, region: resourceRegion, resourceType, resources, idField, nameField, fetchedAt }) {
  for (const resource of resources || []) {
    assets.push(toAssetRecord({
      account,
      region: resourceRegion,
      resourceType,
      resource,
      idField,
      nameField,
      fetchedAt
    }));
  }
}

async function resolveRegions(credentials) {
  if (configuredRegions.length && configuredRegions[0].toLowerCase() !== "all") {
    return configuredRegions;
  }
  const ec2 = new EC2Client({ region, credentials: toCreds(credentials) });
  const response = await ec2.send(new DescribeRegionsCommand({ AllRegions: false }));
  ec2.destroy();
  const enabled = (response.Regions || [])
    .map((entry) => entry.RegionName)
    .filter(Boolean);
  return enabled.length ? enabled : [region];
}

async function collectEc2({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const ec2 = new EC2Client({ region: reg, credentials: toCreds(credentials) });
  const details = {};
  const collectors = [
    ["instances", "ec2-instance", DescribeInstancesCommand, "Reservations", "InstanceId", "Instance", (items) => items.flatMap((reservation) => reservation.Instances || [])],
    ["volumes", "ebs-volume", DescribeVolumesCommand, "Volumes", "VolumeId", "VolumeId"],
    ["vpcs", "ec2-vpc", DescribeVpcsCommand, "Vpcs", "VpcId", "VpcId"],
    ["subnets", "ec2-subnet", DescribeSubnetsCommand, "Subnets", "SubnetId", "SubnetId"],
    ["securityGroups", "ec2-security-group", DescribeSecurityGroupsCommand, "SecurityGroups", "GroupId", "GroupName"],
    ["networkAcls", "ec2-network-acl", DescribeNetworkAclsCommand, "NetworkAcls", "NetworkAclId", "NetworkAclId"],
    ["routeTables", "ec2-route-table", DescribeRouteTablesCommand, "RouteTables", "RouteTableId", "RouteTableId"],
    ["internetGateways", "ec2-internet-gateway", DescribeInternetGatewaysCommand, "InternetGateways", "InternetGatewayId", "InternetGatewayId"],
    ["natGateways", "ec2-nat-gateway", DescribeNatGatewaysCommand, "NatGateways", "NatGatewayId", "NatGatewayId"],
    ["networkInterfaces", "ec2-network-interface", DescribeNetworkInterfacesCommand, "NetworkInterfaces", "NetworkInterfaceId", "Description"],
    ["addresses", "ec2-elastic-ip", DescribeAddressesCommand, "Addresses", "AllocationId", "PublicIp"],
    ["snapshots", "ebs-snapshot", DescribeSnapshotsCommand, "Snapshots", "SnapshotId", "Description", (items) => items, { OwnerIds: ["self"] }],
    ["images", "ec2-image", DescribeImagesCommand, "Images", "ImageId", "Name", (items) => items, { Owners: ["self"] }],
    ["keyPairs", "ec2-key-pair", DescribeKeyPairsCommand, "KeyPairs", "KeyPairId", "KeyName"]
  ];

  for (const [key, resourceType, Command, resultField, idField, nameField, flatten = (items) => items, request = {}] of collectors) {
    const items = await collectSection(raw, errors, `ec2:${key}`, reg, async () =>
      listAll(ec2, Command, resultField, request)
    );
    details[key] = items ? flatten(items) : [];
    if (key === "instances") raw.ec2[reg] = details[key];
    if (key === "volumes") raw.ebs[reg] = details[key];
    addResources({ assets, account, region: reg, resourceType, resources: details[key], idField, nameField, fetchedAt });
  }
  raw.ec2Details[reg] = details;
  ec2.destroy();
}

async function collectRds({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const rds = new RDSClient({ region: reg, credentials: toCreds(credentials) });
  const resources = [
    ["dbInstances", "rds-instance", DescribeDBInstancesCommand, "DBInstances", "DBInstanceIdentifier"],
    ["dbClusters", "rds-cluster", DescribeDBClustersCommand, "DBClusters", "DBClusterIdentifier"],
    ["dbSnapshots", "rds-snapshot", DescribeDBSnapshotsCommand, "DBSnapshots", "DBSnapshotIdentifier"],
    ["dbClusterSnapshots", "rds-cluster-snapshot", DescribeDBClusterSnapshotsCommand, "DBClusterSnapshots", "DBClusterSnapshotIdentifier"]
  ];
  raw.rds[reg] = {};
  for (const [key, type, Command, field, idField] of resources) {
    const items = await collectSection(raw, errors, `rds:${key}`, reg, () =>
      listAll(rds, Command, field, {}, "Marker", "Marker")
    );
    raw.rds[reg][key] = items || [];
    addResources({ assets, account, region: reg, resourceType: type, resources: items, idField, nameField: idField, fetchedAt });
  }
  rds.destroy();
}

async function collectLambda({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const lambda = new LambdaClient({ region: reg, credentials: toCreds(credentials) });
  const functions = await collectSection(raw, errors, "lambda:functions", reg, () =>
    listAll(lambda, ListFunctionsCommand, "Functions", {}, "Marker", "NextMarker")
  );
  raw.lambda[reg] = (functions || []).map((fn) => ({
    ...fn,
    Environment: fn.Environment
      ? {
          ...fn.Environment,
          Variables: Object.keys(fn.Environment.Variables || {})
        }
      : undefined
  }));
  addResources({
    assets,
    account,
    region: reg,
    resourceType: "lambda-function",
    resources: raw.lambda[reg],
    idField: "FunctionArn",
    nameField: "FunctionName",
    fetchedAt
  });
  lambda.destroy();
}

async function collectS3({ credentials, raw, errors, assets, account, fetchedAt }) {
  const s3 = new S3Client({ region, credentials: toCreds(credentials) });
  const buckets = await collectSection(raw, errors, "s3:buckets", null, () =>
    listAll(s3, ListBucketsCommand, "Buckets", { MaxBuckets: 1000 }, "ContinuationToken", "NextContinuationToken")
  );
  raw.s3 = [];
  for (const bucket of buckets || []) {
    const bucketData = { ...bucket, configuration: {} };
    let bucketRegion = bucket.BucketRegion;
    if (!bucketRegion) {
      const location = await collectSection(raw, errors, `s3:${bucket.Name}:location`, null, () =>
        s3.send(new GetBucketLocationCommand({ Bucket: bucket.Name }))
      );
      const locationConstraint = location?.LocationConstraint;
      bucketRegion = location
        ? locationConstraint === "EU"
          ? "eu-west-1"
          : locationConstraint || "us-east-1"
        : null;
    }
    bucketData.BucketRegion = bucketRegion;
    const configurations = [
      ["versioning", GetBucketVersioningCommand],
      ["cors", GetBucketCorsCommand],
      ["encryption", GetBucketEncryptionCommand],
      ["publicAccessBlock", GetPublicAccessBlockCommand],
      ["policyStatus", GetBucketPolicyStatusCommand],
      ["tags", GetBucketTaggingCommand],
      ["lifecycle", GetBucketLifecycleConfigurationCommand],
      ["logging", GetBucketLoggingCommand],
      ["notifications", GetBucketNotificationConfigurationCommand],
      ["ownershipControls", GetBucketOwnershipControlsCommand],
      ["replication", GetBucketReplicationCommand],
      ["website", GetBucketWebsiteCommand]
    ];
    if (bucketRegion) {
      const regionalS3 = new S3Client({ region: bucketRegion, credentials: toCreds(credentials) });
      for (const [key, Command] of configurations) {
        bucketData.configuration[key] = await getBucketConfiguration(
          regionalS3,
          bucket.Name,
          key,
          Command,
          errors,
          bucketRegion
        );
      }
      regionalS3.destroy();
    } else {
      for (const [key] of configurations) bucketData.configuration[key] = null;
    }
    if (bucketData.configuration.tags?.TagSet) {
      bucketData.Tags = bucketData.configuration.tags.TagSet;
    }
    raw.s3.push(bucketData);
    addResources({
      assets,
      account,
      region: bucketRegion,
      resourceType: "s3-bucket",
      resources: [bucketData],
      idField: "Name",
      nameField: "Name",
      fetchedAt
    });
  }
  s3.destroy();
}

async function collectLoadBalancers({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const elb = new ElasticLoadBalancingV2Client({ region: reg, credentials: toCreds(credentials) });
  raw.loadBalancing[reg] = { loadBalancers: [], targetGroups: [] };
  const loadBalancers = await collectSection(raw, errors, "elbv2:loadBalancers", reg, () =>
    listAll(elb, DescribeLoadBalancersCommand, "LoadBalancers", {}, "Marker", "NextMarker")
  );
  for (const loadBalancer of loadBalancers || []) {
    const [listeners, attributes] = await Promise.all([
      collectSection(raw, errors, `elbv2:listeners:${loadBalancer.LoadBalancerArn}`, reg, () =>
        listAll(elb, DescribeListenersCommand, "Listeners", { LoadBalancerArn: loadBalancer.LoadBalancerArn }, "Marker", "NextMarker")
      ),
      collectSection(raw, errors, `elbv2:attributes:${loadBalancer.LoadBalancerArn}`, reg, () =>
        elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: loadBalancer.LoadBalancerArn }))
      )
    ]);
    raw.loadBalancing[reg].loadBalancers.push({
      ...loadBalancer,
      Listeners: listeners || [],
      Attributes: attributes?.Attributes || []
    });
  }
  addResources({
    assets,
    account,
    region: reg,
    resourceType: "load-balancer",
    resources: raw.loadBalancing[reg].loadBalancers,
    idField: "LoadBalancerArn",
    nameField: "LoadBalancerName",
    fetchedAt
  });
  const targetGroups = await collectSection(raw, errors, "elbv2:targetGroups", reg, () =>
    listAll(elb, DescribeTargetGroupsCommand, "TargetGroups", {}, "Marker", "NextMarker")
  );
  for (const targetGroup of targetGroups || []) {
    const attributes = await collectSection(raw, errors, `elbv2:targetGroupAttributes:${targetGroup.TargetGroupArn}`, reg, () =>
      elb.send(new DescribeTargetGroupAttributesCommand({ TargetGroupArn: targetGroup.TargetGroupArn }))
    );
    raw.loadBalancing[reg].targetGroups.push({
      ...targetGroup,
      Attributes: attributes?.Attributes || []
    });
  }
  addResources({
    assets,
    account,
    region: reg,
    resourceType: "load-balancer-target-group",
    resources: raw.loadBalancing[reg].targetGroups,
    idField: "TargetGroupArn",
    nameField: "TargetGroupName",
    fetchedAt
  });
  elb.destroy();
}

async function collectDynamoDb({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const dynamodb = new DynamoDBClient({ region: reg, credentials: toCreds(credentials) });
  raw.dynamodb[reg] = [];
  const tableNames = await collectSection(raw, errors, "dynamodb:tables", reg, () =>
    listAll(dynamodb, ListTablesCommand, "TableNames", {}, "ExclusiveStartTableName", "LastEvaluatedTableName")
  );
  for (const tableName of tableNames || []) {
    const description = await collectSection(raw, errors, `dynamodb:describe:${tableName}`, reg, () =>
      dynamodb.send(new DescribeTableCommand({ TableName: tableName }))
    );
    const tags = await collectSection(raw, errors, `dynamodb:tags:${tableName}`, reg, () =>
      description?.Table?.TableArn
        ? dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: description.Table.TableArn }))
        : Promise.resolve(null)
    );
    const resource = {
      ...(description?.Table || { TableName: tableName }),
      Tags: tags?.Tags || []
    };
    raw.dynamodb[reg].push(resource);
    addResources({
      assets,
      account,
      region: reg,
      resourceType: "dynamodb-table",
      resources: [resource],
      idField: "TableArn",
      nameField: "TableName",
      fetchedAt
    });
  }
  dynamodb.destroy();
}

async function collectEcs({ reg, credentials, raw, errors, assets, account, fetchedAt }) {
  const ecs = new ECSClient({ region: reg, credentials: toCreds(credentials) });
  raw.ecs[reg] = { clusters: [], services: [] };
  const clusterArns = await collectSection(raw, errors, "ecs:clusters", reg, () =>
    listAll(ecs, ListClustersCommand, "clusterArns", {}, "nextToken", "nextToken")
  );
  if (clusterArns?.length) {
    const clusters = await collectSection(raw, errors, "ecs:describeClusters", reg, async () => {
      const result = [];
      for (let index = 0; index < clusterArns.length; index += 100) {
        const response = await ecs.send(new DescribeClustersCommand({
          clusters: clusterArns.slice(index, index + 100),
          include: ["ATTACHMENTS", "CONFIGURATIONS", "STATISTICS", "TAGS"]
        }));
        result.push(...(response.clusters || []));
      }
      return result;
    });
    raw.ecs[reg].clusters = clusters || [];
    addResources({
      assets,
      account,
      region: reg,
      resourceType: "ecs-cluster",
      resources: raw.ecs[reg].clusters,
      idField: "clusterArn",
      nameField: "clusterName",
      fetchedAt
    });

    for (const clusterArn of clusterArns) {
      const serviceArns = await collectSection(raw, errors, `ecs:services:${clusterArn}`, reg, () =>
        listAll(ecs, ListServicesCommand, "serviceArns", { cluster: clusterArn }, "nextToken", "nextToken")
      );
      for (let index = 0; index < (serviceArns || []).length; index += 10) {
        const services = await collectSection(raw, errors, `ecs:describeServices:${clusterArn}`, reg, async () => {
          const response = await ecs.send(new DescribeServicesCommand({
            cluster: clusterArn,
            services: serviceArns.slice(index, index + 10),
            include: ["TAGS"]
          }));
          return response.services || [];
        });
        raw.ecs[reg].services.push(...(services || []));
      }
    }
  }
  addResources({
    assets,
    account,
    region: reg,
    resourceType: "ecs-service",
    resources: raw.ecs[reg].services,
    idField: "serviceArn",
    nameField: "serviceName",
    fetchedAt
  });
  ecs.destroy();
}

async function collectIam({ credentials, raw, errors, assets, account, fetchedAt }) {
  const iam = new IAMClient({ region: "us-east-1", credentials: toCreds(credentials) });
  raw.iam = {};
  const collections = [
    ["users", "iam-user", ListUsersCommand, "Users", "UserName", "UserName"],
    ["roles", "iam-role", ListRolesCommand, "Roles", "RoleName", "RoleName"],
    ["groups", "iam-group", ListGroupsCommand, "Groups", "GroupName", "GroupName"],
    ["customerManagedPolicies", "iam-policy", ListPoliciesCommand, "Policies", "Arn", "PolicyName"]
  ];
  for (const [key, type, Command, field, idField, nameField] of collections) {
    const request = key === "customerManagedPolicies" ? { Scope: "Local" } : {};
    const items = await collectSection(raw, errors, `iam:${key}`, null, () =>
      listAll(iam, Command, field, request, "Marker", "Marker")
    );
    raw.iam[key] = items || [];
    addResources({ assets, account, region: null, resourceType: type, resources: items, idField, nameField, fetchedAt });
  }
  raw.iam.accountSummary = await collectSection(raw, errors, "iam:accountSummary", null, async () =>
    (await iam.send(new GetAccountSummaryCommand({}))).SummaryMap || {}
  );
  iam.destroy();
}

async function main() {
  if (organizationId && !/^[a-f\d]{24}$/i.test(organizationId)) {
    throw new Error("AWS_ORGANIZATION_ID must be a 24-character MongoDB ObjectId.");
  }
  console.log(`AWS discovery region: ${region}`);
  const sts = new STSClient({ region });
  const baseIdentity = await sts.send(new GetCallerIdentityCommand({}));
  sts.destroy();
  console.log("Base identity:", baseIdentity.Account, baseIdentity.Arn);

  let credentials;
  if (roleArn) {
    const assumeSts = new STSClient({ region });
    const response = await assumeSts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "cybrx-aws-discovery",
      ExternalId: externalId || undefined
    }));
    assumeSts.destroy();
    credentials = response.Credentials;
    if (!credentials) throw new Error("AssumeRole returned no credentials.");
    console.log("Assumed role:", roleArn, "| expires:", credentials?.Expiration?.toISOString());
  }

  let identity = baseIdentity;
  if (credentials) {
    const activeSts = new STSClient({ region, credentials: toCreds(credentials) });
    identity = await activeSts.send(new GetCallerIdentityCommand({}));
    activeSts.destroy();
  }
  console.log("Scanning account:", identity.Account, identity.Arn);
  const regions = await resolveRegions(credentials);
  console.log("Scanning regions:", regions.join(", "));
  const fetchedAt = new Date().toISOString();
  const errors = [];
  const raw = {
    fetchedAt,
    account: identity.Account,
    identityArn: identity.Arn,
    sourceIdentityArn: baseIdentity.Arn,
    assumedRole: roleArn || null,
    regions,
    collectionErrors: errors,
    ec2: {},
    ebs: {},
    ec2Details: {},
    rds: {},
    lambda: {},
    s3: [],
    loadBalancing: {},
    dynamodb: {},
    ecs: {},
    iam: {}
  };
  const assets = [];

  for (const reg of regions) {
    await collectEc2({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
    await collectRds({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
    await collectLambda({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
    await collectLoadBalancers({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
    await collectDynamoDb({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
    await collectEcs({ reg, credentials, raw, errors, assets, account: identity.Account, fetchedAt });
  }
  await collectS3({ credentials, raw, errors, assets, account: identity.Account, fetchedAt });
  await collectIam({ credentials, raw, errors, assets, account: identity.Account, fetchedAt });

  const stamp = fetchedAt.replace(/[:.]/g, "-");
  const rawDir = path.join(scriptDir, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, `aws-raw-${stamp}.json`), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(rawDir, "aws-raw-latest.json"), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(scriptDir, "asset.json"), JSON.stringify(assets, null, 2));
  console.log(`\nCollected ${assets.length} AWS assets with ${errors.length} collection error(s).`);
  console.log("Application asset file: aws-connectivity/asset.json");
  console.log("Raw AWS data: aws-connectivity/raw/aws-raw-latest.json");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`FATAL: ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}
