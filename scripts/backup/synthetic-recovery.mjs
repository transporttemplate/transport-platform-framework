#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKey, syntheticBackup, syntheticRestore } from "./lib.mjs";

const root = await mkdtemp(join(tmpdir(), "tpf-backup-synthetic-"));
try {
  const key = loadKey();
  const backup = await syntheticBackup({ root, key });
  const result = await syntheticRestore({ backupDir: backup.dir, restoreDir: join(root, "restore"), key });
  await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await rm(root, { recursive: true, force: true });
}
