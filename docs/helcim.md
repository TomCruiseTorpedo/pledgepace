# Helcim integration

## Why verify, then charge

What a backer owes isn't known until the goal period ends. So the pledge page runs a **$0 verify** through HelcimPay.js, which checks the card and returns a `cardToken`. At settlement the server charges the amount owed against that token. Card numbers never touch this server; it stores card tokens only.

An alternative is a preauthorization for the maximum, captured for the real amount within 7 days. It shows the backer a hold on their card, which may or may not be what you want.

## The calls this code makes

Taken from Helcim's developer docs as of October 23rd, 2026. Check them again before relying on this.

- **Start a card check:** `POST https://api.helcim.com/v2/helcim-pay/initialize` with `paymentType: "verify"`, `amount: 0`, `currency` and `customerRequest.contactName`. It must be called from the server (CORS). The `checkoutToken` and `secretToken` it returns last 60 minutes; the `secretToken` never leaves the server.
- **Card window:** the page loads `https://secure.helcim.app/helcim-pay/services/start.js`, calls `appendHelcimPayIframe(checkoutToken)`, and listens for `message` events named `helcim-pay-js-<checkoutToken>` with statuses `SUCCESS`, `ABORTED` and `HIDE`.
- **Response check:** `sha256(JSON(data) + secretToken)`. The server accepts plain, ASCII-escaped and PHP-style (`\/`) JSON encodings, because Helcim's own samples differ.
- **Charge:** `POST https://api.helcim.com/v2/payment/purchase` with the `api-token` header and an `idempotency-key` header (25 to 36 characters; a UUID, reused if the same charge is retried). Body: `amount` in decimal dollars (not cents), `currency`, `ipAddress`, `ecommerce: true`, `customerCode` and `cardData.cardToken`.
- **Declines** arrive as HTTP 200 with a non-approved `status`. Helcim's docs use both `APPROVED` and `APPROVAL`, and both are accepted.
- **Rate limit:** 5 concurrent calls per account, so settlement charges one backer at a time.
- **No split payments:** every charge settles into one merchant account (the organizer's or a charity's).

## Running against a Helcim developer test account

1. Ask Helcim for a developer test account; their [developer testing](https://devdocs.helcim.com/docs/developer-testing) page explains how. It requires an existing merchant ID.
2. Create an API Access Configuration in the test account and copy its `api-token`.
3. HelcimPay.js does not render on localhost and needs HTTPS, so expose the server through a tunnel, for example `ngrok http 8788`.
4. Copy `server/.env.example` to `server/.env`, set `HELCIM_API_TOKEN` and `RELAY_KEY`, and run `node --env-file=.env server.mjs`.
5. Pledge with one of Helcim's [test card numbers](https://devdocs.helcim.com/docs/test-credit-card-numbers).

There is no separate sandbox host: test accounts use the production API. **Never put a live account's token in this project.**

## Open questions

- Whether a $0 verify response reports `status` as `APPROVED`. The code assumes it; a test card would settle it.
- Whether Helcim accepts a tunnel's `ipAddress` on test purchases. Behind a tunnel the socket address is the tunnel itself; set `TRUST_PROXY=1` to send the `X-Forwarded-For` / `CF-Connecting-IP` address instead (only behind a proxy you run, or anyone could choose the IP Helcim records).
