const test = require('node:test');
const assert = require('node:assert/strict');

const handler = require('../api/email-dispatcher-cron.js');

async function invoke(headers = {}) {
  let body = '';
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { body = String(value || ''); },
  };
  await handler({ method: 'GET', headers }, response);
  return { status: response.statusCode, headers: response.headers, body: JSON.parse(body) };
}

test('scheduler endpoint rejects missing or invalid Vercel cron credentials', async () => {
  const original = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'expected-cron-secret';
  try {
    assert.equal((await invoke()).status, 401);
    assert.equal((await invoke({ authorization: 'Bearer wrong-secret' })).status, 401);
  } finally {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  }
});

test('scheduler remains fail-closed until the explicit enable switch is set', async () => {
  const originals = { cron: process.env.CRON_SECRET, enabled: process.env.EMAIL_AUTOMATION_ENABLED };
  process.env.CRON_SECRET = 'expected-cron-secret';
  delete process.env.EMAIL_AUTOMATION_ENABLED;
  try {
    const result = await invoke({ authorization: 'Bearer expected-cron-secret' });
    assert.equal(result.status, 503);
    assert.equal(result.body.dispatch_enabled, false);
  } finally {
    restore('CRON_SECRET', originals.cron);
    restore('EMAIL_AUTOMATION_ENABLED', originals.enabled);
  }
});

test('enabled scheduler forwards only the dedicated dispatcher secret and sanitises results', async () => {
  const originals = {
    cron: process.env.CRON_SECRET, enabled: process.env.EMAIL_AUTOMATION_ENABLED,
    url: process.env.SUPABASE_URL, dispatcher: process.env.EMAIL_DISPATCHER_SECRET,
  };
  const originalFetch = global.fetch;
  process.env.CRON_SECRET = 'expected-cron-secret';
  process.env.EMAIL_AUTOMATION_ENABLED = 'true';
  process.env.SUPABASE_URL = 'https://project.example';
  process.env.EMAIL_DISPATCHER_SECRET = 'dedicated-dispatcher-secret';
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, scheduled: 2, claimed: 1, accepted: 1, internal_detail: 'must not leak' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await invoke({ authorization: 'Bearer expected-cron-secret' });
    assert.equal(result.status, 200);
    assert.equal(request.url, 'https://project.example/functions/v1/email-dispatcher');
    assert.equal(request.options.headers.Authorization, 'Bearer dedicated-dispatcher-secret');
    assert.equal(result.body.accepted, 1);
    assert.equal(result.body.internal_detail, undefined);
  } finally {
    global.fetch = originalFetch;
    restore('CRON_SECRET', originals.cron);
    restore('EMAIL_AUTOMATION_ENABLED', originals.enabled);
    restore('SUPABASE_URL', originals.url);
    restore('EMAIL_DISPATCHER_SECRET', originals.dispatcher);
  }
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
