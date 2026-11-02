// Rock-wetness model: two moisture stores per crag face, stepped hourly.
//
//   W  surface film (mm)   filled by rain + condensation, emptied by evaporation
//   D  deep/pore store (mm) filled slowly by rain, drains over days and wicks
//                           back to the surface (green streaks, seepage, "saturated")
//   C  crack film (mm)     like W but fed by run-off from the face above and by seepage
//                           from D, and shaded/sheltered so it evaporates ~2x slower
//
// Evaporation is Penman for a wet surface, driven by sunlight on the actual
// face (vertical plane at the crag's aspect), local wind and vapour-pressure deficit.

const LAMBDA = 2.45e6;   // J/kg latent heat
const GAMMA = 0.064;     // kPa/K psychrometric const at ~400 m
const DEG = Math.PI / 180;

export const ROCK = {
  // Wmax: surface film that counts as fully wet. Dmax: deep store capacity.
  // kin: fraction of rain soaking into deep store. tauD: drain time (h).
  // kw: wick rate back to surface when deep store is over half full (mm/h).
  // fragile: wet rock is weaker (grit/sandstone) rather than just slippery.
  grit:      { Wmax: 0.5, Dmax: 5,  kin: 0.25, tauD: 72,  kw: 0.05, fragile: true },
  quarried:  { Wmax: 0.5, Dmax: 6,  kin: 0.30, tauD: 96,  kw: 0.06, fragile: true },
  // Mountain volcanic rock: sheds water fast but drainage lines seep for days.
  rhyolite:  { Wmax: 0.5, Dmax: 12, kin: 0.35, tauD: 200, kw: 0.08, fragile: false },
  // Tremadog: famously quick drying.
  dolerite:  { Wmax: 0.4, Dmax: 4,  kin: 0.20, tauD: 48,  kw: 0.04, fragile: false },
  // Gogarth sea cliffs: seepage after wet spells.
  quartzite: { Wmax: 0.5, Dmax: 10, kin: 0.30, tauD: 150, kw: 0.07, fragile: false },
  // Pembroke/Gower: surface dries fast, seepage after prolonged rain.
  limestone: { Wmax: 0.4, Dmax: 10, kin: 0.35, tauD: 150, kw: 0.06, fragile: false },
};

const SEEP = { low: 0.5, med: 1, high: 2 };

export const THRESH = { dry: 0.08, damp: 0.35, rain: 0.2 };

export const es = T => 0.6108 * Math.exp(17.27 * T / (T + 237.3));            // kPa
const delta = T => 4098 * es(T) / (T + 237.3) ** 2;                             // kPa/K
export const dewPoint = (T, RH) => {
  const a = Math.log(Math.max(RH, 1) / 100) + 17.27 * T / (T + 237.3);
  return 237.3 * a / (17.27 - a);
};

// Sun position (NOAA simplified). Returns zenith & azimuth (deg from N, clockwise).
export function sunPos(unix, lat, lon) {
  const d = new Date(unix * 1000);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
               Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = 2 * Math.PI / 365 * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hr * 60 + eqt + 4 * lon;
  const ha = (tst / 4 - 180) * DEG;
  const phi = lat * DEG;
  const cz = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cz)));
  let az = Math.acos(Math.min(1, Math.max(-1,
    (Math.sin(phi) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(phi) * Math.sin(zen)))));
  az = ha > 0 ? (az / DEG + 180) % 360 : (540 - az / DEG) % 360;
  return { zen: zen / DEG, az, doy };
}

// Global horizontal irradiance -> irradiance on a vertical face (Erbs split, isotropic sky).
// Open-Meteo radiation is the mean over the preceding hour, so use the mid-hour sun.
export function faceIrradiance(ghi, unix, lat, lon, aspect, shade = 1) {
  if (!(ghi > 0)) return { gt: 0, beam: 0 };
  const { zen, az, doy } = sunPos(unix - 1800, lat, lon);
  const cz = Math.cos(zen * DEG);
  if (cz <= 0.02) return { gt: 0.5 * ghi * shade, beam: 0 };
  const i0 = 1361 * (1 + 0.033 * Math.cos(2 * Math.PI * doy / 365));
  const kt = Math.min(1, ghi / (i0 * cz));
  const fd = kt <= 0.22 ? 1 - 0.09 * kt
    : kt <= 0.8 ? 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4
    : 0.165;
  const dhi = fd * ghi;
  const dni = Math.min(1000, (ghi - dhi) / Math.max(cz, 0.087));
  const cosInc = Math.sin(zen * DEG) * Math.cos((az - aspect) * DEG);
  const beam = dni * Math.max(0, cosInc);
  const diffuse = 0.5 * dhi + 0.1 * ghi;           // sky half + ground reflection (albedo 0.2)
  return { gt: shade * beam + (0.5 + 0.5 * shade) * diffuse, beam: shade * beam };
}

export function initState() { return { W: 0, D: 0, C: 0, Tr: null }; }

// How much the crag is sitting in mist / low cloud this hour (0..1), from model visibility,
// humidity, low cloud and fog/drizzle weather codes. Moorland edges catch "clag" that
// barely registers as rain but soaks the rock.
export function fogLevel(x) {
  const code = x.code ?? 0, vis = x.vis ?? 1e5, low = x.low ?? 0;
  if (vis < 200 || ((code === 45 || code === 48) && x.RH >= 97)) return 1;
  if (vis < 1000) return 0.7;
  if (x.RH >= 98 && low >= 90) return 0.5;
  if (code >= 51 && code <= 57 && x.RH >= 95) return 0.5;   // drizzle in the murk
  return 0;
}

// One hour. `x` = { P, T, RH, U, gt, fog }, crag = { shelter, green, rock }.
// Mutates `s`, returns diagnostics for this hour.
export function step(s, x, crag) {
  const r = ROCK[crag.rock] || ROCK.grit;
  const u = Math.max(0.3, x.U * crag.shelter * 0.6);     // 10 m wind -> near-face wind
  const hc = 5.7 + 3.8 * u;                              // W/m2/K convective coefficient

  // Rock surface temperature: lags air temp, warmed by sun on the face, cooled by wind.
  const Teq = x.T + 0.03 * x.gt / (1 + 0.25 * u);
  s.Tr = s.Tr == null ? Teq : s.Tr + (Teq - s.Tr) / 4;

  const ea = es(x.T) * x.RH / 100;
  const vpd = Math.max(0, es(x.T) - ea);
  const Rn = 0.65 * x.gt;
  const d = delta(x.T);
  let E = (d * Rn + hc * vpd) / (d + GAMMA) / LAMBDA * 3600;   // mm/h
  // Rock still warm from the day keeps evaporating after dark; Penman (air temp) misses this.
  // Halved because evaporation cools the surface it comes from.
  const Ewarm = 0.5 * hc * (es(s.Tr) - ea) / GAMMA / LAMBDA * 3600;
  E = Math.max(E, Ewarm) / crag.green;

  // Condensation when the air's vapour pressure exceeds saturation at rock temp.
  const cond = Math.max(0, hc * (ea - es(s.Tr)) / GAMMA / LAMBDA * 3600);

  // Mist/cloud droplets impacting on the face; more with wind (fog interception).
  const dep = (x.fog ?? 0) * (0.03 + 0.025 * u);

  // Deep store: soaks up some rain, drains, and wicks back to the surface when full.
  const fill = s.D / r.Dmax;
  const soak = r.kin * x.P * (1 - fill);
  const wick = r.kw * Math.max(0, fill - 0.5) * 2 * crag.green * (SEEP[crag.seepage] ?? 1);
  s.D = Math.max(0, s.D + soak - s.D / r.tauD - wick - 0.1 * E * fill);

  s.W = Math.min(r.Wmax, s.W + x.P + cond + wick + dep);
  s.W = Math.max(0, s.W - E);

  // Cracks: run-off from above, seepage once the rock is ~1/3 saturated, little sun or wind.
  const Cmax = 1.2 * r.Wmax;
  const seepC = 1.5 * r.kw * Math.max(0, fill - 0.3) / 0.7 * crag.green * (SEEP[crag.seepage] ?? 1);
  s.C = Math.min(Cmax, s.C + 1.3 * x.P + 0.5 * dep + cond + seepC);
  s.C = Math.max(0, s.C - 0.5 * E);
  const wc = s.C / Cmax;
  const cstate = x.P >= THRESH.rain || wc >= THRESH.damp ? 2 : wc >= THRESH.dry ? 1 : 0;

  const w = s.W / r.Wmax;
  const state = x.P >= THRESH.rain || w >= THRESH.damp ? 2 : w >= THRESH.dry ? 1 : 0;
  return { state, cstate, seeping: seepC > 0.01, w, fill: s.D / r.Dmax, E, cond, Tr: s.Tr, u, sweat: cond > 0.005, fog: (x.fog ?? 0) > 0 };
}

// Grit friction 0..1 from rock temp, humidity and breeze (only meaningful when dry).
export function friction(h, x) {
  const clamp = v => Math.min(1, Math.max(0, v));
  const Td = dewPoint(x.T, x.RH);
  let f = 1;
  f -= 0.6 * clamp((h.Tr - 12) / 12);
  f -= 0.5 * clamp((x.RH - 55) / 35);
  f -= 0.3 * clamp((Td - 8) / 8);
  f += 0.1 * Math.min(h.u, 4) / 4;
  if (h.Tr < 2) f -= 0.15;
  if (h.sweat || h.fog) f -= 0.3;
  return clamp(f);
}

export const frictionLabel = f =>
  f > 0.8 ? 'prime' : f > 0.6 ? 'good' : f > 0.4 ? 'ok' : f > 0.2 ? 'greasy' : 'poor';

// First light / sunrise / sunset / last light for a UTC calendar day (unix seconds or null).
// Civil twilight (sun 6° below horizon) is when it's light enough to climb without a torch.
export function sunTimes(dateStr, lat, lon) {
  const t0 = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)) / 1000;
  const out = { dawn: null, rise: null, set: null, dusk: null };
  let prev = sunPos(t0, lat, lon).zen;
  for (let t = t0 + 60; t <= t0 + 86400; t += 60) {
    const z = sunPos(t, lat, lon).zen;
    if (prev > 96 && z <= 96) out.dawn = t;
    if (prev > 90.833 && z <= 90.833) out.rise = t;
    if (prev <= 90.833 && z > 90.833) out.set = t;
    if (prev <= 96 && z > 96) out.dusk = t;
    prev = z;
  }
  return out;
}
