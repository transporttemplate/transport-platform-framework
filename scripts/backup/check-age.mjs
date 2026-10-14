#!/usr/bin/env node
import { backupAgeStatus, readJson } from "./lib.mjs";
const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/backup/check-age.mjs /path/to/manifest.json");
const result = backupAgeStatus(await readJson(path), { maximumAgeHours: Number(process.env.BACKUP_MAXIMUM_AGE_HOURS || 30) });
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 2;
