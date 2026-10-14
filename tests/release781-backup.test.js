import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  assertPlatformAuthority, backupAgeStatus, buildSystemHealthStatus, createManifest, decryptFileToFile, downloadStorageObject,
  encryptBufferToFile, listStorageObjects, loadKey, notifyFailure, redact, retry, safeBackupId,
  syntheticBackup, syntheticRestore, uploadS3, verifyManifest, withJobLock,
} from "../scripts/backup/lib.mjs";

async function temp(testContext) {
  const path = await mkdtemp(join(tmpdir(), "release781-test-"));
  testContext.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const key = Buffer.alloc(32, 7);

test("backup encryption is authenticated and secrets never enter the manifest", async t => {
  const root = await temp(t), encrypted = join(root, "data.enc"), restored = join(root, "data.txt");
  const result = await encryptBufferToFile(Buffer.from("synthetic confidential data"), encrypted, key, "backup:data");
  assert.equal(result.plaintext_sha256.length, 64);
  await decryptFileToFile(encrypted, restored, key, "backup:data");
  assert.equal(await readFile(restored, "utf8"), "synthetic confidential data");
  const bytes = await readFile(encrypted); bytes[20] ^= 1; await writeFile(encrypted, bytes);
  await assert.rejects(decryptFileToFile(encrypted, restored, key, "backup:data"));
  const manifest = createManifest({ backupId: safeBackupId(), database: [], storage: [] });
  assert.equal(manifest.encryption.algorithm, "AES-256-GCM");
  assert.equal(JSON.stringify(manifest).includes("BACKUP_ENCRYPTION_KEY"), false);
});

test("key validation rejects missing or weak backup keys", () => {
  assert.throws(() => loadKey(""), /required/);
  assert.throws(() => loadKey(Buffer.alloc(16).toString("base64")), /32 bytes/);
  assert.equal(loadKey(key.toString("base64")).length, 32);
});

test("manifest generation and missing or stale backup detection are deterministic", () => {
  const manifest = createManifest({ backupId: "synthetic-1", createdAt: "2026-10-14T12:00:00.000Z", database: [{ encrypted_size: 10 }], storage: [{ bucket: "b", path_hash: "p", plaintext_sha256: "h", encrypted_size: 20 }] });
  assert.deepEqual(verifyManifest(manifest), { ok: true, errors: [] });
  assert.equal(manifest.database.encrypted_size, 10);
  assert.equal(manifest.storage.object_count, 1);
  assert.equal(backupAgeStatus(null).reason, "missing_backup");
  assert.equal(backupAgeStatus(manifest, { now: Date.parse("2026-10-16T12:00:00Z"), maximumAgeHours: 30 }).reason, "stale_backup");
});

test("Storage enumeration is paginated and recursively preserves bucket paths", async () => {
  const calls = [];
  const pages = new Map([
    ["|0", [{ id: "1", name: "root.txt", metadata: { size: 1 } }, { id: null, name: "folder" }]],
    ["|2", []],
    ["folder|0", [{ id: "2", name: "nested.pdf", metadata: { size: 2 } }]],
  ]);
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => pages.get(`${body.prefix}|${body.offset}`) || [] };
  };
  const objects = await listStorageObjects({ baseUrl: "https://synthetic.invalid", serviceKey: "synthetic", bucket: "private", pageSize: 2, fetchImpl });
  assert.deepEqual(objects.map(x => x.name), ["root.txt", "folder/nested.pdf"]);
  assert.equal(calls.length, 3);
});

test("failed Storage downloads retry transient errors and eventually succeed", async () => {
  let attempts = 0;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("ok")); controller.close(); } });
  const stream = await downloadStorageObject({ baseUrl: "https://synthetic.invalid", serviceKey: "synthetic", bucket: "b", name: "x", attempts: 3, fetchImpl: async () => (++attempts < 3 ? { ok: false, status: 503 } : { ok: true, body }) });
  let value = ""; for await (const chunk of stream) value += chunk.toString();
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("retry reports terminal failure without leaking supplied secrets", async () => {
  await assert.rejects(retry(async () => { throw new Error("password=super-secret"); }, { attempts: 2, baseDelayMs: 1 }), /super-secret/);
  assert.equal(redact("password=super-secret token=abc"), "password=[REDACTED] token=[REDACTED]");
});

test("duplicate jobs are prevented by an exclusive lock", async t => {
  const root = await temp(t), lock = join(root, "backup.lock");
  let release; const blocker = new Promise(resolve => { release = resolve; });
  const first = withJobLock(lock, async () => blocker);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(withJobLock(lock, async () => {}), /already running/);
  release(); await first;
  await withJobLock(lock, async () => {});
});

test("ordinary company administrators cannot run platform backups", () => {
  assert.throws(() => assertPlatformAuthority({ BACKUP_PLATFORM_AUTHORITY: "company_admin" }), /platform-level/);
  assert.doesNotThrow(() => assertPlatformAuthority({ BACKUP_PLATFORM_AUTHORITY: "verified_super_admin" }));
});

test("System Health status is read-only minimal and platform-authority restricted", () => {
  const manifest = createManifest({ backupId: "status", createdAt: "2026-10-14T12:00:00Z", database: [{ encrypted_size: 10 }], storage: [{ bucket: "private", path_hash: "hash", plaintext_sha256: "sum", encrypted_size: 20 }], verification: { status: "verified_after_upload" } });
  assert.throws(() => buildSystemHealthStatus([manifest], { BACKUP_PLATFORM_AUTHORITY: "company_admin" }), /platform-level/);
  const status = buildSystemHealthStatus([manifest], { BACKUP_PLATFORM_AUTHORITY: "verified_super_admin", BACKUP_MAXIMUM_AGE_HOURS: "30", BACKUP_RETENTION_POLICY: "30 days" }, Date.parse("2026-10-14T13:00:00Z"));
  assert.equal(status.backup_size, 30);
  assert.equal(status.warning, null);
  assert.equal(JSON.stringify(status).includes("private"), false);
});

test("destination authentication is required and uploads are existence-verified", async t => {
  const root = await temp(t), file = join(root, "artifact.enc"); await writeFile(file, "synthetic");
  await assert.rejects(uploadS3(file, "backup/artifact.enc", {}), /BACKUP_S3_BUCKET/);
  const invocations = [];
  const spawnImpl = (_command, args) => {
    invocations.push(args); const child = new EventEmitter(); child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", 0)); return child;
  };
  await uploadS3(file, "backup/artifact.enc", { BACKUP_S3_BUCKET: "approved", AWS_REGION: "eu-west-2" }, spawnImpl);
  assert.equal(invocations[0][1], "put-object");
  assert.equal(invocations[1][1], "head-object");
  assert.equal(invocations.flat().includes("synthetic-secret"), false);
});

test("transient destination upload failures retry safely", async t => {
  const root = await temp(t), file = join(root, "artifact.enc"); await writeFile(file, "synthetic");
  let invocation = 0;
  const spawnImpl = () => {
    invocation += 1; const child = new EventEmitter(); child.stderr = new PassThrough();
    queueMicrotask(() => child.emit("close", invocation === 1 ? 1 : 0)); return child;
  };
  await uploadS3(file, "backup/artifact.enc", { BACKUP_S3_BUCKET: "approved", AWS_REGION: "eu-west-2", BACKUP_UPLOAD_RETRY_DELAY_MS: "1" }, spawnImpl);
  assert.equal(invocation, 3);
});

test("failure notifications contain redacted minimal data", async () => {
  let payload;
  const result = await notifyFailure(new Error("password=secret-value export failed"), { BACKUP_FAILURE_WEBHOOK_URL: "https://alerts.invalid" }, async (_url, options) => { payload = JSON.parse(options.body); return { ok: true }; });
  assert.equal(result.sent, true);
  assert.equal(JSON.stringify(payload).includes("secret-value"), false);
  assert.equal(payload.status, "failed");
});

test("synthetic recovery restores schema evidence relationships RLS and Storage checksums", async t => {
  const root = await temp(t);
  const backup = await syntheticBackup({ root, key, backupId: "synthetic-recovery" });
  const result = await syntheticRestore({ backupDir: backup.dir, restoreDir: join(root, "restored"), key });
  assert.equal(result.status, "synthetic_restore_passed");
  assert.equal(result.object_count, 1);
  assert.match(result.limitation, /no PostgreSQL engine/);
  assert.equal((await readFile(join(root, "restored", "storage", "synthetic-private", "tenant", "receipt.txt"), "utf8")), "synthetic receipt content");
});

test("incomplete synthetic restore is detected", async t => {
  const root = await temp(t);
  const backup = await syntheticBackup({ root, key, backupId: "synthetic-incomplete" });
  await writeFile(join(backup.dir, "database.sql.enc"), "truncated");
  await assert.rejects(syntheticRestore({ backupDir: backup.dir, restoreDir: join(root, "restored"), key }), /truncated|invalid/);
});
