import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

export const FORMAT = "transport-platform-backup/v1";
export const MAGIC = Buffer.from("TPB1");
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const ALGORITHM = "AES-256-GCM";

export function loadKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  if (!value) throw new Error("BACKUP_ENCRYPTION_KEY is required");
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function safeBackupId(now = new Date()) {
  return `tpf-${now.toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${randomBytes(6).toString("hex")}`;
}

class HashPass extends Transform {
  constructor(hash) { super(); this.hash = hash; }
  _transform(chunk, _encoding, done) { this.hash.update(chunk); done(null, chunk); }
}

export async function encryptReadableToFile(readable, target, key, aad) {
  await fs.mkdir(dirname(target), { recursive: true });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const plainHash = createHash("sha256");
  const out = createWriteStream(target, { mode: 0o600 });
  out.write(MAGIC);
  out.write(iv);
  await pipeline(readable, new HashPass(plainHash), cipher, out);
  await fs.appendFile(target, cipher.getAuthTag(), { mode: 0o600 });
  const plaintextSha = plainHash.digest("hex");
  const verification = await verifyEncryptedFile(target, key, aad);
  if (verification.plaintext_sha256 !== plaintextSha) throw new Error("Encrypted artifact verification checksum mismatch");
  return {
    plaintext_sha256: plaintextSha,
    ciphertext_sha256: await sha256File(target),
    encrypted_size: (await fs.stat(target)).size,
    encryption_verified: true,
  };
}

export async function encryptBufferToFile(buffer, target, key, aad) {
  return encryptReadableToFile(Readable.from(buffer), target, key, aad);
}

export async function decryptFileToFile(source, target, key, aad) {
  const handle = await fs.open(source, "r");
  const stat = await handle.stat();
  if (stat.size < MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error("Encrypted artifact is truncated");
  const prefix = Buffer.alloc(MAGIC.length + IV_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  await handle.read(prefix, 0, prefix.length, 0);
  await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES);
  await handle.close();
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Encrypted artifact format is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, prefix.subarray(MAGIC.length));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  await fs.mkdir(dirname(target), { recursive: true });
  await pipeline(
    createReadStream(source, { start: prefix.length, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    createWriteStream(target, { mode: 0o600 }),
  );
  return { plaintext_sha256: await sha256File(target), size: (await fs.stat(target)).size };
}

export async function verifyEncryptedFile(source, key, aad) {
  const handle = await fs.open(source, "r");
  const stat = await handle.stat();
  if (stat.size < MAGIC.length + IV_BYTES + TAG_BYTES) { await handle.close(); throw new Error("Encrypted artifact is truncated"); }
  const prefix = Buffer.alloc(MAGIC.length + IV_BYTES), tag = Buffer.alloc(TAG_BYTES);
  await handle.read(prefix, 0, prefix.length, 0); await handle.read(tag, 0, tag.length, stat.size - TAG_BYTES); await handle.close();
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Encrypted artifact format is invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, prefix.subarray(MAGIC.length));
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
  const hash = createHash("sha256");
  const sink = new Writable({ write(chunk, _encoding, done) { hash.update(chunk); done(); } });
  await pipeline(createReadStream(source, { start: prefix.length, end: stat.size - TAG_BYTES - 1 }), decipher, sink);
  return { plaintext_sha256: hash.digest("hex"), encryption_verified: true };
}

export function redact(text) {
  return String(text ?? "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, "$1[REDACTED]@")
    .replace(/(authorization|apikey|token|secret|password|key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 1000);
}

export async function withJobLock(lockPath, work) {
  await fs.mkdir(dirname(lockPath), { recursive: true });
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error("A backup job is already running"); throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); return await work(); }
  finally { await handle.close(); await fs.unlink(lockPath).catch(() => {}); }
}

export async function retry(work, { attempts = 3, baseDelayMs = 50, onRetry = () => {} } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await work(attempt); }
    catch (error) {
      last = error;
      if (attempt === attempts) break;
      onRetry({ attempt, error: redact(error.message) });
      await new Promise(resolve => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw last;
}

export async function listStorageObjects({ baseUrl, serviceKey, bucket, pageSize = 100, fetchImpl = fetch }) {
  if (!baseUrl || !serviceKey) throw new Error("Supabase Storage credentials are required");
  const objects = [];
  const prefixes = [""];
  while (prefixes.length) {
    const prefix = prefixes.shift();
    let offset = 0;
    for (;;) {
      const response = await fetchImpl(`${baseUrl}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" },
        body: JSON.stringify({ prefix, limit: pageSize, offset, sortBy: { column: "name", order: "asc" } }),
      });
      if (!response.ok) throw new Error(`Storage listing failed (${response.status})`);
      const page = await response.json();
      for (const item of page) {
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id == null) prefixes.push(name);
        else objects.push({ bucket, name, id: item.id, metadata: item.metadata || {}, created_at: item.created_at || null, updated_at: item.updated_at || null });
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }
  return objects;
}

export async function listBuckets({ baseUrl, serviceKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${baseUrl}/storage/v1/bucket`, { headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey } });
  if (!response.ok) throw new Error(`Bucket listing failed (${response.status})`);
  return response.json();
}

export async function downloadStorageObject({ baseUrl, serviceKey, bucket, name, fetchImpl = fetch, attempts = 3 }) {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return retry(async () => {
    const response = await fetchImpl(`${baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path}`, {
      headers: { authorization: `Bearer ${serviceKey}`, apikey: serviceKey },
    });
    if (!response.ok) throw new Error(`Storage download failed (${response.status})`);
    return Readable.fromWeb(response.body);
  }, { attempts });
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() { for (;;) { const i = cursor++; if (i >= items.length) return; results[i] = await mapper(items[i], i); } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return results;
}

export function assertPlatformAuthority(env = process.env) {
  if (env.BACKUP_PLATFORM_AUTHORITY !== "verified_super_admin") throw new Error("Verified platform-level backup authority is required");
}

export function assertProductionGuard(env = process.env) {
  assertPlatformAuthority(env);
  if (env.BACKUP_PRODUCTION_CONFIRMATION !== "EXPORT PRODUCTION TO APPROVED DESTINATION") throw new Error("Explicit production backup confirmation is required");
  if (env.BACKUP_DESTINATION !== "s3") throw new Error("Production backups require an approved external S3 destination");
}

export function createManifest({ backupId, createdAt = new Date().toISOString(), database = [], storage = [], destination = {}, verification = {} }) {
  return {
    format: FORMAT,
    backup_id: backupId,
    created_at: createdAt,
    encryption: { algorithm: ALGORITHM, key_reference: "external-secret-manager", secrets_in_manifest: false },
    database: { artifacts: database, encrypted_size: database.reduce((n, x) => n + Number(x.encrypted_size || 0), 0) },
    storage: { object_count: storage.length, encrypted_size: storage.reduce((n, x) => n + Number(x.encrypted_size || 0), 0), aggregate_checksum: sha256(storage.map(x => `${x.bucket}:${x.path_hash}:${x.plaintext_sha256}`).sort().join("\n")) },
    destination: { type: destination.type || "unknown", versioning_required: true, object_lock_recommended: true },
    verification: { status: verification.status || "pending", checked_at: verification.checked_at || null, checks: verification.checks || [] },
  };
}

export function verifyManifest(manifest) {
  const errors = [];
  if (manifest?.format !== FORMAT) errors.push("format");
  if (!manifest?.backup_id) errors.push("backup_id");
  if (!manifest?.created_at || Number.isNaN(Date.parse(manifest.created_at))) errors.push("created_at");
  if (manifest?.encryption?.algorithm !== ALGORITHM) errors.push("encryption");
  if (!Array.isArray(manifest?.database?.artifacts)) errors.push("database.artifacts");
  if (!Number.isInteger(manifest?.storage?.object_count)) errors.push("storage.object_count");
  return { ok: errors.length === 0, errors };
}

export function backupAgeStatus(manifest, { now = Date.now(), maximumAgeHours = 30 } = {}) {
  if (!manifest) return { ok: false, reason: "missing_backup" };
  const created = Date.parse(manifest.created_at);
  if (!Number.isFinite(created)) return { ok: false, reason: "invalid_timestamp" };
  const ageHours = (now - created) / 3_600_000;
  return { ok: ageHours <= maximumAgeHours, reason: ageHours <= maximumAgeHours ? "current" : "stale_backup", age_hours: Math.round(ageHours * 100) / 100 };
}

export function buildSystemHealthStatus(manifests, env = process.env, now = Date.now()) {
  assertPlatformAuthority(env);
  const ordered = [...manifests].sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  const success = ordered.find(x => String(x.verification?.status || "").startsWith("verified"));
  const failed = ordered.find(x => x.verification?.status === "failed");
  const age = backupAgeStatus(success, { now, maximumAgeHours: Number(env.BACKUP_MAXIMUM_AGE_HOURS || 30) });
  return {
    last_successful_backup: success?.created_at || null,
    last_failed_backup: failed?.created_at || null,
    database_backup_age_hours: age.age_hours ?? null,
    storage_backup_age_hours: age.age_hours ?? null,
    backup_size: success ? Number(success.database?.encrypted_size || 0) + Number(success.storage?.encrypted_size || 0) : null,
    destination_status: success ? "configured" : "unverified",
    integrity_verification_status: success?.verification?.status || "never_verified",
    recovery_test_status: env.BACKUP_RECOVERY_TEST_STATUS || "synthetic_only",
    retention_policy: env.BACKUP_RETENTION_POLICY || "not_approved",
    warning: age.ok ? null : age.reason,
  };
}

export async function runCommandToEncryptedFile(command, args, { env, target, key, aad }) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  const completion = new Promise((resolve, reject) => child.once("error", reject).once("close", code => code === 0 ? resolve() : reject(new Error(`${basename(command)} failed: ${redact(stderr)}`))));
  const encrypted = encryptReadableToFile(child.stdout, target, key, aad);
  await completion;
  return encrypted;
}

export async function uploadS3(file, keyName, env = process.env, spawnImpl = spawn) {
  for (const name of ["BACKUP_S3_BUCKET", "AWS_REGION"]) if (!env[name]) throw new Error(`${name} is required`);
  const args = ["s3api", "put-object", "--bucket", env.BACKUP_S3_BUCKET, "--key", keyName, "--body", file, "--checksum-algorithm", "SHA256"];
  if (env.BACKUP_S3_ENDPOINT) args.push("--endpoint-url", env.BACKUP_S3_ENDPOINT);
  const execute = commandArgs => retry(() => new Promise((resolve, reject) => {
    const child = spawnImpl(env.AWS_CLI_PATH || "aws", commandArgs, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", value => { stderr += value; });
    child.once("error", reject).once("close", code => code === 0 ? resolve() : reject(new Error(`Destination authentication/upload failed: ${redact(stderr)}`)));
  }), { attempts: Number(env.BACKUP_UPLOAD_ATTEMPTS || 3), baseDelayMs: Number(env.BACKUP_UPLOAD_RETRY_DELAY_MS || 250) });
  await execute(args);
  const head = ["s3api", "head-object", "--bucket", env.BACKUP_S3_BUCKET, "--key", keyName];
  if (env.BACKUP_S3_ENDPOINT) head.push("--endpoint-url", env.BACKUP_S3_ENDPOINT);
  await execute(head);
}

export async function notifyFailure(error, env = process.env, fetchImpl = fetch) {
  if (!env.BACKUP_FAILURE_WEBHOOK_URL) return { sent: false, reason: "not_configured" };
  const response = await fetchImpl(env.BACKUP_FAILURE_WEBHOOK_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "transport-platform-backup", status: "failed", occurred_at: new Date().toISOString(), error: redact(error.message) }),
  });
  if (!response.ok) throw new Error(`Failure notification failed (${response.status})`);
  return { sent: true };
}

export async function writeJson(path, value) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readJson(path) { return JSON.parse(await fs.readFile(path, "utf8")); }

export async function syntheticBackup({ root, key, backupId = safeBackupId(), now = new Date() }) {
  const dir = join(root, backupId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const sql = `create role synthetic_app nologin;\ncreate table companies(id uuid primary key, company_code text unique);\ncreate table bookings(id uuid primary key, company_id uuid references companies(id), reference text);\nalter table bookings enable row level security;\ncreate policy booking_tenant on bookings using (company_id::text = current_setting('app.company_id', true));\ninsert into companies values ('00000000-0000-0000-0000-000000000001','SYNTH');\ninsert into bookings values ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','SYNTH-001');\n`;
  const dbPath = join(dir, "database.sql.enc");
  const db = await encryptBufferToFile(Buffer.from(sql), dbPath, key, `${backupId}:database.sql`);
  const objectData = Buffer.from("synthetic receipt content");
  const objectPath = join(dir, "objects", `${sha256("synthetic-private/tenant/receipt.txt")}.enc`);
  const object = await encryptBufferToFile(objectData, objectPath, key, `${backupId}:storage-object:0`);
  const index = [{ bucket: "synthetic-private", name: "tenant/receipt.txt", mime_type: "text/plain", size: objectData.length, plaintext_sha256: object.plaintext_sha256, artifact: `objects/${basename(objectPath)}` }];
  const indexPath = join(dir, "storage-index.json.enc");
  const indexArtifact = await encryptBufferToFile(Buffer.from(JSON.stringify(index)), indexPath, key, `${backupId}:storage-index`);
  const storageEntry = { bucket: "synthetic-private", path_hash: sha256(index[0].name), plaintext_sha256: object.plaintext_sha256, encrypted_size: object.encrypted_size, artifact: index[0].artifact };
  const manifest = createManifest({ backupId, createdAt: now.toISOString(), database: [{ name: "database.sql.enc", kind: "synthetic-logical-sql", ...db }], storage: [storageEntry], destination: { type: "synthetic-local" }, verification: { status: "pending" } });
  manifest.private_index = { artifact: "storage-index.json.enc", ciphertext_sha256: indexArtifact.ciphertext_sha256 };
  await writeJson(join(dir, "manifest.json"), manifest);
  return { backupId, dir, manifest };
}

export async function syntheticRestore({ backupDir, restoreDir, key }) {
  const started = performance.now();
  const manifest = await readJson(join(backupDir, "manifest.json"));
  const check = verifyManifest(manifest);
  if (!check.ok) throw new Error(`Manifest invalid: ${check.errors.join(", ")}`);
  const backupId = manifest.backup_id;
  const dbTarget = join(restoreDir, "database.sql");
  const dbResult = await decryptFileToFile(join(backupDir, "database.sql.enc"), dbTarget, key, `${backupId}:database.sql`);
  const sql = await fs.readFile(dbTarget, "utf8");
  for (const required of ["create table companies", "create table bookings", "references companies", "enable row level security", "create policy", "SYNTH-001"]) if (!sql.toLowerCase().includes(required.toLowerCase())) throw new Error(`Synthetic database restore incomplete: ${required}`);
  const indexPath = join(restoreDir, "storage-index.json");
  await decryptFileToFile(join(backupDir, manifest.private_index.artifact), indexPath, key, `${backupId}:storage-index`);
  const index = await readJson(indexPath);
  for (let i = 0; i < index.length; i += 1) {
    const item = index[i];
    const target = join(restoreDir, "storage", item.bucket, item.name);
    const result = await decryptFileToFile(join(backupDir, item.artifact), target, key, `${backupId}:storage-object:${i}`);
    if (result.plaintext_sha256 !== item.plaintext_sha256) throw new Error("Synthetic storage checksum mismatch");
  }
  return { status: "synthetic_restore_passed", duration_ms: Math.round((performance.now() - started) * 100) / 100, database_sha256: dbResult.plaintext_sha256, object_count: index.length, limitation: "Logical fixture validation only; no PostgreSQL engine or production data used" };
}
