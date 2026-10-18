const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const config = fs.readFileSync("js/config.js", "utf8");
const migration = fs.readFileSync("supabase/migrations/202610180002_public_empty_legs_settings_grant.sql", "utf8");

test("public feature flags have an explicit narrow anonymous column grant", () => {
    assert.match(migration, /grant select\s*\(\s*empty_legs_enabled,\s*empty_legs_public_enabled\s*\)\s*on table public\.settings to anon/is);
    assert.match(migration, /alter table public\.settings enable row level security/i);
    assert.doesNotMatch(migration, /grant select on table public\.settings|disable row level security/i);
});

test("optional feature settings cannot block core company branding", () => {
    assert.match(config, /const coreColumns = baseColumns\.replace/);
    assert.match(config, /if \(coreResult\.error\) return coreResult;/);
    assert.match(config, /data: \{ \.\.\.\(coreResult\.data \|\| \{\}\), \.\.\.\(featureResult\.data \|\| \{\}\) \}/);
    assert.match(config, /core branding remains active/);
});

test("production hostname fallbacks remain independently tenant scoped", () => {
    assert.match(config, /"etbm\.co\.uk": "0002"/);
    assert.match(config, /"www\.jeffscars\.com": "0003"/);
    assert.match(config, /\.eq\("company_id", company\.id\)/g);
    assert.doesNotMatch(config, /jeffscars\.com": "000[12]"/);
});
