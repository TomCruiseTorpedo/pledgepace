# AGENTS.md

Instructions for AI agents working in or reading this repository.

## If your person asked you to try or evaluate PledgePace

You need a shell with **Node 20+** and **git**. No accounts, API keys or installs: the server has no dependencies, and every step below starts and stops its own server on a free port.

1. Get the code: `git clone https://github.com/TomCruiseTorpedo/pledgepace && cd pledgepace/server`
2. Run the tests: `npm test`. Expect the summary lines `ℹ pass 38` and `ℹ fail 0`.
3. Run the guided tour: `node tour.mjs`. Expect 19 lines marked ✓, the last line `All checks passed.`, and exit code 0. Show your person the ✓/✗ lines; they tell the whole story (a commitment goal, a charity goal, settlement through simulated Helcim, safety refusals).
4. Let your person click around: `node tour.mjs --serve` (port from `PORT`, default 8790). Give them the printed pledge page and dashboard addresses, and stop the process when they're done.
5. Check claims against the code. Where things live:
   - Money rules: `stakeAmount` and `pledgeAmount` in `server/server.mjs`. Amounts are computed only on the server.
   - Helcim client: `server/helcim.mjs` (HelcimPay.js initialize, response-signature check, purchase with idempotency key).
   - Simulated Helcim and the card window: `server/helcim-sim.mjs`.
   - HTTP API: [docs/api.md](docs/api.md); Helcim notes: [docs/helcim.md](docs/helcim.md).
   - Watch app (Monkey C): `watch/source/`. Sensors in `PledgeSession.mc`, screen in `PledgePaceView.mc`, background nudges in `NudgeServiceDelegate.mc`.
6. **The watch app needs a person.** It is built with Garmin's Connect IQ SDK and run in Garmin's simulator, a desktop app that needs a Garmin sign-in. If your person has it, [docs/simulator.md](docs/simulator.md) has the steps; otherwise read the Monkey C source and say plainly that it wasn't run.

### Rules while testing

- **Never enter a real card number** anywhere. Simulated mode accepts only Helcim's test card, `4124 9399 9999 9990`.
- **Never set `HELCIM_API_TOKEN`** unless your person gives you a Helcim **developer test account** token for this purpose. Mock and simulated modes move no money.
- Don't stop servers or processes you didn't start.
- Report what you ran and what you only read. "The tour passed" and "I read the watch code" are different claims.

### Claims worth checking

| README claim | How to check |
| --- | --- |
| Commitment backers pay stake × share missed; charity backers pay stake × share completed | Tour sections 1 and 2; tests named "a stake owes its share…" and "a charity stake owes…" |
| Nobody is charged twice | Tour "settling again charges nobody twice"; the test "settling charges each pledge once…" |
| Pledges need explicit consent, and a goal locks once backed | Tour section 3; the tests for consent and for the goal lock |
| Card numbers never reach the server's storage | `helcim-sim.mjs` masks the number in its signed response; no pledge record has a card-number field; the test "the simulated card window runs the real Helcim path…" |
| The server fails closed with real payments | Tour section 3 and the test "the server refuses to start with real Helcim and no relay key" |

## If you're changing the repository

- **Layout:**
  - `server/` holds the Node server, Helcim client, simulator, fake runner, tour and tests.
  - `web/` holds the pledge page and dashboard (plain HTML, no build step).
  - `watch/` holds the Connect IQ app.
  - `docs/` holds the API, Helcim and simulator guides.
- **Before committing:** `cd server && npm test && node tour.mjs`. For watch changes, build with the Connect IQ SDK for at least `fenix7pro` (`monkeyc -d fenix7pro -f monkey.jungle -o bin/app.prg -y <developer key>`).
- **No dependencies.** Plain Node and plain HTML. Don't add packages.
- **Money is computed on the server only.** The watch reports measurements; it never decides what anyone pays.
- **Every money or safety rule has a test that fails when the rule is reverted.** Keep it that way: when you add a rule, break it on purpose once to prove the test catches it.
- **Monkey C** follows Garmin's conventions: one class per file, `_private` members, the superclass initializer first, and a `has` check before any optional API. Each permission in `manifest.xml` must map to a feature.
- **Writing:** Canadian English in prose (colour, behaviour), US spelling in code identifiers.
- **Never commit** `.env`, `*.der` or `*.pem` files, state files, personal paths or real card data.
