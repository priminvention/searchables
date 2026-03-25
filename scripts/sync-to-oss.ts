/**
 * Upload local files to Aliyun OSS under the "desktop/" prefix.
 *
 * Usage:
 *   bun scripts/sync-to-oss.ts <directory>
 *
 * Required env vars:
 *   OSS_ACCESS_KEY_ID     - Aliyun OSS access key
 *   OSS_ACCESS_KEY_SECRET - Aliyun OSS secret key
 *   OSS_BUCKET_NAME       - OSS bucket name
 *   OSS_ENDPOINT          - OSS endpoint (e.g. oss-ap-southeast-1.aliyuncs.com)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const OSS_PREFIX = 'desktop';
const MAX_RETRIES = 3;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const OSS_ACCESS_KEY_ID = requireEnv('OSS_ACCESS_KEY_ID');
const OSS_ACCESS_KEY_SECRET = requireEnv('OSS_ACCESS_KEY_SECRET');
const OSS_BUCKET_NAME = requireEnv('OSS_BUCKET_NAME');
const OSS_ENDPOINT = requireEnv('OSS_ENDPOINT');

function createClient(): S3Client {
  return new S3Client({
    region: OSS_ENDPOINT.split('.')[0],
    endpoint: `https://${OSS_ENDPOINT}`,
    credentials: {
      accessKeyId: OSS_ACCESS_KEY_ID,
      secretAccessKey: OSS_ACCESS_KEY_SECRET,
    },
    // OSS does not support chunked encoding; send content-length instead
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

async function uploadFile(
  client: S3Client,
  filePath: string,
  objectKey: string,
): Promise<void> {
  const buffer = readFileSync(filePath);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: OSS_BUCKET_NAME,
          Key: objectKey,
          Body: buffer,
          ContentLength: buffer.length,
        }),
      );
      return;
    } catch (error) {
      const message = (error as Error).message;

      if (attempt < MAX_RETRIES) {
        const delay = attempt * 3000;
        console.log(`  [${basename(filePath)}] Attempt ${attempt} failed: ${message}`);
        console.log(`  [${basename(filePath)}] Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw new Error(
        `[${basename(filePath)}] Failed after ${MAX_RETRIES} attempts: ${message}`,
      );
    }
  }
}

async function main() {
  const dir = process.argv[2];

  if (!dir) {
    console.error('Usage: bun scripts/sync-to-oss.ts <directory>');
    process.exit(1);
  }

  const files = readdirSync(dir)
    .map((name) => ({ name, path: join(dir, name) }))
    .filter((f) => statSync(f.path).isFile());

  if (files.length === 0) {
    console.log('No files to upload.');
    return;
  }

  console.log(`Uploading ${files.length} files to OSS (${OSS_BUCKET_NAME}/${OSS_PREFIX}/):`);
  for (const f of files) {
    const sizeMB = (statSync(f.path).size / 1024 / 1024).toFixed(1);
    console.log(`  ${f.name} (${sizeMB} MB)`);
  }

  const client = createClient();

  // Upload sequentially to avoid memory pressure with large files
  for (const f of files) {
    const objectKey = `${OSS_PREFIX}/${f.name}`;
    const sizeMB = (statSync(f.path).size / 1024 / 1024).toFixed(1);

    console.log(`\nUploading ${f.name} (${sizeMB} MB) -> ${objectKey}`);
    await uploadFile(client, f.path, objectKey);
    console.log(`Done: ${f.name}`);
  }

  console.log(`\nSync complete: ${files.length} files uploaded.`);
}

main();
