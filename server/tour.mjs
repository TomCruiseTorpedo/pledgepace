// A guided, self-checking tour of PledgePace, for people and for AI agents.
//
//   node tour.mjs           run the whole story and check every step (exit 1 if any check fails)
//   node tour.mjs --serve   seed the same data and keep a server running to click around in
//
// No install, no Helcim account and no watch needed: it starts its own server on a free port,
// in simulated-Helcim mode (the real Helcim client, signature check and settlement, against an
// in-process fake that accepts only Helcim's published test card), and plays the watch's part.
import { createPledgeServer } from './server.mjs';
import { createHelcim } from './helcim.mjs';
import { createHelcimSimulator, TEST_CARD } from './helcim-sim.mjs';
import { randomBytes } from 'node:crypto';

const serve = process.argv.includes('--serve');
// Keep the server's own "stake from ..." log lines out of the tour's output.
const print = console.log;
console.log = (...args) => {
  if (!/^(stake|pledge) from /.test(String(args[0]))) print(...args);
};
const relayKey = 'tour-' + randomBytes(6).toString('hex');
const simulator = createHelcimSimulator();
const helcim = createHelcim({ apiToken: 'simulated', fetchImpl: simulator.fetchImpl });
const { server } = createPledgeServer({ helcim, simulator, relayKey, nudgeEveryMin: 0 });
await new Promise((resolve) => server.listen(serve ? Number(process.env.PORT ?? 8790) : 0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const say = (text = '') => console.log(text);
function check(ok, what, detail = '') {
  if (!ok) failures++;
  say(`  ${ok ? '✓' : '✗'} ${what}${detail ? `  (${detail})` : ''}`);
}
async function call(method, path, body, { key = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key && { 'x-relay-key': relayKey }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const money = (n) => `$${Number(n).toFixed(2)}`;

// One backer, the way the pledge page does it: start a pledge, pay in the card window, confirm.
async function back(runner, name, stake) {
  const started = await call('POST', '/api/pledges', { runner, name, stake, consent: true });
  const card = await call('POST', '/sim-helcim/pay', { checkoutToken: started.body.checkoutToken, cardNumber: TEST_CARD, expiry: '01/28', cvv: '100' });
  const confirmed = await call('POST', `/api/pledges/${started.body.pledgeId}/confirm`, { eventMessage: card.body.eventMessage });
  return { started, card, confirmed };
}
// The watch's telemetry, every 5 seconds in real life.
const watch = (runner, steps) => call('POST', `/api/runs/${runner}/telemetry`, { steps, recording: true }, { key: true });
const nudge = (runner, steps) => call('POST', `/api/runs/${runner}/nudge`, { steps }, { key: true });

say(`PledgePace tour · server ${base} · simulated Helcim (test card ${TEST_CARD.replace(/(\d{4})(?=\d)/g, '$1 ')} only)`);

// ---- 1. a commitment goal --------------------------------------------------------------
say('\n1. Commitment goal: backers pay for the share of the goal you miss');
let r = await call('POST', '/api/runs/you/goal', { unit: 'steps', target: 1000, label: 'today', name: 'You', payOn: 'miss' }, { key: true });
check(r.status === 200 && r.body.payOn === 'miss', 'goal set: 1,000 steps today');

for (const [name, stake] of [['Sam', 20], ['Alex', 10]]) {
  const b = await back('you', name, stake);
  check(b.card.body.eventStatus === 'SUCCESS', `${name} pays ${money(stake)} in the simulated card window`, 'a $0 verify, nothing charged');
  check(b.confirmed.status === 200, `the server checks the signed response and saves only a card token`);
}

await watch('you', 0); // the watch's first reading is the baseline
r = await watch('you', 400);
check(r.body.raised === 18, `watch reports 400 steps: ${money(r.body.raised)} of ${money(r.body.stakeTotal)} still at stake`, '600 of 1,000 missed = 60%');

r = await nudge('you', 400);
check(/2 new backers|backed you/.test(r.body.title ?? ''), `background nudge on the watch: "${r.body.title}"`, r.body.body);

r = await watch('you', 1050);
check(r.body.goalMet === true && r.body.raised === 0, `watch reports 1,050 steps: GOAL MET, ${money(r.body.raised)} at stake`);
r = await nudge('you', 1050);
check(r.body.title === 'Goal met!', `nudge: "${r.body.title}"`, r.body.body);

r = await call('POST', '/api/runs/you/settle', {}, { key: true });
check(r.body.total === 0 && r.body.results.every((x) => x.status === 'skipped'), 'settle: nobody is charged, every stake released');

// ---- 2. a charity goal -----------------------------------------------------------------
say('\n2. Charity goal: backers pay for the share of the goal you complete');
r = await call('POST', '/api/runs/charity/goal', { unit: 'steps', target: 1000, label: 'for the food bank', name: 'You', payOn: 'progress' }, { key: true });
check(r.status === 200 && r.body.payOn === 'progress', 'charity goal set: 1,000 steps for the food bank');
await back('charity', 'Sam', 20);
await back('charity', 'Alex', 10);
await watch('charity', 0);
r = await watch('charity', 700);
check(r.body.raised === 21, `watch reports 700 steps: ${money(r.body.raised)} raised so far`, '70% of $30');
await call('POST', '/api/runs/charity/telemetry', { steps: 700, finished: true }, { key: true });
r = await call('POST', '/api/runs/charity/settle', {}, { key: true });
check(r.body.total === 21, `settle: ${money(r.body.total)} charged through (simulated) Helcim, ${r.body.results.map((x) => `${x.name} ${money(x.amount)}`).join(', ')}`);
const before = simulator.purchaseCount();
await call('POST', '/api/runs/charity/settle', {}, { key: true });
check(simulator.purchaseCount() === before, 'settling again charges nobody twice');

// ---- 3. safety -------------------------------------------------------------------------
say('\n3. Safety checks');
r = await call('POST', '/api/pledges', { runner: 'charity', name: 'Hasty', stake: 20 });
check(r.status === 400, 'a pledge without the authorization box ticked is refused');
const started = await call('POST', '/api/pledges', { runner: 'you', name: 'Late', stake: 5, consent: true });
check(started.status === 409, 'no new pledges on a finished run');
r = await call('POST', '/api/runs/new/goal', { unit: 'steps', target: 1000 });
check(r.status === 401, 'setting a goal without the relay key is refused');
const fresh = await call('POST', '/api/pledges', { runner: 'perkm', name: 'Ivy', rate: 1, cap: 10, consent: true }); // a per-km pledge
r = await call('POST', '/sim-helcim/pay', { checkoutToken: fresh.body.checkoutToken, cardNumber: '4111 1111 1111 1111', expiry: '01/28', cvv: '100' });
check(r.status === 400, 'the simulated card window refuses anything but the test card');
const plain = await fetch(base + '/api/runs/you/settle', { method: 'POST', body: '{}' });
check(plain.status === 415, 'a cross-site style form post (not JSON) is refused');

say(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);

if (!serve) {
  server.close();
  process.exit(failures === 0 ? 0 : 1);
}

// ---- --serve: keep it running with a fresh goal to play with -------------------------------
await call('POST', '/api/runs/play/goal', { unit: 'steps', target: 2000, label: 'today', name: 'You', payOn: 'progress' }, { key: true });
say(`
Server left running with an open charity goal to play with (Ctrl+C to stop):
  Pledge page   ${base}/?runner=play     (card window: press "Fill in the test card")
  Dashboard     ${base}/organizer        (relay key: ${relayKey})
  Walk 2,000 steps for it from another terminal:
    RELAY_KEY=${relayKey} SPEED_UP=30 node fake-runner.mjs ${base} play --finish-at=2
`);
