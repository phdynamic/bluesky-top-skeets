const test = require('node:test');
const assert = require('node:assert');
const { RequestBudget } = require('../dist/budget');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('rate 0 means no pacing', async () => {
  const b = new RequestBudget({ ratePerSec: 0 });
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) await b.take('feeds');
  assert.ok(Date.now() - t0 < 100);
});

test('a rate spaces callers out', async () => {
  const b = new RequestBudget({ ratePerSec: 20 });           // 50 ms apart
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) await b.take('feeds');
  const took = Date.now() - t0;
  assert.ok(took >= 180 && took < 600, `took ${took}`);
});

test('waiting callers are served user, then feeds, then background', async () => {
  const b = new RequestBudget({ ratePerSec: 20 });
  await b.take('feeds');                                     // uses the first slot
  const order = [];
  const ps = [['background', 'bg'], ['feeds', 'feed'], ['user', 'user']].map(([p, n]) => b.take(p).then(() => order.push(n)));
  await Promise.all(ps);
  assert.deepStrictEqual(order, ['user', 'feed', 'bg']);
});

test('a penalty pauses everyone, even with no rate set', async () => {
  const b = new RequestBudget({ ratePerSec: 0 });
  b.penalize(200);
  const t0 = Date.now();
  await Promise.all([b.take('user'), b.take('feeds'), b.take('background')]);
  assert.ok(Date.now() - t0 >= 190);
  await sleep(1);
  const t1 = Date.now(); await b.take('feeds'); assert.ok(Date.now() - t1 < 50);   // and it ends
});
