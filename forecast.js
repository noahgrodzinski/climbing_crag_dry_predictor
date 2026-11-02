// Fetch Open-Meteo data for one region and run the wetness model for each sector.
//
// Past rain:  hourly median of five models (Met Office, ECMWF, ICON, GFS, KNMI).
//             A single model's "analysis" rain invents showers; the median lines up
//             much better with radar (checked against Met Office radar totals).
// Weather:    Open-Meteo best_match (Met Office 2 km for the UK) for temperature,
//             humidity, wind, sun, weather symbols, sunrise/sunset.
// Future rain/sun/humidity: ensemble members (ECMWF 51, ICON 40, MOGREPS-G 18) branch
//             from the current rock state, giving P(dry) and rain chances.
// Tides/waves: Open-Meteo marine API, for tidal sea-cliff sectors only.

import { initState, step, faceIrradiance, friction, dewPoint, sunTimes, fogLevel, ROCK } from './model.js';

const DET_URL = 'https://api.open-meteo.com/v1/forecast';
const ENS_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const ENS_MODELS = 'ecmwf_ifs025,icon_seamless,ukmo_global_ensemble_20km';
const PAST_MODELS = 'ukmo_seamless,ecmwf_ifs025,icon_seamless,gfs_seamless,knmi_seamless';
export const FORECAST_DAYS = 8;
const PAST_DAYS = 14;

// Open-Meteo occasionally answers 503 "overloaded" / 429; retry briefly before giving up.
async function getJSON(url, params, tries = 3) {
  for (let k = 0; ; k++) {
    const r = await fetch(`${url}?${new URLSearchParams(params)}`).catch(e => ({ ok: false, status: 0, e }));
    if (r.ok) { const j = await r.json(); return Array.isArray(j) ? j : [j]; }
    const retryable = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!retryable || k >= tries - 1) throw new Error(`${new URL(url).host} ${r.status || 'offline'}`);
    await new Promise(res => setTimeout(res, 800 * 3 ** k));
  }
}

// Last good download per region, kept in the browser's Cache Storage (big enough for MBs).
const CACHE = 'isitdry-wx-v1';
async function saveCache(region, wx) {
  try { const c = await caches.open(CACHE); await c.put(`/wx/${region}`, new Response(JSON.stringify(wx))); } catch {}
}
async function loadCache(region) {
  try { const c = await caches.open(CACHE); const r = await c.match(`/wx/${region}`); return r ? await r.json() : null; } catch { return null; }
}

const near = (pts, c) => pts.reduce((b, k, i) =>
  (k.lat - c.lat) ** 2 + (k.lon - c.lon) ** 2 < (pts[b].lat - c.lat) ** 2 + (pts[b].lon - c.lon) ** 2 ? i : b, 0);

// Live data if possible; otherwise the last good download (if under 6 h old); otherwise a
// backup built only from the ensemble server, which has stayed up when the main one hasn't.
export async function fetchRegion(region, crags, key) {
  try {
    const wx = await fetchLive(region, crags);
    saveCache(key, wx);
    return { ...wx, mode: 'live' };
  } catch (err) {
    console.warn('live forecast failed', err);
    const cached = await loadCache(key);
    if (cached && Date.now() - cached.fetched < 6 * 3600e3) return { ...cached, mode: 'cached', error: err.message };
    try { return { ...(await fetchBackup(region, crags)), mode: 'backup', error: err.message }; }
    catch (e2) {
      if (cached) return { ...cached, mode: 'cached', error: err.message };
      throw err;
    }
  }
}

// Backup: per-cluster ensemble data (Met Office MOGREPS-G control run as the "main" forecast,
// its members for P(dry)), elevation-corrected to each crag; only 3 days of spin-up.
async function fetchBackup(region, crags) {
  const cl = region.clusters.map((k, j) => {
    const mine = crags.filter(c => near(region.clusters, c) === j);
    return { ...k, alt: mine.length ? Math.round(mine.reduce((a, c) => a + c.alt, 0) / mine.length) : 300 };
  });
  const vars = 'precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,' +
    'wind_direction_10m,shortwave_radiation,weather_code,visibility,cloud_cover_low';
  const ens = await getJSON(ENS_URL, {
    latitude: cl.map(c => c.lat).join(','), longitude: cl.map(c => c.lon).join(','), elevation: cl.map(c => c.alt).join(','),
    hourly: vars, models: 'ukmo_global_ensemble_20km', past_days: 3, forecast_days: FORECAST_DAYS,
    wind_speed_unit: 'ms', timeformat: 'unixtime', timezone: 'GMT',
  });
  const det = crags.map(c => {
    const j = near(region.clusters, c);
    const h = ens[j].hourly;
    const hourly = { time: h.time };
    for (const v of vars.split(',')) hourly[v] = h[v];
    const lapse = (c.alt - cl[j].alt) * 0.0065;   // °C per m
    hourly.temperature_2m = h.temperature_2m.map(T => T == null ? null : T - lapse);
    const dates = [...new Set(h.time.map(u => localParts(u).date))];
    const daily = { time: [], sunrise: [], sunset: [] };
    for (const d of dates) {
      const st = sunTimes(d, c.lat, c.lon);
      daily.time.push(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 1000 + 43200);
      daily.sunrise.push(st.rise); daily.sunset.push(st.set);
    }
    return { hourly, daily };
  });
  const marine = await fetchMarine(crags);
  return { det, past: null, ens, marine, fetched: Date.now() };
}

async function fetchMarine(crags) {
  const tidal = crags.filter(c => c.tidal);
  if (!tidal.length) return null;
  return getJSON(MARINE_URL, {
    latitude: tidal.map(c => c.lat).join(','), longitude: tidal.map(c => c.lon).join(','),
    hourly: 'sea_level_height_msl,wave_height', cell_selection: 'sea',
    forecast_days: FORECAST_DAYS, timeformat: 'unixtime', timezone: 'GMT',
  }).then(r => Object.fromEntries(tidal.map((c, i) => [c.id, r[i].hourly])))
    .catch(e => { console.warn('marine failed', e); return null; });
}

async function fetchLive(region, crags) {
  const lat = crags.map(c => c.lat).join(','), lon = crags.map(c => c.lon).join(',');
  const det = getJSON(DET_URL, {
    latitude: lat, longitude: lon, elevation: crags.map(c => c.alt).join(','),
    hourly: 'precipitation,temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,' +
      'wind_direction_10m,shortwave_radiation,weather_code,visibility,cloud_cover_low',
    daily: 'sunrise,sunset',
    past_days: PAST_DAYS, forecast_days: FORECAST_DAYS,
    wind_speed_unit: 'ms', timeformat: 'unixtime', timezone: 'Europe/London',
  });
  const past = getJSON(DET_URL, {
    latitude: lat, longitude: lon, hourly: 'precipitation', models: PAST_MODELS,
    past_days: PAST_DAYS, forecast_days: 1, timeformat: 'unixtime', timezone: 'GMT',
  }).catch(e => { console.warn('multi-model past rain failed', e); return null; });
  const ens = getJSON(ENS_URL, {
    latitude: region.clusters.map(c => c.lat).join(','),
    longitude: region.clusters.map(c => c.lon).join(','),
    hourly: 'precipitation,shortwave_radiation,relative_humidity_2m',
    models: ENS_MODELS, past_days: 1, forecast_days: FORECAST_DAYS,
    timeformat: 'unixtime', timezone: 'GMT',
  }).catch(e => { console.warn('ensemble failed, deterministic only', e); return null; });
  const marine = fetchMarine(crags);
  return { det: await det, past: await past, ens: await ens, marine: await marine, fetched: Date.now() };
}

function members(hourly) {
  const out = [];
  for (const k of Object.keys(hourly)) {
    if (!k.startsWith('precipitation')) continue;
    const sfx = k.slice('precipitation'.length);
    out.push({ P: hourly[k], G: hourly['shortwave_radiation' + sfx], RH: hourly['relative_humidity_2m' + sfx] });
  }
  return out;
}

const fill = (a, i) => { for (let j = i; j >= 0; j--) if (a[j] != null) return a[j]; return 0; };
const median = v => { v = v.filter(x => x != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
const cragParams = c => ({ shelter: c.shelter_wind, green: c.green, rock: c.rock_model, seepage: c.seepage });

export function runRegion(region, crags, wx) {
  const now = Date.now() / 1000;
  const ensBy = wx.ens ? wx.ens.map(loc => ({
    idx: Object.fromEntries(loc.hourly.time.map((t, i) => [t, i])),
    members: members(loc.hourly),
  })) : null;

  return crags.map((c, ci) => {
    const h = wx.det[ci].hourly;
    const t = h.time, n = t.length;
    let nowIdx = t.findIndex(x => x > now) - 1;
    if (nowIdx < 0) nowIdx = n - 1;

    // Past rain = median across models where available.
    let pastP = null;
    if (wx.past) {
      const ph = wx.past[ci].hourly;
      const keys = Object.keys(ph).filter(k => k.startsWith('precipitation'));
      const pidx = Object.fromEntries(ph.time.map((u, i) => [u, i]));
      pastP = t.map(u => pidx[u] == null ? null : median(keys.map(k => ph[k][pidx[u]])));
    }

    const det = [];
    const s = initState();
    let snap = null;
    for (let i = 0; i < n; i++) {
      const x = {
        P: i <= nowIdx && pastP?.[i] != null ? pastP[i] : fill(h.precipitation, i),
        T: fill(h.temperature_2m, i), RH: fill(h.relative_humidity_2m, i),
        U: fill(h.wind_speed_10m, i), gust: fill(h.wind_gusts_10m, i),
        dir: fill(h.wind_direction_10m, i), G: fill(h.shortwave_radiation, i),
        code: fill(h.weather_code, i), vis: fill(h.visibility, i), low: fill(h.cloud_cover_low, i),
      };
      // The multi-model median drops drizzle; keep the main model's drizzle when it's murky.
      const drizzle = x.code >= 51 && x.code <= 57 && x.RH >= 95;
      if (i <= nowIdx && drizzle) x.P = Math.max(x.P, fill(h.precipitation, i));
      x.fog = fogLevel(x);
      const fi = faceIrradiance(x.G, t[i], c.lat, c.lon, c.aspect_deg, c.shade_trees);
      x.gt = fi.gt; x.beam = fi.beam;
      const d = step(s, x, cragParams(c));
      d.fric = friction(d, x);
      d.Td = dewPoint(x.T, x.RH);
      det.push({ x, d });
      if (i === nowIdx) snap = { ...s };
    }

    const E = ensBy && ensBy[near(region.clusters, c)];
    let mem = [];
    if (E) {
      for (const m of E.members) {
        const st = new Uint8Array(n);
        const cst = new Uint8Array(n);
        const rain = new Float32Array(n);
        let valid = n;
        const ms = { ...snap };
        for (let i = 0; i < n; i++) {
          if (i <= nowIdx) { st[i] = det[i].d.state; cst[i] = det[i].d.cstate; rain[i] = det[i].x.P; continue; }
          const j = E.idx[t[i]];
          if (j == null || m.P[j] == null || m.G?.[j] == null) { valid = i; break; }
          const base = det[i].x;
          const fi = faceIrradiance(m.G[j], t[i], c.lat, c.lon, c.aspect_deg, c.shade_trees);
          rain[i] = m.P[j];
          const RH = m.RH?.[j] ?? base.RH;
          // Mist only where this member is also near-saturated.
          const fog = RH >= 96 ? base.fog : 0;
          const o = step(ms, { P: m.P[j], T: base.T, RH, U: base.U, gt: fi.gt, fog }, cragParams(c));
          st[i] = o.state; cst[i] = o.cstate;
        }
        mem.push({ st, cst, rain, valid });
      }
    }
    if (!mem.length) mem = [{ st: Uint8Array.from(det.map(e => e.d.state)), cst: Uint8Array.from(det.map(e => e.d.cstate)), rain: Float32Array.from(det.map(e => e.x.P)), valid: n }];

    const pDry = t.map((_, i) => {
      const ok = mem.filter(m => i < m.valid);
      return ok.length ? ok.filter(m => m.st[i] === 0).length / ok.length : null;
    });

    const pRain = t.map((_, i) => {
      const ok = mem.filter(m => i < m.valid);
      return ok.length ? ok.filter(m => m.rain[i] >= 0.1).length / ok.length : null;
    });

    const daily = wx.det[ci].daily;
    const sun = Object.fromEntries(daily.time.map((u, k) => [localParts(u).date, { rise: daily.sunrise[k], set: daily.sunset[k] }]));
    return { crag: c, t, det, mem, pDry, pRain, nowIdx, sun, marine: wx.marine?.[c.id] ?? null };
  });
}

// ---------- local time helpers ----------

const TZ = 'Europe/London';
const fmtParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
export function localParts(unix) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(unix * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, min: +p.minute };
}

export function dayList(run) {
  const today = localParts(Date.now() / 1000).date;
  const seen = [];
  for (const u of run.t) { const { date } = localParts(u); if (date >= today && !seen.includes(date)) seen.push(date); }
  return seen.slice(0, FORECAST_DAYS);
}

// Light: Open-Meteo sunrise/sunset, plus civil twilight offsets from our own sun model.
export function lightTimes(run, date) {
  const s = run.sun[date];
  if (!s) return null;
  const own = sunTimes(date, run.crag.lat, run.crag.lon);
  const dawnGap = own.rise && own.dawn ? own.rise - own.dawn : 2400;
  const duskGap = own.set && own.dusk ? own.dusk - own.set : 2400;
  return { dawn: s.rise - dawnGap, rise: s.rise, set: s.set, dusk: s.set + duskGap };
}

// ---------- day summaries ----------

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Wind actually felt on the face: strongest when blowing straight onto it.
export function faceWindFactor(c, dir) {
  const d = angDiff(dir, c.aspect_deg);   // dir = where wind comes FROM; 0 = straight onto the face
  return c.shelter_wind * (d < 60 ? 1 : d < 120 ? 0.7 : 0.45);
}

export function summarise(run, date, [h0, h1]) {
  const idx = [];
  const hours = [];
  run.t.forEach((u, i) => {
    const p = localParts(u);
    if (p.date !== date) return;
    hours.push({ i, hour: p.hour });
    if (p.hour >= h0 && p.hour < h1) idx.push(i);
  });
  if (!idx.length) return null;
  const c = run.crag;
  const rock = ROCK[c.rock_model];

  const last = idx[idx.length - 1];
  const live = run.mem.filter(m => last < m.valid);
  const good = live.filter(m => idx.filter(i => m.st[i] === 0).length >= 0.75 * idx.length);
  const p = live.length ? good.length / live.length : null;
  // Same test for the cracks (slower drying, fed by seepage).
  const pCrack = live.length ? live.filter(m => idx.filter(i => m.cst[i] === 0).length >= 0.75 * idx.length).length / live.length : null;
  const seepH = idx.filter(i => run.det[i].d.seeping).length;
  const rainChance = live.length ? live.filter(m => idx.reduce((a, i) => a + m.rain[i], 0) >= 0.5).length / live.length : null;
  const rainAmt = live.length ? live.reduce((a, m) => a + idx.reduce((b, i) => b + m.rain[i], 0), 0) / live.length : 0;

  const det = idx.map(i => run.det[i]);
  const dryHrs = idx.filter(i => run.pDry[i] >= 0.5);
  const grip = dryHrs.length ? dryHrs.reduce((a, i) => a + run.det[i].d.fric, 0) / dryHrs.length : null;

  // When is it dry? (pDry >= 0.5 = more forecasts dry than wet)
  let from = null;
  for (let k = idx.length - 1; k >= 0 && run.pDry[idx[k]] >= 0.5; k--) from = k;
  const firstWet = idx.findIndex(i => run.pDry[i] < 0.5);
  const hr = k => localParts(run.t[idx[k]]).hour;
  let when;
  if (from === 0) when = { kind: 'all' };
  else if (from != null) when = { kind: 'from', hour: hr(from) };
  else if (firstWet > 0) when = { kind: 'until', hour: hr(firstWet) };
  else if (dryHrs.length) when = { kind: 'patchy', n: dryHrs.length };
  else when = { kind: 'none' };

  // Rock condition during the hours you'd climb.
  const satHrs = dryHrs.filter(i => run.det[i].d.fill > 0.6);
  const freezing = dryHrs.some(i => run.det[i].x.T < 0.5 && run.det[i].d.fill > 0.3);
  const rockState = !dryHrs.length || p < 0.35 ? 'wet' : satHrs.length || freezing ? 'soaked' : 'ok';

  const start = idx[0];
  let rain48 = 0, lastRain = null;
  for (let i = Math.max(0, start - 48); i < start; i++) {
    rain48 += run.det[i].x.P;
    if (run.det[i].x.P >= 0.2) lastRain = run.t[i];
  }
  const mean = f => det.reduce((a, e) => a + f(e), 0) / det.length;
  const wind = mean(e => e.x.U) * 3.6;
  const gust = Math.max(...det.map(e => e.x.gust)) * 3.6;
  // circular mean of wind direction
  const sx = mean(e => Math.sin(e.x.dir * Math.PI / 180) * e.x.U), sy = mean(e => Math.cos(e.x.dir * Math.PI / 180) * e.x.U);
  const dir = (Math.atan2(sx, sy) * 180 / Math.PI + 360) % 360;
  const faceWind = wind * faceWindFactor(c, dir);
  const sunHrs = det.filter(e => e.x.beam > 120).map(e => run.t[run.det.indexOf(e)]);

  // Most "severe" weather symbol in the session, for the day icon.
  const codes = det.map(e => e.x.code);
  const sunny = det.filter(e => e.x.G > 0).length ? mean(e => e.x.code <= 1 ? 1 : 0) : 0;

  return {
    p, pCrack, seepH, rainChance, rainAmt, when, grip, rockState, fragile: rock.fragile,
    rain48, lastRain, sunH: sunHrs.length, sunFirst: sunHrs[0] ?? null,
    wind, gust, dir, faceWind, rh: mean(e => e.x.RH),
    tmin: Math.min(...det.map(e => e.x.T)), tmax: Math.max(...det.map(e => e.x.T)),
    codes, sunny, sweat: det.some(e => e.d.sweat), seeping: satHrs.length > 0,
    fogH: det.filter(e => e.x.fog >= 0.5).length,
    hours, tide: run.marine ? tides(run, date) : null,
  };
}

// High/low tide times and max wave height on a local date.
function tides(run, date) {
  const m = run.marine;
  const ext = [];
  let wave = 0;
  for (let i = 1; i < m.time.length - 1; i++) {
    const lp = localParts(m.time[i]);
    if (lp.date !== date) continue;
    const [a, b, c] = [m.sea_level_height_msl[i - 1], m.sea_level_height_msl[i], m.sea_level_height_msl[i + 1]];
    if (a == null || b == null || c == null) continue;
    if (lp.hour >= 6 && lp.hour <= 20) wave = Math.max(wave, m.wave_height[i] ?? 0);
    if (b < a && b <= c) ext.push({ type: 'low', t: m.time[i] });
    if (b > a && b >= c) ext.push({ type: 'high', t: m.time[i] });
  }
  return { ext, wave };
}

// Score for "best crag": dry, good grip, not battered by wind, not freezing.
export function pickScore(s) {
  if (!s || s.p == null) return -1;
  let f = s.p * (0.75 + 0.25 * (s.grip ?? 0));
  if (s.faceWind > 35 || s.gust > 70) f *= 0.6;
  else if (s.faceWind > 25 || s.gust > 55) f *= 0.85;
  if (s.tmax < 3) f *= 0.85;
  return f;
}
