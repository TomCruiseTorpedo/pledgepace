// Simulated Helcim, for demos without a Helcim account (HELCIM_SIMULATE=1).
//
// An in-process stand-in for the two Helcim API calls this project makes, plus a stand-in for
// the HelcimPay.js card window. It exists so that the REAL client (helcim.mjs), the REAL
// response-hash check and the REAL settlement code all run end to end. It is not Helcim and
// does not look like Helcim: every screen it serves says "simulated".
//
// Card safety: the card window accepts only Helcim's published test card number. The page
// refuses any other number before sending it, the server refuses it again, and no card number
// is ever stored or logged; only a masked form appears in the signed response.
import { createHash, randomBytes } from 'node:crypto';

// Helcim's published Visa test card (devdocs.helcim.com/docs/test-credit-card-numbers).
export const TEST_CARD = '4124939999999990';
const digits = (s) => String(s ?? '').replace(/\D/g, '');

export function createHelcimSimulator() {
  const checkouts = new Map(); // checkoutToken -> { secretToken, currency, used }
  const purchases = new Map(); // idempotency key -> purchase response
  let txn = 70000;

  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  // Card tokens are recognizable by prefix, so a server restart doesn't orphan them.
  // 'mock-card' comes from pledges made in plain mock mode.
  const knownToken = (t) => typeof t === 'string' && (t.startsWith('simtok_') || t === 'mock-card');

  //! Answers the client's fetch() calls the way api.helcim.com/v2 does.
  async function fetchImpl(url, init = {}) {
    const headers = init.headers || {};
    const body = JSON.parse(init.body || '{}');
    if (!headers['api-token']) return reply({ errors: 'missing api-token' }, 401);
    if (url.endsWith('/helcim-pay/initialize')) {
      const checkoutToken = 'sim_' + randomBytes(8).toString('hex');
      const secretToken = randomBytes(12).toString('hex');
      checkouts.set(checkoutToken, { secretToken, currency: body.currency || 'CAD', used: false });
      return reply({ checkoutToken, secretToken });
    }
    if (url.endsWith('/payment/purchase')) {
      const key = String(headers['idempotency-key'] ?? '');
      if (key.length < 25 || key.length > 36) return reply({ errors: 'idempotency-key must be 25 to 36 characters' }, 400);
      if (purchases.has(key)) return reply(purchases.get(key)); // same key, same answer, no second charge
      if (!knownToken(body?.cardData?.cardToken)) return reply({ errors: 'unknown card token' }, 400);
      const out = { transactionId: ++txn, status: 'APPROVED', type: 'purchase', amount: body.amount, currency: body.currency };
      purchases.set(key, out);
      return reply(out);
    }
    return reply({ errors: 'endpoint not simulated' }, 404);
  }

  //! Serves /sim-helcim/*. Returns false for any other path.
  async function handle(req, res, path, { readJson, send }) {
    if (req.method === 'GET' && path === '/sim-helcim/start.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(START_JS);
      return true;
    }
    if (req.method === 'GET' && path === '/sim-helcim/pay') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAY_HTML);
      return true;
    }
    if (req.method === 'POST' && path === '/sim-helcim/pay') {
      const b = await readJson(req);
      const c = checkouts.get(b.checkoutToken);
      if (!c) { send(res, 404, { error: 'unknown or expired checkout' }); return true; }
      if (c.used) { send(res, 409, { error: 'this checkout was already used' }); return true; }
      if (digits(b.cardNumber) !== TEST_CARD) {
        send(res, 400, { error: "This simulated window accepts only Helcim's test card, 4124 9399 9999 9990." });
        return true;
      }
      if (!/^\d{2}\s*\/?\s*\d{2}$/.test(String(b.expiry ?? '').trim()) || !/^\d{3,4}$/.test(String(b.cvv ?? '').trim())) {
        send(res, 400, { error: 'Enter an expiry as MM/YY and a 3 or 4 digit CVV.' });
        return true;
      }
      c.used = true;
      if (b.decline === true) {
        send(res, 200, { eventStatus: 'ABORTED', eventMessage: 'Card declined (simulated)' });
        return true;
      }
      const data = {
        transactionId: String(++txn),
        status: 'APPROVED',
        type: 'verify',
        amount: '0.00',
        currency: c.currency,
        cardToken: 'simtok_' + randomBytes(8).toString('hex'),
        cardNumber: '4124********9990',
        customerCode: 'SIM' + randomBytes(3).toString('hex').toUpperCase(),
      };
      // Signed exactly as HelcimPay.js signs: sha256(JSON(data) + secretToken).
      const hash = createHash('sha256').update(JSON.stringify(data) + c.secretToken).digest('hex');
      send(res, 200, { eventStatus: 'SUCCESS', eventMessage: { data, hash } });
      return true;
    }
    return false;
  }

  return { fetchImpl, handle, purchaseCount: () => purchases.size };
}

// The two functions the real HelcimPay.js script provides, opening the simulated window instead.
const START_JS = `// Simulated stand-in for HelcimPay.js (PledgePace, HELCIM_SIMULATE=1). Not Helcim.
(function () {
  var overlay = null;
  window.appendHelcimPayIframe = function (checkoutToken) {
    window.removeHelcimPayIframe();
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px';
    var frame = document.createElement('iframe');
    frame.src = '/sim-helcim/pay?checkoutToken=' + encodeURIComponent(checkoutToken);
    frame.title = 'Simulated card window';
    frame.style.cssText = 'width:min(420px,100%);height:min(660px,100%);border:0;border-radius:18px;background:transparent';
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  };
  window.removeHelcimPayIframe = function () {
    if (overlay) { overlay.remove(); overlay = null; }
  };
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    var d = e.data || {};
    if (typeof d.eventName === 'string' && d.eventName.indexOf('helcim-pay-js-') === 0 && d.eventStatus === 'HIDE') window.removeHelcimPayIframe();
  });
})();
`;

const PAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Simulated card window</title>
<style>
:root{--bg:#ffffff;--ink:#141714;--muted:#5b625c;--line:#d8ddd5;--accent:#c2410c;--ok:#1f7a3a;--warn-bg:#fff4e5;--warn:#8a5a00;--f:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#111513;--ink:#e8ede9;--muted:#98a29b;--line:#2b332e;--accent:#ff7a3d;--ok:#5fd17e;--warn-bg:#2a2112;--warn:#f2b44b;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:var(--bg);color:var(--ink);font:16px/1.45 var(--f);border-radius:18px;overflow:auto}
.banner{background:var(--warn-bg);color:var(--warn);font:700 12px/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:10px 16px;border-bottom:1px solid var(--line)}
main{padding:16px 18px 18px;display:grid;gap:12px}
h1{font-size:19px;margin:0}
p{margin:0;color:var(--muted);font-size:14px}
label{display:grid;gap:6px;font-weight:600;font-size:14px}
input{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:10px;padding:11px 12px;width:100%;min-height:44px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.check{display:flex;gap:10px;align-items:center;font-weight:400}
.check input{width:20px;height:20px;min-height:0}
button{font:700 16px/1 var(--f);border-radius:10px;min-height:48px;cursor:pointer}
.go{background:var(--accent);color:#fff;border:0}
.quiet{background:transparent;color:var(--ink);border:1px solid var(--line)}
.fill{justify-self:start;font:600 14px/1 var(--f);min-height:36px;padding:0 12px;background:transparent;border:1px dashed var(--line);color:var(--ink)}
button:focus-visible,input:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.msg{min-height:1.4em;font-weight:600}
.msg.ok{color:var(--ok)} .msg.err{color:var(--accent)}
</style>
</head>
<body>
<div class="banner">Simulated card window · test mode · not Helcim · nothing is charged</div>
<main>
  <h1>Verify a card ($0)</h1>
  <p>This stands in for Helcim's secure card window. It accepts only Helcim's test card number; any other number is refused here and never sent.</p>
  <button type="button" class="fill" id="fill">Fill in the test card</button>
  <form id="form" novalidate>
    <div style="display:grid;gap:14px">
      <label>Card number <input id="num" inputmode="numeric" autocomplete="off" placeholder="4124 9399 9999 9990"></label>
      <div class="row">
        <label>Expiry (MM/YY) <input id="exp" inputmode="numeric" autocomplete="off" placeholder="01/28"></label>
        <label>CVV <input id="cvv" inputmode="numeric" autocomplete="off" placeholder="100"></label>
      </div>
      <label class="check"><input type="checkbox" id="decline"> Simulate a declined card</label>
      <div class="msg" id="msg" role="status"></div>
      <button class="go" id="go">Verify card</button>
      <button type="button" class="quiet" id="cancel">Cancel</button>
    </div>
  </form>
</main>
<script>
var token = new URLSearchParams(location.search).get('checkoutToken') || '';
var TEST = '4124939999999990';
function $(id) { return document.getElementById(id); }
function say(t, k) { $('msg').textContent = t; $('msg').className = 'msg ' + (k || ''); }
function tell(status, message) { parent.postMessage({ eventName: 'helcim-pay-js-' + token, eventStatus: status, eventMessage: message }, location.origin); }
$('fill').onclick = function () { $('num').value = '4124 9399 9999 9990'; $('exp').value = '01/28'; $('cvv').value = '100'; say(''); };
$('cancel').onclick = function () { tell('HIDE', ''); };
$('form').onsubmit = function (e) {
  e.preventDefault();
  var num = $('num').value.replace(/\\D/g, '');
  if (num !== TEST) { say("Only Helcim's test card works here: 4124 9399 9999 9990.", 'err'); return; } // never sent
  $('go').disabled = true; say('Verifying…');
  fetch('/sim-helcim/pay', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ checkoutToken: token, cardNumber: num, expiry: $('exp').value, cvv: $('cvv').value, decline: $('decline').checked }) })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (x) {
      if (!x.ok) { $('go').disabled = false; say(x.j.error || 'Something went wrong.', 'err'); return; }
      if (x.j.eventStatus === 'SUCCESS') {
        say('Card verified. Nothing was charged.', 'ok');
        tell('SUCCESS', x.j.eventMessage);
        setTimeout(function () { tell('HIDE', ''); }, 1200);
      } else {
        say('Card declined (simulated). Nothing was charged.', 'err');
        tell('ABORTED', x.j.eventMessage);
      }
    })
    .catch(function () { $('go').disabled = false; say('Could not reach the server.', 'err'); });
};
</script>
</body>
</html>
`;
