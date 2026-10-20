const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(file, 'utf8');
const executableSql = (sql) => sql.replace(/--.*$/gm, '');

test('future public table template is deny by default and keeps grants separate from RLS', () => {
  const sql = read('supabase/templates/public-table-migration.template.sql');
  assert.match(sql, /alter table public\.example_records enable row level security/i);
  assert.match(sql, /revoke all on table public\.example_records\s+from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(executableSql(sql), /grant all/i);
  assert.match(sql, /grant select, insert, update on table public\.example_records to service_role/i);
  assert.match(sql, /create policy[\s\S]+to authenticated/i);
});

test('compatibility migration removes legacy anonymous membership privileges only', () => {
  const sql = read('supabase/migrations/202610200001_data_api_permission_compatibility.sql');
  assert.match(sql, /revoke all on table public\.company_users from public, anon/i);
  assert.doesNotMatch(executableSql(sql), /\bgrant\s/i);
  assert.doesNotMatch(sql, /disable row level security/i);
});

test('synthetic permission probe requires denials and always rolls back', () => {
  const sql = read('scripts/security/data-api-permission-probe.sql');
  assert.match(sql, /set local role anon/i);
  assert.match(sql, /set local role authenticated/i);
  assert.match(sql, /when insufficient_privilege/i);
  assert.match(sql, /set local role service_role/i);
  assert.match(sql, /rollback;\s*$/i);
});

test('post-change table migrations must declare RLS and explicit role permissions', () => {
  const migrationDir = 'supabase/migrations';
  for (const name of fs.readdirSync(migrationDir).filter((name) => name >= '202610300000' && name.endsWith('.sql'))) {
    const sql = read(path.join(migrationDir, name));
    if (!/create\s+(?:unlogged\s+)?table/i.test(sql)) continue;
    assert.match(sql, /enable row level security/i, `${name} must enable RLS`);
    assert.match(sql, /revoke all[\s\S]+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role/i, `${name} must establish an explicit grant baseline`);
    assert.doesNotMatch(sql, /grant all[\s\S]+to\s+(?:anon|authenticated|service_role)/i, `${name} must not grant all to a Data API role`);
  }
});

test('sensitive historical table creation never explicitly grants anonymous access', () => {
  const sensitive = /(?:bookings|customers|drivers|payments|api_credentials|driver_bank_accounts|booking_claim_tokens|booking_tracking_tokens)/i;
  const migrationDir = 'supabase/migrations';
  for (const name of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql'))) {
    const sql = read(path.join(migrationDir, name));
    for (const match of sql.matchAll(/grant\s+([^;]+?)\s+on\s+(?:table\s+)?public\.([a-z0-9_]+)\s+to\s+anon/gi)) {
      assert.ok(!sensitive.test(match[2]), `${name} grants anon access to sensitive ${match[2]}`);
    }
  }
});
