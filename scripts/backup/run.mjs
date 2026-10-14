#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertProductionGuard, createManifest, downloadStorageObject, encryptBufferToFile, encryptReadableToFile,
  listBuckets, listStorageObjects, loadKey, mapLimit, notifyFailure, runCommandToEncryptedFile,
  redact, safeBackupId, sha256, uploadS3, withJobLock, writeJson,
} from "./lib.mjs";

const mode = process.argv.includes("--production") ? "production" : "synthetic";
const backupId = safeBackupId();
const key = loadKey();
const workRoot = process.env.BACKUP_WORK_ROOT || join(tmpdir(), "transport-platform-encrypted-backups");
const lockPath = process.env.BACKUP_LOCK_PATH || join(workRoot, ".backup.lock");
let activeDir = null;

async function productionBackup() {
  assertProductionGuard();
  for (const name of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!process.env[name]) throw new Error(`${name} is required`);
  const dir = join(workRoot, backupId);
  activeDir = dir;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const pgEnv = { PGHOST: process.env.PGHOST, PGPORT: process.env.PGPORT, PGDATABASE: process.env.PGDATABASE, PGUSER: process.env.PGUSER, PGPASSWORD: process.env.PGPASSWORD, PGSSLMODE: process.env.PGSSLMODE || "require" };
  const database = [];
  const dumpPath = join(dir, "database.dump.enc");
  database.push({ name: "database.dump.enc", kind: "postgres-custom-with-owners-and-acls", ...(await runCommandToEncryptedFile(process.env.PG_DUMP_PATH || "pg_dump", ["--format=custom", "--serializable-deferrable"], { env: pgEnv, target: dumpPath, key, aad: `${backupId}:database.dump` })) });
  const rolesPath = join(dir, "roles.sql.enc");
  database.push({ name: "roles.sql.enc", kind: "postgres-globals-no-passwords", ...(await runCommandToEncryptedFile(process.env.PG_DUMPALL_PATH || "pg_dumpall", ["--globals-only", "--no-role-passwords"], { env: pgEnv, target: rolesPath, key, aad: `${backupId}:roles.sql` })) });

  const buckets = await listBuckets({ baseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
  const allObjects = [];
  for (const bucket of buckets) allObjects.push(...await listStorageObjects({ baseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, bucket: bucket.id, pageSize: Number(process.env.BACKUP_STORAGE_PAGE_SIZE || 100) }));
  const privateIndex = [];
  const storage = await mapLimit(allObjects, Number(process.env.BACKUP_DOWNLOAD_CONCURRENCY || 2), async (item, index) => {
    const pathHash = sha256(`${item.bucket}/${item.name}`);
    const artifact = `objects/${pathHash}.enc`;
    const readable = await downloadStorageObject({ baseUrl: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY, bucket: item.bucket, name: item.name });
    const result = await encryptReadableToFile(readable, join(dir, artifact), key, `${backupId}:storage-object:${index}`);
    privateIndex[index] = { bucket: item.bucket, name: item.name, metadata: item.metadata, created_at: item.created_at, updated_at: item.updated_at, artifact, plaintext_sha256: result.plaintext_sha256 };
    return { bucket: item.bucket, path_hash: sha256(item.name), artifact, ...result };
  });
  const indexResult = await encryptBufferToFile(Buffer.from(JSON.stringify(privateIndex)), join(dir, "storage-index.json.enc"), key, `${backupId}:storage-index`);
  const manifest = createManifest({ backupId, database, storage, destination: { type: "s3" }, verification: { status: "verified_before_upload", checked_at: new Date().toISOString(), checks: ["database_export_complete", "storage_downloads_complete", "checksums_recorded"] } });
  manifest.private_index = { artifact: "storage-index.json.enc", ciphertext_sha256: indexResult.ciphertext_sha256 };
  await writeJson(join(dir, "manifest.json"), manifest);
  const prefix = `${String(process.env.BACKUP_S3_PREFIX || "transport-platform").replace(/^\/+|\/+$/g, "")}/${backupId}`;
  for (const artifact of [...database.map(x => x.name), ...storage.map(x => x.artifact), "storage-index.json.enc", "manifest.json"]) await uploadS3(join(dir, artifact), `${prefix}/${artifact}`);
  const result = { backup_id: backupId, status: "uploaded_and_verified", database_encrypted_bytes: manifest.database.encrypted_size, storage_encrypted_bytes: manifest.storage.encrypted_size, object_count: manifest.storage.object_count };
  await fs.rm(dir, { recursive: true, force: true });
  activeDir = null;
  return result;
}

try {
  const result = await withJobLock(lockPath, async () => {
    if (mode !== "production") throw new Error("Use npm run backup:test for synthetic backup and recovery validation");
    return productionBackup();
  });
  console.log(JSON.stringify(result));
} catch (error) {
  if (activeDir) await fs.rm(activeDir, { recursive: true, force: true }).catch(() => {});
  await notifyFailure(error).catch(() => {});
  console.error(JSON.stringify({ status: "failed", error: redact(error.message) }));
  process.exitCode = 1;
}
