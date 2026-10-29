const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');

test('premium admin theme repairs legacy light surfaces centrally', () => {
  const css = read('css/admin-premium.css');
  for (const selector of [
    '.availability-form',
    '.template-preview',
    '.email-status',
    '.usage-stat',
    '.integration-status',
    '.server-only-box',
    '.company-media-preview',
    '.fleet-settings-item',
    '.google-calendar-banner',
    '.calendar-modal',
  ]) {
    assert.match(css, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(css, /--premium-muted:\s*#6b7280/);
  assert.match(css, /input::placeholder/);
});

test('compact booking rows retain dark payment states and readable routes', () => {
  const css = read('css/booking-compact.css');
  assert.match(css, /payment-unpaid[^}]*background:#2b171d!important/);
  assert.match(css, /payment-paid[^}]*background:#102a22!important/);
  assert.match(css, /payment-account[^}]*background:#221b35!important/);
  assert.match(css, /payment-partial[^}]*background:#2b2514!important/);
  assert.match(css, /-webkit-line-clamp:2/);
  assert.match(css, /overflow-wrap:anywhere/);
});

test('one premium booking actions menu remains viewport-safe', () => {
  const premium = read('css/admin-premium.css');
  const compact = read('css/booking-compact.css');
  assert.match(premium, /\.booking-action-menu\s*\{[^}]*background:\s*#24272b\s*!important/s);
  assert.match(compact, /width:min\(280px,calc\(100vw - 16px\)\)!important/);
  assert.match(compact, /max-height:min\(70dvh,560px\)!important/);
});
