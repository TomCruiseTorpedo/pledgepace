// Pretends to be the watch: runs at about 5:00/km, posts distance every 2 s and
// prints the live total. Pass --finish-at=KM to end the run at that distance.
// Usage: node fake-runner.mjs [serverUrl] [runnerId] [--finish-at=5]
const args = process.argv.slice(2);
const finishAt = Number((args.find((a) => a.startsWith('--finish-at=')) ?? '').split('=')[1]) || Infinity;
const [base = 'http://127.0.0.1:8788', runner = 'runner-1'] = args.filter((a) => !a.startsWith('--'));
const key = process.env.RELAY_KEY ?? '';
const speedUp = Number(process.env.SPEED_UP ?? 30); // 30x real time so a demo 5 km takes ~50 s

let dist = 0;
let timer = 0;
let steps = 4000 + Math.floor(Math.random() * 2000); // the watch's step count so far today
let zoneSec = 0;
let lastMilestone = 0;
let goalMet = false;

const id = setInterval(async () => {
  dist += 3.33 * 2 * speedUp;
  timer += 2000 * speedUp;
  steps += Math.round(3.33 * 2 * speedUp * 1.4); // about 1.4 steps per metre running
  zoneSec += 2 * speedUp; // running keeps heart rate above zone 2
  const hr = 138 + Math.round(Math.random() * 12);
  const finished = dist / 1000 >= finishAt;
  try {
    const res = await fetch(`${base}/api/runs/${runner}/telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key && { 'x-relay-key': key }) },
      body: JSON.stringify({ dist, timer, steps, zoneSec, hr, recording: !finished, finished }),
    });
    const t = await res.json();
    if (!res.ok) return console.log(`server answered ${res.status}: ${t.error}`);
    if (t.mode === 'goal') {
      const buzz = t.goalMet && !goalMet ? '  \x07[buzz] goal met!' : '';
      goalMet = t.goalMet;
      const what = t.payOn === 'progress' ? 'raised' : 'still at stake';
      console.log(`${t.progress}/${t.target} ${t.unit}  $${t.raised.toFixed(2)} ${what} of $${t.stakeTotal.toFixed(2)} (${t.pledgers} backers, HR ${hr})${buzz}`);
    } else {
      const m = Math.floor(t.raised / t.milestone);
      const buzz = m > lastMilestone ? '  \x07[buzz] milestone!' : '';
      lastMilestone = Math.max(lastMilestone, m);
      console.log(`${(dist / 1000).toFixed(2)} km  $${t.raised.toFixed(2)} raised  ($${t.ratePerKm}/km, ${t.pledgers} sponsors)${buzz}`);
    }
    if (finished) {
      console.log(t.settled ? 'finished and settled' : 'finished; settle from /organizer');
      clearInterval(id);
    }
  } catch (err) {
    console.log(`server unreachable: ${err.message}`);
  }
}, 2000);
