// Fetch Open-Meteo data and run the wetness model for every crag.
//
// Deterministic run (Open-Meteo best_match, per crag, 14 days of history) spins the
// model up to "now" and supplies temperature/wind plus the reason lines.
// Ensemble members (ECMWF IFS 51, ICON-EPS 40, MOGREPS-G 18) then branch from the
// current state with their own rain, sun and humidity to give P(dry).

import { initState, step, faceIrradiance, friction, damage, dewPoint } from './model.js';

const DET_URL = 'https://api.open-meteo.com/v1/forecast';
const ENS_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const ENS_MODELS = 'ecmwf_ifs025,icon_seamless,ukmo_global_ensemble_20km';
export const FORECAST_DAYS = 8;
const PAST_DAYS = 14;

// Ensemble is coarse (~25 km), so crags share one of a few grid points.
const CLUSTERS = [
  { id: 'hope', lat: 53.345, lon: -1.635 },
  { id: 'eastern', lat: 53.275, lon: -1.612 },
  { id: 'chatsworth', lat: 53.245, lon: -1.592 },
  { id: 'staffs', lat: 53.163, lon: -1.995 },
];

const nearest = c => CLUSTERS.reduce((best, k, i) =>
  (k.lat - c.lat) ** 2 + (k.lon - c.lon) ** 2 <
  (CLUSTERS[best].lat - c.lat) ** 2 + (CLUSTERS[best].lon - c.lon) ** 2 ? i : best, 0);

async function getJSON(url, params) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${url}?${q}`);
  if (!r.ok) throw new Error(`${url} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [j];
}

export async function fetchWeather(crags) {
  const det = getJSON(DET_URL, {
    latitude: crags.map(c => c.lat).join(','),
    longitude: crags.map(c => c.lon).join(','),
    elevation: crags.map(c => c.alt).join(','),
    hourly: 'precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation',
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS,
    wind_speed_unit: 'ms', timeformat: 'unixtime', timezone: 'GMT',
  });
  const ens = getJSON(ENS_URL, {
    latitude: CLUSTERS.map(c => c.lat).join(','),
    longitude: CLUSTERS.map(c => c.lon).join(','),
    hourly: 'precipitation,shortwave_radiation,relative_humidity_2m',
    models: ENS_MODELS, past_days: 1, forecast_days: FORECAST_DAYS,
    timeformat: 'unixtime', timezone: 'GMT',
  }).catch(e => { console.warn('ensemble failed, deterministic only', e); return null; });
  return { det: await det, ens: await ens, fetched: Date.now() };
}

// Split an ensemble location's hourly block into members: [{name, P[], G[], RH[]}].
function members(hourly) {
  const out = [];
  for (const k of Object.keys(hourly)) {
    if (!k.startsWith('precipitation')) continue;
    const sfx = k.slice('precipitation'.length);
    out.push({
      name: sfx.slice(1),
      P: hourly[k], G: hourly['shortwave_radiation' + sfx], RH: hourly['relative_humidity_2m' + sfx],
    });
  }
  return out;
}

const fill = (a, i) => { // carry the last good value over gaps (end of short models)
  for (let j = i; j >= 0; j--) if (a[j] != null) return a[j];
  return 0;
};

// Returns per crag: { crag, t[], det[] (inputs + diagnostics per hour), mem: Uint8Array[] states, nowIdx }
export function runAll(crags, wx) {
  const now = Date.now() / 1000;
  const ensByCluster = wx.ens ? wx.ens.map(loc => ({
    idx: Object.fromEntries(loc.hourly.time.map((t, i) => [t, i])),
    members: members(loc.hourly),
  })) : null;

  return crags.map((c, ci) => {
    const h = wx.det[ci].hourly;
    const t = h.time;
    const n = t.length;
    let nowIdx = t.findIndex(x => x > now) - 1;
    if (nowIdx < 0) nowIdx = n - 1;

    const det = [];
    const s = initState();
    let snap = null;
    for (let i = 0; i < n; i++) {
      const x = {
        P: fill(h.precipitation, i), T: fill(h.temperature_2m, i),
        RH: fill(h.relative_humidity_2m, i), U: fill(h.wind_speed_10m, i),
        G: fill(h.shortwave_radiation, i),
      };
      const fi = faceIrradiance(x.G, t[i], c.lat, c.lon, c.aspect_deg, c.shade_trees);
      x.gt = fi.gt; x.beam = fi.beam;
      const d = step(s, x, cragParams(c));
      d.fric = friction(d, x);
      d.dmg = damage(d, x);
      d.Td = dewPoint(x.T, x.RH);
      det.push({ x, d });
      if (i === nowIdx) snap = { ...s };
    }

    // Ensemble branches from the current state; before now every member = deterministic.
    let mem = [];
    const E = ensByCluster && ensByCluster[nearest(c)];
    if (E) {
      for (const m of E.members) {
        const st = new Uint8Array(n);
        let valid = n;            // first hour with no data for this member
        const ms = { ...snap };
        for (let i = 0; i < n; i++) {
          if (i <= nowIdx) { st[i] = det[i].d.state; continue; }
          const j = E.idx[t[i]];
          if (j == null || m.P[j] == null || m.G?.[j] == null) { valid = i; break; }
          const base = det[i].x;
          const RH = m.RH?.[j] ?? base.RH;
          const fi = faceIrradiance(m.G[j], t[i], c.lat, c.lon, c.aspect_deg, c.shade_trees);
          st[i] = step(ms, { P: m.P[j], T: base.T, RH, U: base.U, gt: fi.gt }, cragParams(c)).state;
        }
        mem.push({ st, valid });
      }
    }
    if (!mem.length) mem = [{ st: Uint8Array.from(det.map(e => e.d.state)), valid: n }];

    const pDry = t.map((_, i) => {
      const ok = mem.filter(m => i < m.valid);
      return ok.length ? ok.filter(m => m.st[i] === 0).length / ok.length : null;
    });
    return { crag: c, t, det, mem, pDry, nowIdx };
  });
}

const cragParams = c => ({ shelter: c.shelter_wind, green: c.green, rock: c.rock_model || 'grit' });

// ---------- day summaries ----------

const TZ = 'Europe/London';
const fmtParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
export function localParts(unix) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(unix * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

export function dayList(run) {
  const seen = [];
  const today = localParts(Date.now() / 1000).date;
  for (const u of run.t) {
    const { date } = localParts(u);
    if (date >= today && !seen.includes(date)) seen.push(date);
  }
  return seen.slice(0, FORECAST_DAYS);
}

// Summarise one crag on one local date for session hours [h0, h1).
export function summarise(run, date, [h0, h1]) {
  const idx = [], all = [];
  run.t.forEach((u, i) => {
    const p = localParts(u);
    if (p.date !== date) return;
    all.push({ i, hour: p.hour });
    if (p.hour >= h0 && p.hour < h1) idx.push(i);
  });
  if (!idx.length) return null;

  // P(session is dry): fraction of members dry for >= 75% of session hours.
  const live = run.mem.filter(m => idx[idx.length - 1] < m.valid);
  const good = live.filter(m => idx.filter(i => m.st[i] === 0).length >= 0.75 * idx.length);
  const p = live.length ? good.length / live.length : null;

  const det = idx.map(i => run.det[i]);
  const dryHrs = idx.filter(i => run.pDry[i] >= 0.5);
  const fr = dryHrs.length ? dryHrs.reduce((a, i) => a + run.det[i].d.fric, 0) / dryHrs.length : null;
  // Damage risk for the hours you'd actually climb: wet if there are none,
  // otherwise only the saturated/freezing flag (the ensemble says the surface is dry).
  const dmg = !dryHrs.length || p < 0.35 ? 2
    : dryHrs.some(i => run.det[i].d.fill > 0.6 || (run.det[i].x.T < 0.5 && run.det[i].d.fill > 0.3)) ? 1 : 0;

  // When does it go dry (pDry >= 0.5 for the rest of the session)?
  let from = null;
  for (let k = idx.length - 1; k >= 0 && run.pDry[idx[k]] >= 0.5; k--) from = k;
  const firstWet = idx.findIndex(i => run.pDry[i] < 0.5);
  let window;
  if (from === 0) window = 'dry all session';
  else if (from != null) window = `dry from ${pad(localParts(run.t[idx[from]]).hour)}:00`;
  else if (firstWet > 0) window = `dry until ${pad(localParts(run.t[idx[firstWet]]).hour)}:00`;
  else if (dryHrs.length) window = `patchy, ${dryHrs.length}h dry`;
  else window = 'wet all session';
  const meanP = idx.reduce((a, i) => a + (run.pDry[i] ?? 0), 0) / idx.length;
  if (dryHrs.length && meanP < 0.65) window += ' (uncertain)';

  // Reason inputs from the deterministic run.
  const start = idx[0];
  let rain48 = 0, lastRain = null;
  for (let i = Math.max(0, start - 48); i < start; i++) {
    rain48 += run.det[i].x.P;
    if (run.det[i].x.P >= 0.2) lastRain = i;
  }
  const rainIn = det.reduce((a, e) => a + e.x.P, 0);
  const sunH = det.filter(e => e.x.beam > 120).length;
  const mean = f => det.reduce((a, e) => a + f(e), 0) / det.length;

  return {
    p, window, fric: fr, dmg,
    rain48, lastRain: lastRain != null ? run.t[lastRain] : null, rainIn, sunH,
    wind: mean(e => e.x.U) * 3.6, rh: mean(e => e.x.RH),
    tmin: Math.min(...det.map(e => e.x.T)), tmax: Math.max(...det.map(e => e.x.T)),
    td: mean(e => e.d.Td), fill: Math.max(...det.map(e => e.d.fill)),
    sweat: det.some(e => e.d.sweat), hours: all,
  };
}

export const pad = n => String(n).padStart(2, '0');
