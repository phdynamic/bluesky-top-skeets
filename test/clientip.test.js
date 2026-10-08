const test = require('node:test');
const assert = require('node:assert');
const { clientIp, hashIp } = require('../dist/clientip');
const req = (xff, sock = '10.0.0.9') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: sock } });

test('uses the entry our proxy added, not what the client sent', () => {
  assert.strictEqual(clientIp(req('1.2.3.4, 203.0.113.7'), 1), '203.0.113.7');
  assert.strictEqual(clientIp(req('6.6.6.6, 7.7.7.7, 203.0.113.7'), 1), '203.0.113.7');
});
test('a forged first entry cannot create a new identity', () => {
  const a = clientIp(req('1.1.1.1, 203.0.113.7'), 1), b = clientIp(req('9.9.9.9, 203.0.113.7'), 1);
  assert.strictEqual(a, b);
});
test('two proxies in front: counts from the right', () => {
  assert.strictEqual(clientIp(req('forged, 203.0.113.7, 10.1.1.1'), 2), '203.0.113.7');
});
test('header shorter than the proxy chain, or missing, falls back to the socket', () => {
  assert.strictEqual(clientIp(req('203.0.113.7'), 2), '10.0.0.9');
  assert.strictEqual(clientIp(req(undefined), 1), '10.0.0.9');
});
test('zero hops ignores the header entirely', () => assert.strictEqual(clientIp(req('203.0.113.7'), 0), '10.0.0.9'));
test('hash is stable within a process, differs per address, and hides the address', () => {
  assert.strictEqual(hashIp('203.0.113.7'), hashIp('203.0.113.7'));
  assert.notStrictEqual(hashIp('203.0.113.7'), hashIp('203.0.113.8'));
  assert.ok(!hashIp('203.0.113.7').includes('203'));
});
