# PledgePace

**2026 Tech Thursday x Garmin Hackathon · JJ's For Shiggles Project**

Put your friends' money where your feet are. PledgePace turns an activity goal into a promise your friends back with real money, tracked by your Garmin watch and paid through Helcim. You pick how backers pay:

- **Commitment:** each backer pays only for the share of the goal you **miss**. Hit the goal and nobody pays; every step lowers what your friends stand to lose.
- **Charity:** each backer gives for the share you **complete**. Every step raises money, and finishing gives every full stake to the cause.

![Three PledgePace watch screens (money at stake with a progress ring, a "Sam backed you" notification, GOAL MET) next to the pledge page on a phone](docs/screenshots/hero.png)

> **Status:** side project. It runs end to end in the Connect IQ simulator and the browser, with Helcim in mock or simulated mode. It has not run on a physical watch or against a real Helcim account yet. See [What's verified](#whats-verified).

**Try it in two minutes:** `git clone https://github.com/TomCruiseTorpedo/pledgepace && cd pledgepace/server && node tour.mjs` runs the whole story with a check on every step (Node 20+, nothing to install, nothing real charged). More ways to play, including a click-around server and the watch simulator, are in [TRY-IT.md](TRY-IT.md). **AI agents:** start with [AGENTS.md](AGENTS.md) or [llms.txt](llms.txt).

## The problem

The hackathon brief: *"Build something that would make your own Health & Wellness better. You're the user."*

The struggle PledgePace takes on is **staying active**. Goals are easy to set and just as easy to quietly skip, because skipping costs nothing and nobody notices. PledgePace adds the two things a skipped goal is missing: **something at stake** and **people who are watching**. Friends back the goal with money; the watch measures progress with its own sensors, so nobody self-reports; and the stakes stay visible on your wrist all day.

## How it works

1. **Set a goal** on the dashboard (`/organizer`): 8,000 steps today, 20 floors, 150 active minutes or 20 km this week. Choose commitment or charity.
2. **Share the pledge link.** Friends pick a stake, tick a box authorizing at most that amount, and enter a card in the payment window. The card is checked with a $0 verify; nothing is charged yet.
3. **Move.** The watch counts progress, shows the money at stake (or raised) inside a progress ring, and nudges you: "Sam backed you", "2,000 steps to go", "Goal met!".
4. **Settle.** Each backer is charged their stake times the share missed (commitment) or the share completed (charity), once, through Helcim.

## How PledgePace answers the brief

| Criterion | How PledgePace addresses it |
| --- | --- |
| **Problem-solution fit** | Targets one concrete struggle, staying active, and attacks the reason goals slip: there is no cost to skipping and nobody notices. |
| **Execution and deployment** | Runs end to end today: the watch app in the Connect IQ simulator, a server phones reach over an HTTPS tunnel, and a pledge page that works on any phone. 38 automated tests cover the money rules and run in CI on every push. |
| **User experience and design** | One number on the wrist (money at stake or raised) with a progress ring; a phone-first pledge page with a single pinned button and Add to Home Screen; consent text that states the most anyone can be charged. |
| **Impact on habits** | Uses well-known behaviour levers: something to lose, people who care, and immediate feedback on every step. Nudges come from a Connect IQ background task, designed to reach you even when the app is closed. The charity mode turns the same mechanics into giving. |
| **Creativity and approach** | Combines wearable sensing with real payments: friends' money moves only on what the watch measured, and the same goal can be framed as a personal commitment or a fundraiser. |
| **Sensors in real use** | Four Garmin sensors each drive a goal type: accelerometer (steps), barometer (floors), heart rate (time in zone 2) and GPS (kilometres). |

## Built on Garmin Connect IQ

The watch app is a Connect IQ **device app** written in Monkey C, built with SDK 9.1.0 for fēnix 7, fēnix 7 Pro, Forerunner 265 and 965 and Venu 3.

| Goal unit | Sensor | Connect IQ API |
| --- | --- | --- |
| Steps | Accelerometer | `ActivityMonitor.getInfo().steps`, the watch's all-day count |
| Floors | Barometer | `ActivityMonitor.getInfo().floorsClimbed` |
| Active minutes | Heart rate | `Sensor.getInfo().heartRate`, timed against the wearer's zone 2 from `UserProfile.getHeartRateZones()` |
| Kilometres | GPS | `Position` events and the recorded activity's distance |

Also used: `Communications.makeWebRequest` for telemetry; `ActivityRecording` and `FitContributor` to save each run with custom FIT fields; `Background` temporal events and the `Notifications` API (5.1 and later) for nudges; `Attention` for the goal-met buzz and tone; and a round-screen layout that fits text to the circle and draws progress on the bezel.

## Built on Helcim

| Need | Helcim feature |
| --- | --- |
| Check a backer's card without charging it | HelcimPay.js with a $0 `verify` checkout, started server-side through `POST /v2/helcim-pay/initialize` |
| Keep card numbers off this server | The card is entered in Helcim's window; the server keeps only the returned card token |
| Trust the result | Each HelcimPay.js response is validated against its `sha256(data + secretToken)` signature; the secret never leaves the server |
| Charge the right amount later | `POST /v2/payment/purchase` against the saved card token, in decimal dollars |
| Never charge twice | An idempotency key per charge, reused on retry, plus a guard that skips anything already charged |
| Stay inside limits | Settlement runs one charge at a time, under Helcim's 5 concurrent calls |

Details, and how to run against a Helcim developer test account, are in [docs/helcim.md](docs/helcim.md).

## Architecture

```
pledge page ── POST /api/pledges (consent) ──▶ server ── /helcim-pay/initialize ($0 verify) ──▶ Helcim
   │ HelcimPay.js card window ◀── checkoutToken ──┘
   └─ POST /api/pledges/:id/confirm (signed) ──▶ server checks the hash, keeps only the card token

watch ── POST /api/runs/:id/telemetry {steps, floors, zoneSec, km} ──▶ server ──▶ { at stake or raised, progress, backers }
watch background task, every 5 min ── POST /api/runs/:id/nudge ──▶ server ──▶ { "Sam backed you" }

dashboard ── POST /api/runs/:id/settle ──▶ server ── /payment/purchase per backer (idempotent) ──▶ Helcim
```

### Key design decisions

- **A device app, not a data field.** Only a device app can make network requests while showing its own full-screen UI and recording an activity.
- **The server owns the money; the watch only reports.** Every amount is computed in one place, from measured progress, so it can be tested and audited. The watch never decides what anyone pays.
- **Verify now, charge later.** What a backer owes isn't known until the goal ends, so the pledge stores a card token from a $0 verify and charges once at settlement. A preauthorization for the maximum was considered and left out: it would put a hold on every backer's card until settlement.
- **Terms can't change after someone commits.** A goal locks as soon as anyone backs it, every pledge records explicit consent to a stated maximum, and stakes are capped at $500.
- **Trust the watch's own counters.** Steps and floors come from the watch's all-day totals and count from the moment the goal is set. A drop (midnight, an app restart) starts a new segment instead of counting backwards.
- **Nudges are remembered server-side.** Connect IQ background tasks run at most every 5 minutes and cannot write to storage, so the server remembers what it has already announced and replies with at most one notification.
- **Polling, not push.** Watch requests travel through the paired phone; a 5-second poll is simple, survives reconnects, and needs no extra infrastructure.
- **Real code path in every mode.** Mock mode skips Helcim entirely for quick local work. Simulated mode runs the real Helcim client, signature check and settlement against an in-process fake with a clearly labelled card window. Live mode talks to Helcim.
- **No dependencies.** The server is plain Node 20+ with a JSON state file: nothing to install, a small attack surface, and easy to run anywhere.
- **Safe by default when exposed.** A relay key protects goal setup, telemetry and settlement; the server refuses to start with a real Helcim token and no key; every POST must be JSON; forwarded client IPs are believed only behind a trusted proxy; errors reach callers as generic messages.

## Quick start

```bash
cd server
node server.mjs
```

That runs in mock mode with no Helcim account needed. Then:

1. Open `http://127.0.0.1:8788/organizer`, pick **Steps**, choose commitment or charity, set a goal of 1000 and your name, and press **Set goal**.
2. Open `http://127.0.0.1:8788` and back the goal once or twice.
3. Simulate a walk from a second terminal:

```bash
SPEED_UP=30 node fake-runner.mjs http://127.0.0.1:8788 <runner-id> --finish-at=1
```

4. Press **Settle now** on the dashboard.

To see the full payment flow with a card window, start it with `HELCIM_SIMULATE=1 node server.mjs` and use Helcim's test card `4124 9399 9999 9990` (the window has a button that fills it in; no other number is accepted).

Tests: `cd server && npm test`.

### On a watch (or the simulator)

1. Install the [Connect IQ SDK Manager](https://developer.garmin.com/connect-iq/sdk/), SDK 9.1.0 or later, and the device profiles you need; then VS Code with Garmin's Monkey C extension and a developer key.
2. In `watch/resources/settings/properties.xml` set `serverUrl`, `runnerId` and `relayKey`. Sideloaded apps never receive settings from the phone, so these are built in.
3. Build `watch/` for your device and run it in the simulator, or sideload the `.prg`.

The full simulator walkthrough (driving steps, floors and heart rate, firing a nudge on cue) and its gotchas are in [docs/simulator.md](docs/simulator.md). For phones to reach a server on your laptop, expose it over HTTPS with a tunnel such as `ngrok http 8788`.

## Configuration

Copy `server/.env.example` to `server/.env` and run `node --env-file=.env server.mjs`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HELCIM_API_TOKEN` | empty (mock mode) | A Helcim **developer test account** token. Never a live one. |
| `HELCIM_SIMULATE` | 0 | 1 runs the real Helcim client against an in-process fake with a simulated card window (only when no token is set). |
| `RELAY_KEY` | empty | Shared secret for goal setup, watch telemetry, nudges and settlement. Set it whenever the server is reachable from the internet. With a `HELCIM_API_TOKEN` the server refuses to start without it. |
| `TRUST_PROXY` | 0 | 1 believes `X-Forwarded-For` / `CF-Connecting-IP` for the cardholder IP sent to Helcim. Turn it on only behind a proxy or tunnel you run. |
| `DATA_FILE` | `server/data/state.json` | Where goals, pledges and card tokens are saved. |
| `DEFAULT_RUNNER` | the most recent open goal | Which goal a bare pledge link opens. |
| `NUDGE_EVERY_MIN` | 60 | Least time between "steps to go" reminders. |
| `AUTO_SETTLE` | 0 | 1 settles as soon as the watch finishes a run. |
| `PORT`, `HOST` | 8788, 127.0.0.1 | Where the server listens. |

The HTTP API is described in [docs/api.md](docs/api.md).

## Project layout

```
server/   server.mjs (HTTP API and settlement), helcim.mjs (Helcim client), helcim-sim.mjs (simulated Helcim),
          tour.mjs (self-checking guided tour), fake-runner.mjs, server.test.mjs
web/      index.html (pledge page), organizer.html (dashboard), manifest and icons
watch/    Monkey C source, resources and manifest
docs/     API, Helcim notes, simulator guide, screenshots
```

## What's verified

- **Server:** 38 tests. They run the real Helcim code path against a fake Helcim API and check URLs, headers and body fields. The money and safety rules were each broken on purpose to confirm a test fails: the per-km cap, the hash check, the no-double-charge guard, the commitment and charity stake shares, required consent, the goal lock, sensor counters, nudge de-duplication, the simulated window's test-card gate, and the security checks.
- **Browser:** pledging (including the simulated card window), consent, settlement and the phone layout, checked at 375px, partly through a public HTTPS tunnel.
- **Connect IQ simulator (SDK 9.1.0, fēnix 7 and 7 Pro):** steps and km goals through to GOAL MET and settlement, a charity goal showing RAISED, heart rate and zone time reaching the server, a background nudge shown as a notification, and recovery from a wrong key or a stopped server.
- **Not verified yet:** a physical watch; a real Helcim test account; nudges while the app is closed (the simulator only fires background events for the running app); a nonzero floors reading; Garmin Connect charting the custom FIT fields of a sideloaded app.

## Hackathon context

PledgePace started as a prep idea for the Tech Thursday x Garmin Hackathon in Calgary on November 14th, 2026, sponsored by Garmin Canada with partners including Helcim. The team built something else on the day, so this carried on as a personal side project.

PledgePace is not affiliated with or endorsed by Garmin or Helcim. Garmin, Connect IQ and fēnix are trademarks of Garmin Ltd. or its subsidiaries; Helcim is a trademark of Helcim Inc.

## License

[Apache License 2.0](LICENSE).
