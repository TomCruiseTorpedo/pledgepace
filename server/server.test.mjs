import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPledgeServer, pledgeAmount, stakeAmount, bump, counted } from './server.mjs';
import { createHelcim, validResponse, hashCandidates } from './helcim.mjs';

const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const sign = (data, secret) => createHash('sha256').update(JSON.stringify(data) + secret).digest('hex');

// Stands in for api.helcim.com and records every request the server makes.
function fakeHelcimApi({ purchaseStatus = 'APPROVED' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (url.endsWith('/helcim-pay/initialize')) return json({ checkoutToken: `chk_${calls.length}`, secretToken: `sec_${calls.length}` });
    if (url.endsWith('/payment/purchase')) return json({ transactionId: 9000 + calls.length, status: purchaseStatus, amount: body.amount, currency: body.currency });
    return json({ errors: 'unexpected endpoint' }, 404);
  };
  return { calls, helcim: createHelcim({ apiToken: 'test-token', fetchImpl }) };
}

async function start(ctx, opts = {}) {
  const app = createPledgeServer(opts);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  ctx.after(() => new Promise((r) => app.server.close(r)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path) => (await fetch(base + path)).json();
  return { post, get, app };
}

// Start a pledge and confirm it with a correctly signed HelcimPay.js response.
async function pledge(r, calls, { name, rate, cap, token }) {
  const started = await r.post('/api/pledges', { runner: 'r1', consent: true, name, rate, cap });
  assert.equal(started.status, 201);
  const secret = `sec_${calls.length}`;
  const data = { transactionId: '1', status: 'APPROVED', type: 'verify', amount: '0', currency: 'CAD', cardToken: token, customerCode: `CST-${name}` };
  const confirmed = await r.post(`/api/pledges/${started.body.pledgeId}/confirm`, { eventMessage: { data, hash: sign(data, secret) } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return started.body.pledgeId;
}

test('a pledge owes rate × km, never more than its cap', () => {
  assert.equal(pledgeAmount({ rate: 2, cap: 10 }, 3), 6);
  assert.equal(pledgeAmount({ rate: 2, cap: 10 }, 7), 10);
  assert.equal(pledgeAmount({ rate: 0.5, cap: 50 }, 4.217), 2.11);
});

test('starting a pledge opens a $0 verify session and keeps the secret on the server', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  const res = await r.post('/api/pledges', { runner: 'r1', consent: true, name: 'Sam', rate: 2, cap: 40 });
  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v2\/helcim-pay\/initialize$/);
  assert.equal(calls[0].headers['api-token'], 'test-token');
  assert.equal(calls[0].body.paymentType, 'verify');
  assert.equal(calls[0].body.amount, 0);
  assert.equal(calls[0].body.currency, 'CAD');
  assert.equal(calls[0].body.customerRequest.contactName, 'Sam');
  assert.equal(res.body.checkoutToken, 'chk_1');
  assert.equal(res.body.secretToken, undefined, 'secretToken must never reach the browser');
});

test('a tampered HelcimPay.js response is rejected', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  const started = await r.post('/api/pledges', { runner: 'r1', consent: true, name: 'Eve', rate: 5, cap: 100 });
  const data = { status: 'APPROVED', type: 'verify', cardToken: 'tok_eve' };
  const forged = { data: { ...data, cardToken: 'tok_someone_else' }, hash: sign(data, `sec_${calls.length}`) };
  const res = await r.post(`/api/pledges/${started.body.pledgeId}/confirm`, { eventMessage: forged });
  assert.equal(res.status, 400);
  assert.equal((await r.get('/api/runs/r1')).pledgers, 0);
});

test('watch telemetry gets the live total across pledges, honouring caps', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await pledge(r, calls, { name: 'Ana', rate: 2, cap: 10, token: 'tok_ana' });
  await pledge(r, calls, { name: 'Bo', rate: 1, cap: 50, token: 'tok_bo' });
  const res = await r.post('/api/runs/r1/telemetry', { dist: 7000, timer: 2_100_000, recording: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.raised, 17); // Ana capped at 10, Bo 7 × $1
  assert.equal(res.body.ratePerKm, 3);
  assert.equal(res.body.pledgers, 2);
});

test('settling charges each pledge once, with an idempotency key and the card token', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await pledge(r, calls, { name: 'Ana', rate: 2, cap: 10, token: 'tok_ana' });
  await pledge(r, calls, { name: 'Bo', rate: 1, cap: 50, token: 'tok_bo' });
  await r.post('/api/runs/r1/telemetry', { dist: 7000 });

  const first = await r.post('/api/runs/r1/settle', {});
  assert.equal(first.status, 200);
  const purchases = calls.filter((c) => c.url.endsWith('/payment/purchase'));
  assert.deepEqual(purchases.map((c) => c.body.amount), [10, 7]);
  for (const c of purchases) {
    assert.equal(c.body.currency, 'CAD');
    assert.match(c.body.cardData.cardToken, /^tok_/);
    assert.ok(c.body.ipAddress, 'Helcim wants the cardholder IP');
    const key = c.headers['idempotency-key'];
    assert.ok(key.length >= 25 && key.length <= 36, `idempotency key length ${key.length}`);
  }
  assert.equal(first.body.total, 17);

  await r.post('/api/runs/r1/settle', {});
  assert.equal(calls.filter((c) => c.url.endsWith('/payment/purchase')).length, 2, 'second settle must not charge again');
});

test('a declined charge is marked failed and drops out of the total', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi({ purchaseStatus: 'DECLINED' });
  const r = await start(ctx, { helcim });
  await pledge(r, calls, { name: 'Cy', rate: 3, cap: 30, token: 'tok_cy' });
  await r.post('/api/runs/r1/telemetry', { dist: 5000 });
  const res = await r.post('/api/runs/r1/settle', {});
  assert.equal(res.body.results[0].status, 'failed');
  assert.equal(res.body.total, 0);
  assert.equal((await r.get('/api/runs/r1')).raised, 0);
});

test('mock mode runs the whole flow without Helcim', async (ctx) => {
  const r = await start(ctx); // no API token, so mock
  const started = await r.post('/api/pledges', { runner: 'r1', consent: true, name: 'Dee', rate: 1.5, cap: 20 });
  assert.equal(started.body.mock, true);
  await r.post(`/api/pledges/${started.body.pledgeId}/confirm`, {});
  await r.post('/api/runs/r1/telemetry', { dist: 4000, finished: true });
  const res = await r.post('/api/runs/r1/settle', {});
  assert.equal(res.body.results[0].status, 'charged');
  assert.match(res.body.results[0].transactionId, /^mock-/);
  assert.equal(res.body.total, 6);
});

test('watch telemetry and settle need the relay key when one is set', async (ctx) => {
  const r = await start(ctx, { relayKey: 'sekrit' });
  assert.equal((await r.post('/api/runs/r1/telemetry', { dist: 1 })).status, 401);
  assert.equal((await r.post('/api/runs/r1/settle', {})).status, 401);
  assert.equal((await r.post('/api/runs/r1/telemetry', { dist: 1 }, { 'x-relay-key': 'sekrit' })).status, 200);
});

test('bad pledges are rejected', async (ctx) => {
  const r = await start(ctx);
  for (const body of [
    { runner: 'r1', name: '', rate: 1, cap: 10 },
    { runner: 'r1', name: 'X', rate: 0, cap: 10 },
    { runner: 'r1', name: 'X', rate: 50, cap: 10 },
    { runner: 'r1', name: 'X', rate: 1, cap: 5000 },
    { runner: 'bad id!', name: 'X', rate: 1, cap: 10 },
  ]) {
    assert.equal((await r.post('/api/pledges', body)).status, 400, JSON.stringify(body));
  }
});

test('hash validation accepts PHP-style escaping and rejects a wrong secret', () => {
  const data = { cardHolderName: 'Zoë', note: 'a/b', status: 'APPROVAL' };
  const phpStyle = JSON.stringify(data).replace(/ë/g, '\\u00eb').replace(/\//g, '\\/');
  const hash = createHash('sha256').update(phpStyle + 'sec').digest('hex');
  assert.ok(hashCandidates(data, 'sec').includes(hash));
  assert.equal(validResponse({ data, hash }, 'sec'), true);
  assert.equal(validResponse({ data, hash }, 'other'), false);
});

// ---- goal mode ---------------------------------------------------------------

// Like pledge(), but a goal-mode stake.
async function stake(r, calls, { name, stake, token, runner = 'r1' }) {
  const started = await r.post('/api/pledges', { runner, name, stake, consent: true });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const secret = `sec_${calls.length}`;
  const data = { transactionId: '1', status: 'APPROVED', type: 'verify', amount: '0', currency: 'CAD', cardToken: token, customerCode: `CST-${name}` };
  const confirmed = await r.post(`/api/pledges/${started.body.pledgeId}/confirm`, { eventMessage: { data, hash: sign(data, secret) } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
}

test('a stake owes its share of the goal still missed, and nothing once the goal is met', () => {
  const goal = { target: 10, logged: 2 };
  assert.equal(stakeAmount(20, goal, 3), 10); // 5 of 10 km missed
  assert.equal(stakeAmount(20, goal, 0), 16); // 8 of 10 km missed
  assert.equal(stakeAmount(20, goal, 8), 0); // exactly met
  assert.equal(stakeAmount(20, goal, 9), 0); // overshoot never goes negative
  assert.equal(stakeAmount(15, { target: 3, logged: 0 }, 1), 10);
});

test('the organizer sets a goal only with the key, only with sane numbers, and only before anyone pledges', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim, relayKey: 'k' });
  const key = { 'x-relay-key': 'k' };
  assert.equal((await r.get('/api/runs/r1')).mode, 'perKm');
  assert.equal((await r.post('/api/runs/r1/goal', { km: 5 })).status, 401);
  assert.equal((await r.post('/api/runs/r1/goal', { km: 0 }, key)).status, 400);
  assert.equal((await r.post('/api/runs/r1/goal', { km: 5, loggedKm: 5 }, key)).status, 400);
  const ok = await r.post('/api/runs/r1/goal', { km: 5, loggedKm: 1.2, label: 'by Sunday' }, key);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, 'goal');
  assert.equal(ok.body.unit, 'km');
  assert.equal(ok.body.target, 5);
  assert.equal(ok.body.progress, 1.2);
  assert.equal(ok.body.label, 'by Sunday');

  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  const late = await r.post('/api/runs/r1/goal', { km: 50 }, key);
  assert.equal(late.status, 409, 'changing the goal after a backer commits must be refused');
  assert.equal((await r.get('/api/runs/r1')).target, 5);
});

test('in goal mode the watch sees the money at stake shrink as the runner closes in', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/goal', { km: 5, loggedKm: 1 });
  assert.equal((await r.post('/api/pledges', { runner: 'r1', consent: true, name: 'Per-km', rate: 2, cap: 40 })).status, 400, 'a goal run takes stakes, not per-km pledges');
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  await stake(r, calls, { name: 'Bo', stake: 10, token: 'tok_bo' });

  const mid = (await r.post('/api/runs/r1/telemetry', { dist: 2000, recording: true })).body;
  assert.equal(mid.mode, 'goal');
  assert.equal(mid.progress, 3);
  assert.equal(mid.raised, 12); // 2 of 5 km missed: 40% of $30
  assert.equal(mid.stakeTotal, 30);
  assert.equal(mid.goalMet, false);

  const done = (await r.post('/api/runs/r1/telemetry', { dist: 4000, recording: true })).body;
  assert.equal(done.raised, 0);
  assert.equal(done.goalMet, true);
});

test('settling a missed goal charges each backer their share, once', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/goal', { km: 5, loggedKm: 1 });
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  await stake(r, calls, { name: 'Bo', stake: 10, token: 'tok_bo' });
  await r.post('/api/runs/r1/telemetry', { dist: 1500, finished: true }); // 2.5 of 5 km: half missed

  const res = await r.post('/api/runs/r1/settle', {});
  const purchases = calls.filter((c) => c.url.endsWith('/payment/purchase'));
  assert.deepEqual(purchases.map((c) => c.body.amount), [10, 5]);
  assert.deepEqual(purchases.map((c) => c.body.cardData.cardToken), ['tok_ana', 'tok_bo']);
  assert.equal(res.body.total, 15);

  await r.post('/api/runs/r1/settle', {});
  assert.equal(calls.filter((c) => c.url.endsWith('/payment/purchase')).length, 2, 'second settle must not charge again');
});

test('settling a met goal charges nobody', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/goal', { km: 5, loggedKm: 1 });
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  await r.post('/api/runs/r1/telemetry', { dist: 4100, finished: true });

  const res = await r.post('/api/runs/r1/settle', {});
  assert.equal(calls.filter((c) => c.url.endsWith('/payment/purchase')).length, 0);
  assert.equal(res.body.results[0].status, 'skipped');
  assert.equal(res.body.total, 0);
});

// ---- goal units: sensors beyond GPS --------------------------------------------

test('a watch counter counts from its first reading and survives a reset to zero', () => {
  const c = {};
  bump(c, 'steps', 5000);
  assert.equal(counted(c, 'steps'), 0);
  bump(c, 'steps', 5200);
  assert.equal(counted(c, 'steps'), 200);
  bump(c, 'steps', 80); // midnight: the watch's step count restarts
  assert.equal(counted(c, 'steps'), 280);
  bump(c, 'steps', 'lots');
  bump(c, 'steps', -5);
  assert.equal(counted(c, 'steps'), 280, 'junk readings are ignored');
});

test('a steps goal counts only steps taken after the goal was set', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/telemetry', { steps: 3000 }); // before any goal
  const set = await r.post('/api/runs/r1/goal', { unit: 'steps', target: 1000, label: 'today' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });

  let t = (await r.post('/api/runs/r1/telemetry', { steps: 3400 })).body;
  assert.equal(t.unit, 'steps');
  assert.equal(t.progress, 0, 'the first reading after the goal is the baseline');
  assert.equal(t.raised, 20);
  t = (await r.post('/api/runs/r1/telemetry', { steps: 4000 })).body;
  assert.equal(t.progress, 600);
  assert.equal(t.raised, 8); // 400 of 1000 missed
  t = (await r.post('/api/runs/r1/telemetry', { steps: 450 })).body; // midnight reset
  assert.equal(t.progress, 1050);
  assert.equal(t.goalMet, true);
  assert.equal(t.raised, 0);
});

test('a floors goal uses the barometer count and a minutes goal uses heart-rate zone time', async (ctx) => {
  const r = await start(ctx);
  await r.post('/api/runs/f1/goal', { unit: 'floors', target: 4 });
  await r.post('/api/runs/f1/telemetry', { floors: 10 });
  assert.equal((await r.post('/api/runs/f1/telemetry', { floors: 13 })).body.progress, 3);

  await r.post('/api/runs/m1/goal', { unit: 'minutes', target: 10 });
  await r.post('/api/runs/m1/telemetry', { zoneSec: 0, hr: 131 });
  const t = (await r.post('/api/runs/m1/telemetry', { zoneSec: 300, hr: 142 })).body;
  assert.equal(t.progress, 5, '300 seconds in zone is 5 minutes');
  assert.equal((await r.get('/api/runs/m1')).hr, 142, 'pages see the live heart rate');
});

test('goal units are validated', async (ctx) => {
  const r = await start(ctx);
  assert.equal((await r.post('/api/runs/x1/goal', { unit: 'naps', target: 3 })).status, 400);
  assert.equal((await r.post('/api/runs/x1/goal', { unit: 'steps', target: 50 })).status, 400);
  assert.equal((await r.post('/api/runs/x1/goal', { unit: 'steps', target: 5000, logged: 6000 })).status, 400);
});

test('a pledge without the authorization box ticked is refused, and nothing is opened at Helcim', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  const res = await r.post('/api/pledges', { runner: 'r1', name: 'Hasty', rate: 2, cap: 40 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /authoriz/);
  assert.equal(calls.length, 0, 'no Helcim session without consent');
});

test('a goal carries the name the pages show', async (ctx) => {
  const r = await start(ctx);
  const set = await r.post('/api/runs/jj/goal', { unit: 'steps', target: 8000, label: 'today', name: 'JJ' });
  assert.equal(set.body.name, 'JJ');
  const plain = await r.post('/api/runs/anon/goal', { unit: 'steps', target: 8000 });
  assert.equal(plain.body.name, 'anon', 'falls back to the runner id');
});

test('a bare pledge link goes to the most recently set open goal', async (ctx) => {
  let t = 1000;
  const r = await start(ctx, { now: () => t });
  assert.equal((await r.get('/api/config')).defaultRunner, 'runner-1', 'no goals yet');
  await r.post('/api/runs/a1/goal', { unit: 'steps', target: 1000 });
  t = 2000;
  await r.post('/api/runs/b2/goal', { unit: 'steps', target: 1000 });
  assert.equal((await r.get('/api/config')).defaultRunner, 'b2');
  await r.post('/api/runs/b2/telemetry', { finished: true });
  assert.equal((await r.get('/api/config')).defaultRunner, 'a1', 'a finished goal is skipped');
});

// ---- watch nudges (background task) ---------------------------------------------

test('a new backer produces one nudge, and only once', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/goal', { unit: 'steps', target: 1000 });
  assert.deepEqual((await r.post('/api/runs/r1/nudge', { steps: 0 })).body, {}, 'nothing to say yet');
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  const first = (await r.post('/api/runs/r1/nudge', { steps: 0 })).body;
  assert.equal(first.title, 'Ana backed you');
  assert.match(first.body, /\$20\.00 now at stake, 1,000 steps to go/);
  assert.deepEqual((await r.post('/api/runs/r1/nudge', { steps: 0 })).body, {}, 'the same backer is not announced twice');
});

test('meeting the goal is announced once, using the steps the background task reports', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  const r = await start(ctx, { helcim });
  await r.post('/api/runs/r1/goal', { unit: 'steps', target: 1000 });
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  await r.post('/api/runs/r1/nudge', { steps: 5000 }); // announces Ana, sets the step baseline
  const met = (await r.post('/api/runs/r1/nudge', { steps: 6200 })).body;
  assert.equal(met.title, 'Goal met!');
  assert.match(met.body, /\$20\.00 saved/);
  assert.deepEqual((await r.post('/api/runs/r1/nudge', { steps: 6300 })).body, {});
});

test('a behind-goal reminder waits for the interval', async (ctx) => {
  const { calls, helcim } = fakeHelcimApi();
  let t = 1_000_000;
  const r = await start(ctx, { helcim, now: () => t, nudgeEveryMin: 30 });
  await r.post('/api/runs/r1/goal', { unit: 'steps', target: 1000 });
  await stake(r, calls, { name: 'Ana', stake: 20, token: 'tok_ana' });
  await r.post('/api/runs/r1/nudge', { steps: 0 }); // the backer announcement
  t += 29 * 60000;
  assert.deepEqual((await r.post('/api/runs/r1/nudge', { steps: 400 })).body, {}, 'too soon');
  t += 2 * 60000;
  const remind = (await r.post('/api/runs/r1/nudge', { steps: 400 })).body;
  assert.equal(remind.title, '600 steps to go');
  assert.match(remind.body, /\$12\.00 of your backers' money/);
});

test('nudges need the relay key when one is set', async (ctx) => {
  const r = await start(ctx, { relayKey: 'k' });
  assert.equal((await r.post('/api/runs/r1/nudge', {})).status, 401);
  assert.equal((await r.post('/api/runs/r1/nudge', {}, { 'x-relay-key': 'k' })).status, 200);
});

test('the home-screen manifest and icons are served with the right types', async (ctx) => {
  const app = createPledgeServer();
  await new Promise((res) => app.server.listen(0, '127.0.0.1', res));
  ctx.after(() => new Promise((res) => app.server.close(res)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const m = await fetch(base + '/manifest.webmanifest');
  assert.equal(m.headers.get('content-type'), 'application/manifest+json');
  const manifest = await m.json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    const res = await fetch(base + icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), icon.type, icon.src);
  }
  assert.equal((await fetch(base + '/icon-180.png')).status, 200, 'apple-touch-icon');
});
