# Running PledgePace in the Connect IQ simulator

Tested with SDK 9.1.0 on fēnix 7 and fēnix 7 Pro.

## Setup

1. Run the server with a relay key: put `RELAY_KEY` (any random string) in `server/.env` and start it with `node --env-file=.env server.mjs`. Paste the key into the dashboard when it asks.
2. Set a goal at `/organizer` and back it on the pledge page. Use a fresh runner id for each demo: a goal locks once anyone backs it.
3. In `watch/resources/settings/properties.xml` set `serverUrl` to `http://127.0.0.1:8788`, `runnerId` to the runner and `relayKey` to the key. Build for `fenix7` and run it in the simulator. The watch talks to localhost directly; only phones need a public HTTPS address.
4. In the simulator, turn **Settings > Use Device HTTPS Requirements** off. With it on, the request still reaches the server, but the app is told -1001 and never sees the reply, so the server looks healthy while the watch says "Needs HTTPS".

## Driving the sensors

- **Steps and floors:** Simulation > Activity Monitoring > Set Activity Monitor Info. Edit Today's Steps or Floors Climbed and press Apply; the watch picks it up on its next poll, within 5 seconds. Fast Forward adds nothing unless Steps Per Minute is set.
- **Heart rate** (active-minute goals and the BPM readout): Simulation > Activity Data, then press play.
- **A nudge on cue:** with the app running, Simulation > Background Events > Temporal Event > OK runs the background task immediately. Back the goal from a phone first and the watch shows "<name> backed you".

## Gotchas

- **Old settings survive a rebuild.** The simulator keeps an app's saved properties, so a changed `properties.xml` is ignored. Load the new build first, then File > Reset All App Data, then run it again. A reset done while the old build is on screen keeps the old settings, and the watch reports "Wrong relay key".
- **Background events need the app loaded.** After File > Kill App, or after leaving the app with BACK, the Background Events dialog has no target, so nudges with the app closed can't be shown in the simulator.
- **Launcher icon warnings** (70x70 scaled to 40x40 or 60x60) are harmless.
- **`makeWebRequest` body type:** it takes `Dictionary<Object, Object>`; a `Dictionary<String, Object>` fails the type check.

## Checked behaviour

- A wrong relay key shows "Wrong relay key" and keeps the last numbers on screen.
- With the server stopped the watch shows "Server not found", and it reconnects on the next poll after a restart with the goal and backers intact.
- Cancel on "Finish run?" keeps the run, paused; START resumes it.
- A finished run keeps its distance and time on screen, and the finishing report can't zero the distance.
