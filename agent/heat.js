/* The local model's own computer runs its processor flat out while the model answers, and a small one can
   get hot enough to switch itself off mid-answer (it did, at about 96 °C). Before each call to the model
   (agent/local-lane.js ollamaChat) this reads the processor's temperature and, when it is too hot, waits
   for it to cool: a pause of a minute instead of a computer that goes dark.
   Linux only (/sys/class/thermal), processor sensors only, and it never blocks for long: anything it can't
   read, or a sensor that never comes down, lets the call go ahead. config localModel.heatGuard: false
   turns it off. No Electron here, so it can be tested on its own. */
const fs = require('fs');
const path = require('path');

const ZONES = '/sys/class/thermal';
const HOT_C = 92; // wait from here
const COOL_C = 82; // go again from here
const MAX_WAIT_MS = 3 * 60 * 1000;
const LOOK_MS = 5000;
// the processor's own sensors; a board or drive sensor (acpitz, nvme) says nothing about the load
const CPU_ZONE = /x86_pkg_temp|coretemp|k10temp|^tcpu|cpu[-_]?thermal/i;

// the hottest processor sensor in °C, or null when there is none to read (Windows, Mac, a sensor that lies)
function readTemp(dir = ZONES) {
  let names; try { names = fs.readdirSync(dir); } catch (e) { return null; }
  let max = null;
  for (const n of names) {
    if (!/^thermal_zone\d+$/.test(n)) continue;
    try {
      if (!CPU_ZONE.test(fs.readFileSync(path.join(dir, n, 'type'), 'utf8').trim())) continue;
      const c = Number(fs.readFileSync(path.join(dir, n, 'temp'), 'utf8').trim()) / 1000;
      if (!(c > 0 && c < 130)) continue; // not a real reading
      if (max == null || c > max) max = c;
    } catch (e) {}
  }
  return max;
}

/* Waits while the processor is at HOT_C or more, until it is back at COOL_C or MAX_WAIT_MS has gone.
   → { waited: ms, from: °C when it started waiting (null when it didn't), to: °C at the end } */
async function waitCool({ read = readTemp, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
  hot = HOT_C, cool = COOL_C, maxWait = MAX_WAIT_MS, lookMs = LOOK_MS } = {}) {
  let t = read();
  if (t == null || t < hot) return { waited: 0, from: null, to: t };
  const from = t;
  let waited = 0;
  while (t != null && t > cool && waited < maxWait) { await sleep(lookMs); waited += lookMs; t = read(); }
  log('heat: the processor was at ' + Math.round(from) + ' °C, waited ' + Math.round(waited / 1000) + ' s' +
    (t == null ? '' : ' (now ' + Math.round(t) + ' °C' + (t > cool ? ', going on anyway' : '') + ')'));
  return { waited, from, to: t };
}

module.exports = { readTemp, waitCool, HOT_C, COOL_C, MAX_WAIT_MS, CPU_ZONE };
