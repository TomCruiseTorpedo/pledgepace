// PledgePace server: sponsors pledge dollars per kilometre on the web page,
// the watch reports distance and gets the live total back, and the organizer
// settles every pledge through Helcim when the run ends.
// Goal mode (opt-in per runner): backers stake dollars on a distance goal and are
// charged only for the share of the goal the runner misses.
// Zero dependencies. State is saved to DATA_FILE so card tokens survive a restart.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHelcim, isApproved, validResponse } from './helcim.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = { '/': 'index.html', '/index.html': 'index.html', '/organizer': 'organizer.html', '/organizer.html': 'organizer.html' };
// Files that let a phone add the pledge page to its home screen as an app.
const ASSETS = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_BODY = 16 * 1024;
const MAX_RATE = 20; // dollars per km
const MAX_CAP = 500; // dollars per pledge
const MIN_CHARGE = 1; // pledges that come to less than this are skipped, not charged
const MAX_STAKE = 500; // dollars per goal-mode pledge
// Goal limits per unit.
const GOAL_MIN = { km: 0.5, steps: 100, floors: 1, minutes: 1 };
const GOAL_MAX = { km: 300, steps: 500000, floors: 1000, minutes: 3000 };

export const round2 = (x) => Math.round(x * 100) / 100;

//! What one pledge owes for a given distance: rate × km, never more than its cap.
export const pledgeAmount = (p, km) => round2(Math.min(p.rate * km, p.cap));

//! What one goal-mode backer owes. goal = { target, logged, payOn }; done = progress since the goal was set.
//! payOn 'miss' (commitment, the default): stake x the share of the goal missed, so a met goal costs nothing.
//! payOn 'progress' (charity): stake x the share completed, so every step raises money and a met goal gives it all.
export const PAY_ON = ['miss', 'progress'];
export function stakeAmount(stake, goal, done) {
  const completed = Math.min(1, Math.max(0, (goal.logged + done) / goal.target));
  const share = goal.payOn === 'progress' ? completed : 1 - completed;
  return round2(stake * share);
}

// Goal units and the sensor behind each: km from the recorded activity (GPS), steps
// (accelerometer) and floors (barometer) from the watch's all-day counters, and
// minutes from heart rate (time the watch measured at or above zone 2).
export const UNITS = ['km', 'steps', 'floors', 'minutes'];

//! Folds a new reading of a watch counter into its running total. Counters restart
//! (steps and floors at midnight, zone seconds when the app restarts), so a drop
//! starts a new segment from zero instead of counting backwards.
export function bump(counters, name, v) {
  if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9)) return;
  const c = counters[name];
  if (!c) {
    counters[name] = { base: v, acc: 0, last: v };
    return;
  }
  if (v < c.last) {
    c.acc += c.last - c.base;
    c.base = 0;
  }
  c.last = v;
}

//! How much of a counter has accumulated since its first reading.
export const counted = (counters, name) => {
  const c = counters?.[name];
  return c ? c.acc + (c.last - c.base) : 0;
};

//! Progress since the goal was set, in the goal's unit.
function done(r) {
  const unit = r.goal?.unit ?? 'km';
  if (unit === 'km') return r.dist / 1000;
  if (unit === 'minutes') return counted(r.counters, 'zoneSec') / 60;
  return counted(r.counters, unit);
}

// A run without a goal has only per-km pledges; a run with one has only stakes.
const owedFor = (p, r, km) => (p.kind === 'stake' ? stakeAmount(p.stake, r.goal, done(r)) : pledgeAmount(p, km));

export function createPledgeServer({
  helcim = createHelcim(),
  relayKey = '',
  currency = 'CAD',
  milestone = 25,
  autoSettle = false,
  dataFile = null,
  defaultRunner = '',
  nudgeEveryMin = 60,
  trustProxy = false,
  now = () => Date.now(),
} = {}) {
  const runs = new Map();
  const pledges = new Map();

  if (dataFile) {
    try {
      const saved = JSON.parse(readFileSync(dataFile, 'utf8'));
      for (const r of saved.runs ?? []) {
        // Goals saved before goal units existed were km goals.
        if (r.goal && r.goal.target === undefined) r.goal = { unit: 'km', target: r.goal.km, logged: r.goal.loggedKm ?? 0, label: r.goal.label };
        runs.set(r.id, r);
      }
      for (const p of saved.pledges ?? []) pledges.set(p.id, p);
      console.log(`loaded ${pledges.size} pledges from ${dataFile}`);
    } catch {
      // no saved state yet
    }
  }
  function persist() {
    if (!dataFile) return;
    mkdirSync(dirname(dataFile), { recursive: true });
    writeFileSync(dataFile + '.tmp', JSON.stringify({ runs: [...runs.values()], pledges: [...pledges.values()] }));
    renameSync(dataFile + '.tmp', dataFile);
  }

  function run(id) {
    let r = runs.get(id);
    if (!r) {
      r = { id, dist: 0, timer: 0, recording: false, finished: false, at: null, settledAt: null, goal: null, counters: {}, hr: null };
      runs.set(id, r);
    }
    return r;
  }

  const live = (runner) => [...pledges.values()].filter((p) => p.runner === runner && ['active', 'charged', 'failed', 'skipped'].includes(p.status));

  function tally(runner) {
    const r = run(runner);
    const km = r.dist / 1000;
    const list = live(runner);
    // Before settlement a pledge counts at rate × km; afterwards only real charges count.
    // In goal mode "raised" is what would be charged if the run settled now: the money at stake.
    const owed = list.map((p) => (p.status === 'active' ? owedFor(p, r, km) : p.status === 'charged' ? p.amount : 0));
    const t = {
      runner,
      currency,
      mode: r.goal ? 'goal' : 'perKm',
      km: round2(km),
      recording: r.recording,
      finished: r.finished,
      settled: r.settledAt !== null,
      raised: round2(owed.reduce((a, b) => a + b, 0)),
      ratePerKm: round2(list.reduce((a, p) => a + (p.rate ?? 0), 0)),
      pledgers: list.length,
      milestone,
      updatedAt: r.at,
      hr: r.hr && r.at && now() - r.at < 20000 ? r.hr : null,
      pledges: list.map((p, i) => ({ name: p.name, kind: p.kind ?? 'perKm', rate: p.rate, cap: p.cap, stake: p.stake, amount: owed[i], status: p.status })),
    };
    if (r.goal) {
      const progress = r.goal.logged + done(r);
      Object.assign(t, {
        name: r.goal.name ?? runner,
        payOn: r.goal.payOn ?? 'miss',
        unit: r.goal.unit,
        target: r.goal.target,
        logged: r.goal.logged,
        label: r.goal.label,
        progress: round2(progress),
        goalMet: progress >= r.goal.target,
        stakeTotal: round2(list.reduce((a, p) => a + (p.stake ?? 0), 0)),
      });
    }
    return t;
  }

  // Words the watch can render: plain ASCII only.
  const UNIT_WORDS = { km: 'km', steps: 'steps', floors: 'floors', minutes: 'active min' };
  const dollars = (x) => `$${Number(x || 0).toFixed(2)}`;
  const amount = (x, unit) => (unit === 'km' ? Number(x).toFixed(1) : Math.ceil(x).toLocaleString('en-CA'));

  //! At most one thing worth a watch notification since the last check: the goal was just met,
  //! someone new backed it, or (no more than every nudgeEveryMin minutes) a reminder of what is
  //! still at stake. The server remembers what it has announced, because a watch background task
  //! cannot write to storage.
  function nudgeFor(runner) {
    const r = run(runner);
    const t = tally(runner);
    const seen = (r.nudged ??= { pledgers: 0, goalMet: false, behindAt: 0 });
    const out = {};
    const left = t.mode === 'goal' ? Math.max(0, t.target - t.progress) : 0;
    const charity = t.payOn === 'progress';
    if (t.mode === 'goal' && t.goalMet && !seen.goalMet) {
      const body = charity
        ? `${dollars(t.stakeTotal)} raised for charity`
        : `${dollars(t.stakeTotal)} saved for your ${t.pledgers === 1 ? 'backer' : 'backers'}`;
      Object.assign(out, { title: 'Goal met!', body });
      seen.goalMet = true;
    } else if (t.pledgers > seen.pledgers) {
      const fresh = t.pledgers - seen.pledgers;
      const newest = live(runner).filter((p) => p.confirmedAt).sort((a, b) => b.confirmedAt - a.confirmedAt)[0];
      const who = fresh === 1 && newest ? newest.name : `${fresh} new ${t.mode === 'goal' ? 'backers' : 'sponsors'}`;
      out.title = fresh === 1 && newest ? `${who} backed you` : who;
      out.body = t.mode !== 'goal'
        ? `${dollars(t.ratePerKm)} per km pledged`
        : charity
          ? `${dollars(t.raised)} raised so far, ${amount(left, t.unit)} ${UNIT_WORDS[t.unit]} to go`
          : `${dollars(t.raised)} now at stake, ${amount(left, t.unit)} ${UNIT_WORDS[t.unit]} to go`;
    } else if (t.mode === 'goal' && !t.goalMet && t.stakeTotal > 0 && now() - seen.behindAt >= nudgeEveryMin * 60000) {
      const body = charity
        ? `${dollars(t.stakeTotal - t.raised)} more for charity if you finish`
        : `${dollars(t.raised)} of your backers' money is at stake`;
      Object.assign(out, { title: `${amount(left, t.unit)} ${UNIT_WORDS[t.unit]} to go`, body });
      seen.behindAt = now();
    }
    seen.pledgers = t.pledgers;
    persist();
    return out;
  }

  async function settle(runner) {
    const r = run(runner);
    r.finished = true;
    const km = r.dist / 1000;
    const results = [];
    // One at a time: Helcim allows only 5 concurrent calls per account.
    for (const p of live(runner)) {
      if (p.status === 'charged' || p.status === 'skipped') {
        results.push({ id: p.id, name: p.name, status: p.status, amount: p.amount, transactionId: p.transactionId ?? null });
        continue;
      }
      const amount = owedFor(p, r, km);
      if (amount < MIN_CHARGE) {
        Object.assign(p, { status: 'skipped', amount });
      } else {
        // Reuse the key on retry so Helcim never charges the same pledge twice.
        p.idempotencyKey ??= randomUUID();
        try {
          const out = await helcim.charge({
            cardToken: p.cardToken,
            customerCode: p.customerCode,
            amount,
            currency,
            ipAddress: p.ip,
            idempotencyKey: p.idempotencyKey,
          });
          if (isApproved(out.status)) Object.assign(p, { status: 'charged', amount, transactionId: String(out.transactionId), error: null });
          else Object.assign(p, { status: 'failed', amount, error: `declined (${out.status})` });
        } catch (err) {
          Object.assign(p, { status: 'failed', amount, error: err.message });
        }
      }
      results.push({ id: p.id, name: p.name, status: p.status, amount: p.amount, transactionId: p.transactionId ?? null, error: p.error ?? null });
    }
    r.settledAt = now();
    persist();
    return { runner, km: round2(km), results, total: round2(results.filter((x) => x.status === 'charged').reduce((a, x) => a + x.amount, 0)) };
  }

  function authorized(req) {
    if (!relayKey) return true;
    const given = Buffer.from(String(req.headers['x-relay-key'] ?? ''));
    const want = Buffer.from(relayKey);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  // Forwarding headers are believed only behind a proxy you run (TRUST_PROXY=1, for example a
  // tunnel); otherwise anyone could choose the IP address Helcim records for their payment.
  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress || '0.0.0.0';
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://pledgepace');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && PAGES[path]) {
        const html = await readFile(join(HERE, '..', 'web', PAGES[path]));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (req.method === 'GET' && ASSETS[path]) {
        const [file, type] = ASSETS[path];
        const body = await readFile(join(HERE, '..', 'web', file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' });
        return res.end(body);
      }
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      // Browsers cannot send a cross-site application/json POST without a CORS preflight, which
      // this server never approves, so requiring it blocks cross-site form posts.
      if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) {
        return send(res, 415, { error: 'send JSON with content-type: application/json' });
      }
      if (req.method === 'GET' && path === '/api/config') {
        // A bare pledge link (no ?runner=) goes to DEFAULT_RUNNER, else the most recently set open goal.
        const latest = [...runs.values()].filter((r) => r.goal && !r.finished).sort((a, b) => (b.goal.setAt ?? 0) - (a.goal.setAt ?? 0))[0];
        return send(res, 200, { mock: helcim.mock, currency, milestone, defaultRunner: defaultRunner || latest?.id || 'runner-1' });
      }

      let m = path.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        if (!ID_RE.test(m[1])) return send(res, 400, { error: 'bad runner id' });
        return send(res, 200, tally(m[1]));
      }

      // Sponsor: start a pledge. The secretToken never leaves the server.
      if (req.method === 'POST' && path === '/api/pledges') {
        const b = await readJson(req);
        const name = typeof b.name === 'string' ? b.name.trim().slice(0, 40) : '';
        if (typeof b.runner !== 'string' || !ID_RE.test(b.runner)) return send(res, 400, { error: 'bad runner id' });
        if (!name) return send(res, 400, { error: 'name is required' });
        // The backer must tick the authorization box; the page shows exactly what may be charged.
        if (b.consent !== true) return send(res, 400, { error: 'please tick the box authorizing the charge' });
        const target = run(b.runner);
        let terms;
        if (target.goal) {
          const stake = round2(Number(b.stake));
          if (!(stake >= MIN_CHARGE && stake <= MAX_STAKE)) return send(res, 400, { error: `stake must be between ${MIN_CHARGE} and ${MAX_STAKE}` });
          terms = { kind: 'stake', stake };
        } else {
          const rate = round2(Number(b.rate));
          const cap = round2(Number(b.cap));
          if (!(rate > 0 && rate <= MAX_RATE)) return send(res, 400, { error: `rate must be between 0.01 and ${MAX_RATE} per km` });
          if (!(cap >= MIN_CHARGE && cap <= MAX_CAP)) return send(res, 400, { error: `cap must be between ${MIN_CHARGE} and ${MAX_CAP}` });
          terms = { kind: 'perKm', rate, cap };
        }
        if (target.finished) return send(res, 409, { error: 'this run has finished' });
        const session = await helcim.startVerify({ contactName: name, currency });
        const p = {
          id: randomUUID(), runner: b.runner, name, ...terms, status: 'pending', ip: clientIp(req), consentAt: now(),
          checkoutToken: session.checkoutToken, secretToken: session.secretToken, createdAt: now(),
        };
        pledges.set(p.id, p);
        persist();
        return send(res, 201, { pledgeId: p.id, checkoutToken: p.checkoutToken, mock: helcim.mock });
      }

      // Sponsor: hand back the HelcimPay.js result so the server can verify the hash.
      m = path.match(/^\/api\/pledges\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && m) {
        const p = pledges.get(m[1]);
        if (!p) return send(res, 404, { error: 'no such pledge' });
        if (p.status !== 'pending') return send(res, 409, { error: `pledge is already ${p.status}` });
        const b = await readJson(req);
        if (helcim.mock) {
          Object.assign(p, { status: 'active', cardToken: 'mock-card', customerCode: 'MOCK', confirmedAt: now() });
        } else {
          let msg = b.eventMessage;
          if (typeof msg === 'string') {
            try { msg = JSON.parse(msg); } catch { msg = null; }
          }
          if (!validResponse(msg, p.secretToken)) return send(res, 400, { error: 'payment response failed hash validation' });
          if (!isApproved(msg.data.status)) return send(res, 402, { error: `card not verified (${msg.data.status})` });
          if (!msg.data.cardToken) return send(res, 400, { error: 'no card token in response' });
          Object.assign(p, { status: 'active', cardToken: msg.data.cardToken, customerCode: msg.data.customerCode || null, confirmedAt: now() });
        }
        delete p.secretToken;
        persist();
        console.log(p.kind === 'stake' ? `stake from ${p.name}: $${p.stake}` : `pledge from ${p.name}: $${p.rate}/km, cap $${p.cap}`);
        return send(res, 200, tally(p.runner));
      }

      // Watch: report distance, get the live total back.
      m = path.match(/^\/api\/runs\/([^/]+)\/telemetry$/);
      if (req.method === 'POST' && m) {
        if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-relay-key' });
        if (!ID_RE.test(m[1])) return send(res, 400, { error: 'bad runner id' });
        const b = await readJson(req);
        const r = run(m[1]);
        if (!r.finished) {
          if (typeof b.dist === 'number' && b.dist >= 0 && b.dist < 1e7) r.dist = b.dist;
          if (typeof b.timer === 'number' && b.timer >= 0) r.timer = b.timer;
          r.recording = b.recording === true;
          r.at = now();
          r.counters ??= {};
          for (const name of ['steps', 'floors', 'zoneSec']) bump(r.counters, name, b[name]);
          r.hr = typeof b.hr === 'number' && b.hr > 20 && b.hr < 260 ? Math.round(b.hr) : null;
        }
        if (b.finished === true && !r.finished) {
          r.finished = true;
          r.recording = false;
          persist();
          if (autoSettle) await settle(m[1]);
        }
        const t = tally(m[1]);
        const reply = { mode: t.mode, raised: t.raised, ratePerKm: t.ratePerKm, pledgers: t.pledgers, milestone, finished: t.finished, settled: t.settled };
        if (t.mode === 'goal') Object.assign(reply, { payOn: t.payOn, unit: t.unit, target: t.target, progress: t.progress, stakeTotal: t.stakeTotal, goalMet: t.goalMet });
        return send(res, 200, reply);
      }

      // Watch background task (every 5+ minutes, even with the app closed): fold in the
      // watch's all-day counters and get back at most one notification to show.
      m = path.match(/^\/api\/runs\/([^/]+)\/nudge$/);
      if (req.method === 'POST' && m) {
        if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-relay-key' });
        if (!ID_RE.test(m[1])) return send(res, 400, { error: 'bad runner id' });
        const b = await readJson(req);
        const r = run(m[1]);
        if (!r.finished) {
          r.counters ??= {};
          for (const name of ['steps', 'floors']) bump(r.counters, name, b[name]);
        }
        return send(res, 200, nudgeFor(m[1]));
      }

      // Organizer: turn on goal mode for a runner. Only before anyone pledges,
      // so no backer's terms ever change after they commit.
      m = path.match(/^\/api\/runs\/([^/]+)\/goal$/);
      if (req.method === 'POST' && m) {
        if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-relay-key' });
        if (!ID_RE.test(m[1])) return send(res, 400, { error: 'bad runner id' });
        const b = await readJson(req);
        // { unit, target, logged } or the older { km, loggedKm }.
        const unit = b.unit ?? 'km';
        const target = round2(Number(b.target ?? b.km));
        const logged = round2(Number(b.logged ?? b.loggedKm ?? 0));
        const label = typeof b.label === 'string' && b.label.trim() ? b.label.trim().slice(0, 30) : 'this week';
        const who = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 30) : m[1];
        const payOn = b.payOn ?? 'miss';
        if (!PAY_ON.includes(payOn)) return send(res, 400, { error: `payOn must be one of ${PAY_ON.join(', ')}` });
        if (!UNITS.includes(unit)) return send(res, 400, { error: `unit must be one of ${UNITS.join(', ')}` });
        if (!(target >= GOAL_MIN[unit] && target <= GOAL_MAX[unit])) return send(res, 400, { error: `goal must be between ${GOAL_MIN[unit]} and ${GOAL_MAX[unit]} ${unit}` });
        if (!(logged >= 0 && logged < target)) return send(res, 400, { error: 'the amount already done must be at least 0 and less than the goal' });
        if ([...pledges.values()].some((p) => p.runner === m[1])) {
          return send(res, 409, { error: 'this runner already has pledges; set the goal before anyone pledges, or use a new runner id' });
        }
        const r = run(m[1]);
        if (r.finished) return send(res, 409, { error: 'this run has finished' });
        r.goal = { unit, target, logged, label, name: who, payOn, setAt: now() };
        r.counters = {}; // sensor progress counts from now
        r.nudged = { pledgers: 0, goalMet: false, behindAt: now() };
        persist();
        return send(res, 200, tally(m[1]));
      }

      // Organizer: charge every pledge for the final distance.
      m = path.match(/^\/api\/runs\/([^/]+)\/settle$/);
      if (req.method === 'POST' && m) {
        if (!authorized(req)) return send(res, 401, { error: 'missing or wrong x-relay-key' });
        if (!ID_RE.test(m[1])) return send(res, 400, { error: 'bad runner id' });
        return send(res, 200, await settle(m[1]));
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      // Only our own request-validation errors reach the caller. Anything else, such as a Helcim
      // error or a file error, is logged here and answered with a generic message.
      if (err.expose) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 502, { error: 'something went wrong on the server or at the payment provider; details are in the server log' });
    }
  }

  return { server: createServer(handle), pledges, runs, settle };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413, expose: true }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('body must be a JSON object'), { status: 400, expose: true }));
      }
    });
    req.on('error', reject);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '127.0.0.1';
  const helcim = createHelcim({ apiToken: process.env.HELCIM_API_TOKEN ?? '' });
  // Fail closed: with real payments and no relay key, anyone who can reach the server could
  // set goals and settle charges. Mock mode stays open for local development.
  if (!helcim.mock && !process.env.RELAY_KEY) {
    console.error('Refusing to start: HELCIM_API_TOKEN is set but RELAY_KEY is not. Set RELAY_KEY so only you can set goals and settle charges.');
    process.exit(1);
  }
  const { server } = createPledgeServer({
    helcim,
    relayKey: process.env.RELAY_KEY ?? '',
    trustProxy: process.env.TRUST_PROXY === '1',
    milestone: Number(process.env.MILESTONE ?? 25),
    autoSettle: process.env.AUTO_SETTLE === '1',
    dataFile: process.env.DATA_FILE ?? join(HERE, 'data', 'state.json'),
    defaultRunner: process.env.DEFAULT_RUNNER ?? '',
    nudgeEveryMin: Number(process.env.NUDGE_EVERY_MIN ?? 60),
  });
  server.listen(port, host, () => {
    console.log(`PledgePace on http://${host}:${port}  (pledge page at /, organizer at /organizer)`);
    console.log(helcim.mock ? 'MOCK MODE: no HELCIM_API_TOKEN, so no real Helcim calls.' : 'Helcim LIVE API: use a developer test account and test cards.');
    if (!process.env.RELAY_KEY) console.log('RELAY_KEY not set: anyone with the URL can settle the run.');
  });
}
