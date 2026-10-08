const test = require('node:test');
const assert = require('node:assert');
const { parsePostLink } = require('../dist/links');
const shared = require('../public/kiosk-links.js');

const DID = 'did:plc:abc123';
test('server and browser share one parser', () => assert.strictEqual(parsePostLink, shared.parsePostLink));

test('accepted shapes', () => {
  const ok = [
    ['https://bsky.app/profile/someone.example/post/3abc', { id: 'someone.example', rkey: '3abc' }],
    [`https://bsky.app/profile/${DID}/post/3abc`, { id: DID, rkey: '3abc' }],
    ['https://blacksky.community/profile/someone.example/post/3abc', { id: 'someone.example', rkey: '3abc' }],
    ['https://some.other-client.example.org/profile/a.b/post/3abc/?x=1#y', { id: 'a.b', rkey: '3abc' }],
    ['bsky.app/profile/someone.example/post/3abc', { id: 'someone.example', rkey: '3abc' }],
    [`at://${DID}/app.bsky.feed.post/3abc`, { id: DID, rkey: '3abc' }],
    ['at://someone.example/app.bsky.feed.post/3abc', { id: 'someone.example', rkey: '3abc' }],
    ['  https://bsky.app/profile/someone.example/post/3abc  ', { id: 'someone.example', rkey: '3abc' }],
  ];
  for (const [input, want] of ok) assert.deepStrictEqual(parsePostLink(input), want, input);
});

test('rejected shapes', () => {
  for (const bad of ['', '   ', null, undefined, 'hello world', 'https://bsky.app/profile/someone.example',
    'https://bsky.app/profile/someone.example/feed/abc', 'https://bsky.app/profile/someone.example/lists/abc',
    'ftp://bsky.app/profile/x.example/post/3abc', 'at://x.example/app.bsky.feed.like/3abc',
    'https://bsky.app/profile/bad id/post/3abc', 'javascript:alert(1)', 'https://bsky.app/profile/%E0%A4%A/post/3abc']) {
    assert.strictEqual(parsePostLink(bad), null, String(bad));
  }
});
