# HTTP API

All bodies are JSON. Routes marked **key** need the `x-relay-key` header when `RELAY_KEY` is set. Runner ids are 1 to 40 letters, digits, `-` or `_`.

## Pages

| Route | What |
| --- | --- |
| `GET /` | Pledge page. `?runner=<id>` picks the goal; without it the page opens `DEFAULT_RUNNER` or the most recently set open goal. |
| `GET /organizer` | Dashboard: set a goal, watch progress, settle. |
| `GET /manifest.webmanifest`, `/icon.svg`, `/icon-*.png` | Add to Home Screen support. |
| `GET /health` | `{ "ok": true }` |

## Reading

`GET /api/config` returns `{ mock, currency, milestone, defaultRunner }`.

`GET /api/runs/:runner` returns the live tally:

```json
{
  "runner": "jj", "mode": "goal", "currency": "CAD",
  "name": "JJ", "unit": "steps", "target": 8000, "logged": 0, "label": "today",
  "progress": 5200, "goalMet": false,
  "raised": 10.5, "stakeTotal": 30, "pledgers": 2, "hr": 128,
  "finished": false, "settled": false, "updatedAt": 1794680000000,
  "pledges": [{ "name": "Sam", "kind": "stake", "stake": 20, "amount": 7, "status": "active" }]
}
```

In goal mode `raised` is what would be charged if the run settled now: the money still at stake. Runners without a goal report `mode: "perKm"`, `km`, `ratePerKm` and per-km pledges instead.

## Goals

`POST /api/runs/:runner/goal` (**key**)

```json
{ "unit": "steps", "target": 8000, "logged": 0, "label": "today", "name": "JJ" }
```

- `unit` is `steps`, `floors`, `minutes` or `km`. Limits: steps 100 to 500,000; floors 1 to 1,000; minutes 1 to 3,000; km 0.5 to 300.
- `logged` is progress made before the goal was set and must be less than `target`.
- Refused with 409 once anyone has pledged on the runner: backers' terms never change. Use a new runner id to start over.
- Sensor progress (steps, floors, minutes) counts from the first watch reading after the goal is set.

## Pledges

`POST /api/pledges`

```json
{ "runner": "jj", "name": "Sam", "stake": 20, "consent": true }
```

For a runner without a goal, send `rate` (dollars per km, up to 20) and `cap` (1 to 500) instead of `stake` (1 to 500). `consent: true` is required; without it the server answers 400 and contacts nobody. The reply is `{ pledgeId, checkoutToken, mock }`. The page opens the HelcimPay.js card window with `checkoutToken`, or confirms straight away in mock mode.

`POST /api/pledges/:id/confirm` with `{ "eventMessage": <HelcimPay.js SUCCESS message> }` validates the response hash, stores the card token and returns the tally.

## Watch

`POST /api/runs/:runner/telemetry` (**key**), every 5 seconds while the app is open:

```json
{ "recording": true, "dist": 1520.4, "timer": 610000, "steps": 5230, "floors": 3, "zoneSec": 240, "hr": 131, "finished": false }
```

`steps` and `floors` are the watch's all-day counters and `zoneSec` counts seconds at or above zone 2 since the app started. The server turns each into progress since the goal was set, and treats a drop (midnight, an app restart) as a counter reset rather than going backwards. `finished: true` ends the run. The reply carries the live numbers the watch shows.

`POST /api/runs/:runner/nudge` (**key**), from the background task every 5 minutes, with `{ steps, floors }`. Returns at most one notification, `{ "title": "Sam backed you", "body": "$20.00 now at stake, 2,800 steps to go" }`, or `{}`. In priority order: the goal was just met; someone new backed it; a reminder of the money still at stake, no more often than `NUDGE_EVERY_MIN`. The server remembers what it has announced, because a watch background task cannot write storage.

## Settlement

`POST /api/runs/:runner/settle` (**key**) charges every active pledge through Helcim, one at a time, each with its own idempotency key, so running it again never charges twice. Amounts under $1 are skipped; a met goal releases every stake. Returns `{ results, total }`.
