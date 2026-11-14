// Thin Helcim client: HelcimPay.js checkout sessions, response validation and
// card-token charges. Field names were checked against devdocs.helcim.com
// (llms.txt index and the .md twins) on 2026-10-23. Re-check before shipping.
//
// With no API token the client runs in mock mode, so the team can build and
// demo the whole flow before a Helcim developer test account is ready.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const API = 'https://api.helcim.com/v2';

// The live docs disagree with themselves: the purchase schema says APPROVED,
// the HelcimPay.js hash example says APPROVAL. Accept both.
const APPROVED = new Set(['APPROVED', 'APPROVAL']);
export const isApproved = (status) => APPROVED.has(String(status ?? '').toUpperCase());

// HelcimPay.js signs its response as sha256(JSON(data) + secretToken).
// Helcim's PHP example escapes "/" and non-ASCII characters; JSON.stringify
// does neither. Accept any of the three encodings.
export function hashCandidates(data, secretToken) {
  const plain = JSON.stringify(data);
  const ascii = plain.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const php = ascii.replace(/\//g, '\\/');
  return [...new Set([plain, ascii, php])].map((s) => createHash('sha256').update(s + secretToken).digest('hex'));
}

export function validResponse(message, secretToken) {
  const given = Buffer.from(String(message?.hash ?? '').toLowerCase());
  if (!message?.data || typeof message.data !== 'object' || given.length !== 64) return false;
  return hashCandidates(message.data, secretToken).some((h) => timingSafeEqual(Buffer.from(h), given));
}

function describeErrors(errors) {
  if (!errors) return '';
  if (typeof errors === 'string') return errors;
  if (Array.isArray(errors)) return errors.join('; ');
  return Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join('; ');
}

export function createHelcim({ apiToken = '', fetchImpl = fetch } = {}) {
  const mock = !apiToken;

  async function call(path, body, headers = {}) {
    const res = await fetchImpl(API + path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'api-token': apiToken, ...headers },
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // fall through with json = null
    }
    if (!res.ok || json?.errors) {
      const err = new Error(describeErrors(json?.errors) || `Helcim answered HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    mock,

    // A $0 "verify" checkout: HelcimPay.js checks the card and returns a
    // cardToken we can charge later, once the run's distance is known.
    // Must be called from the server: Helcim rejects browser-side calls (CORS).
    async startVerify({ contactName, currency = 'CAD' }) {
      if (mock) {
        return { checkoutToken: 'mock_' + randomBytes(8).toString('hex'), secretToken: randomBytes(12).toString('hex') };
      }
      const out = await call('/helcim-pay/initialize', {
        paymentType: 'verify',
        amount: 0,
        currency,
        customerRequest: { contactName },
      });
      return { checkoutToken: out.checkoutToken, secretToken: out.secretToken };
    },

    // Charge a stored card token. Declines come back as HTTP 200 with a
    // non-approved status, so callers must check isApproved(result.status).
    async charge({ cardToken, customerCode, amount, currency = 'CAD', ipAddress, idempotencyKey }) {
      if (mock) {
        return { transactionId: 'mock-' + randomBytes(4).toString('hex'), status: 'APPROVED', amount, currency };
      }
      const body = { ipAddress, ecommerce: true, amount, currency, cardData: { cardToken } };
      if (customerCode) body.customerCode = customerCode;
      return call('/payment/purchase', body, { 'idempotency-key': idempotencyKey });
    },
  };
}
