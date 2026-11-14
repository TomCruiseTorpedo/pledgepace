# Try PledgePace

Four ways in, from two minutes in a terminal to the full watch experience. Nothing here charges real money: payments run in simulated mode, which accepts only Helcim's published test card.

You need **Node 20 or newer** and **git**. There is nothing to install: the server has no dependencies.

```bash
git clone https://github.com/TomCruiseTorpedo/pledgepace
cd pledgepace/server
```

## 1. Watch the whole story (about 2 minutes)

```bash
node tour.mjs
```

The tour starts its own server, plays the part of the watch and the backers, and checks every step:

1. **A commitment goal.** Two friends back 1,000 steps through the simulated card window. As steps come in, the money at stake shrinks; the watch gets a "2 new backers" nudge, then "Goal met!", and settling charges nobody.
2. **A charity goal.** The same backers sponsor 1,000 steps for a food bank. At 700 steps, 70% of their stakes ($21 of $30) is raised and charged; settling again charges nobody twice.
3. **Safety checks.** A pledge without consent, a goal set without the key, a non-test card number and a cross-site style form post are all refused.

Every line is marked ✓ or ✗, and it ends with "All checks passed." The full test suite is `npm test`.

## 2. Click around (about 5 minutes)

```bash
node tour.mjs --serve
```

It runs the same story, then leaves a server running with an open charity goal and prints three things:

- **The pledge page.** Back the goal: pick a stake, tick the consent box, press **Back with card**, then **Fill in the test card** and **Verify card** in the simulated card window.
- **The dashboard**, with its relay key. Watch progress, settle, or set a new goal on a new runner id; the toggle there switches between commitment and charity.
- **A command that walks the steps** for you from a second terminal. Watch "raised" climb on the pledge page as it goes.

Worth trying on the pledge page:

- Typing a different card number. The window refuses it and never sends it.
- **Simulate a declined card**.
- Changing your stake after ticking consent. The tick clears, so consent always matches the amount shown.
- A phone-sized window. The main button stays pinned to the bottom.

## 3. On your phone

Expose the server with a tunnel (for example `ngrok http 8790`) and open the HTTPS address it prints on your phone, adding `/?runner=play`. A bare link opens the most recent open goal. ngrok's free tier shows a one-time warning page first; tap **Visit Site**. From your browser's menu you can **Add to Home Screen**, and PledgePace then opens full-screen with its own icon.

## 4. The watch

The watch app needs Garmin's free [Connect IQ SDK](https://developer.garmin.com/connect-iq/sdk/) (SDK Manager, SDK 9.1.0 or later, a device profile such as fēnix 7) and its simulator. [docs/simulator.md](docs/simulator.md) walks through building it, pointing it at your server, feeding it steps, floors and heart rate, and firing a background nudge on cue.

## Ask your AI assistant to try it

If your assistant can run commands, paste this:

> Read https://raw.githubusercontent.com/TomCruiseTorpedo/pledgepace/main/AGENTS.md and follow the section "If your person asked you to try or evaluate PledgePace". Tell me what passed, what failed, and anything that doesn't match the README.

## Things to try to break

- Back a goal, then try to change it from the dashboard (it's locked once anyone commits).
- Settle twice (nobody is charged twice).
- Stop the server while the watch simulator is running, then start it again (the watch shows "Server not found", then reconnects with everything intact).
- Send the server a POST that isn't JSON (refused with 415).
- Start it with a real-looking `HELCIM_API_TOKEN` and no `RELAY_KEY` (it refuses to start).

**Never type a real card number into anything here.** Simulated and mock modes move no money, and the simulated card window only accepts `4124 9399 9999 9990`.
