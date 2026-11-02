import { CRAGS, REGIONS, GROUPS } from './crags.js';
import { fetchRegion, runRegion, dayList, summarise, localParts, lightTimes, pickScore } from './forecast.js';
import { REPORT_URL, MODEL_VERSION } from './config.js';

const SESSIONS = {
  day: { label: 'Daytime (10am–6pm)', hours: [10, 18] },
  long: { label: 'Long day (7am–7pm)', hours: [7, 19] },
  morning: { label: 'Morning (7–11am)', hours: [7, 11] },
  evening: { label: 'Afternoon & evening (2–8pm)', hours: [14, 20] },
};
const STRIP = [6, 22];   // hours in the hourly bar

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('isitdry.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('isitdry.' + k, JSON.stringify(v)); } catch {} },
};

const ui = {
  region: store.get('region', 'peak'),
  session: store.get('session', 'day'),
  sel: store.get('sel', {}),           // region -> sector id
  openDay: null,
};
if (!REGIONS[ui.region]) ui.region = 'peak';
if (!SESSIONS[ui.session]) ui.session = 'day';

const cache = {};                       // region -> { runs, days, fetched }
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- words & symbols ----------

const VERDICTS = [
  { min: 0.8, v: 4, word: 'Dry', dot: '●' },
  { min: 0.6, v: 3, word: 'Should be dry', dot: '◕' },
  { min: 0.4, v: 2, word: '50/50', dot: '◑' },
  { min: 0.2, v: 1, word: 'Probably damp', dot: '◔' },
  { min: -1, v: 0, word: 'Wet', dot: '○' },
];
const verdict = p => p == null ? { v: 2, word: 'No data', dot: '·' } : VERDICTS.find(x => p >= x.min);
const dotHTML = p => { const x = verdict(p); return `<span class="dot v${x.v}" aria-hidden="true"></span>`; };
const verdictHTML = p => { const x = verdict(p); return `${dotHTML(p)}<span class="verdict v${x.v}">${x.word}</span>`; };

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const WINDADJ = ['northerly', 'north-easterly', 'easterly', 'south-easterly', 'southerly', 'south-westerly', 'westerly', 'north-westerly'];
const ARROW = ['↓', '↙', '←', '↖', '↑', '↗', '→', '↘'];   // points where the wind blows TO
const oct = d => Math.round((((d % 360) + 360) % 360) / 45) % 8;
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const ampm = h => h === 0 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h}am` : `${h - 12}pm`;
const clock = u => {
  if (u == null) return '–';
  const { hour, min } = localParts(u);
  return `${hour % 12 || 12}:${String(min).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
};

const hm = u => { const { hour, min } = localParts(u); return `${hour % 12 || 12}:${String(min).padStart(2, '0')}`; };

const windWord = k => k < 8 ? 'still' : k < 20 ? 'light breeze' : k < 30 ? 'breezy' : k < 45 ? 'windy' : 'blowing a hoolie';
const airWord = rh => rh < 65 ? 'dry' : rh < 80 ? 'fairly dry' : rh < 90 ? 'humid' : 'muggy';
const condWord = f => f == null ? null : f > 0.8 ? 'prime' : f > 0.6 ? 'good' : f > 0.4 ? 'average' : f > 0.2 ? 'greasy' : 'minging';
const tempWord = t => t < 3 ? 'baltic' : t < 9 ? 'cold' : t < 15 ? 'cool' : t < 20 ? 'mild' : 'warm';
const rainWord = mm => mm < 0.5 ? 'a few drops of' : mm < 3 ? 'light' : mm < 10 ? 'moderate' : 'heavy';

function wxEmoji(s) {
  if (s.rainChance >= 0.6) return ['🌧️', 'rain likely'];
  if (s.codes.some(c => c >= 95)) return ['⛈️', 'thunder possible'];
  if (s.codes.some(c => (c >= 71 && c <= 77) || c === 85 || c === 86)) return ['🌨️', 'snow'];
  if (s.rainChance >= 0.3) return ['🌦️', 'showers possible'];
  if (s.fogH > s.codes.length / 3) return ['🌫️', 'mist / low cloud'];
  if (s.sunny > 0.5) return ['☀️', 'sunny'];
  if (s.codes.filter(c => c >= 3).length / s.codes.length > 0.6) return ['☁️', 'cloudy'];
  return s.sunny > 0.2 ? ['🌤️', 'sunny spells'] : ['⛅', 'some sun'];
}
const em = (e, label) => `<span class="emoji"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>${e}</span>`;

const utcNoon = d => new Date(d + 'T12:00:00Z');
const fmt = (d, o) => utcNoon(d).toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
const dayName = (d, k) => k === 0 ? 'Today' : k === 1 ? 'Tmrw' : fmt(d, { weekday: 'short' });
const shortDay = (d, k) => k === 0 ? 'Today' : k === 1 ? 'Tmrw' : fmt(d, { weekday: 'short' });
const dateNum = d => fmt(d, { day: 'numeric', month: 'short' });
const isWeekend = d => [0, 6].includes(utcNoon(d).getUTCDay());

function whenText(s) {
  const w = s.when;
  if (w.kind === 'all') return 'Dry all session';
  if (w.kind === 'from') return `Dry from ${ampm(w.hour)}`;
  if (w.kind === 'until') return `Dry until ${ampm(w.hour)}`;
  if (w.kind === 'patchy') return `On and off, ~${w.n} dry hours`;
  return 'Not expected to dry';
}

function crackText(s) {
  if (s.pCrack == null) return null;
  if (s.pCrack >= 0.6) return ['v4', '<b>dry</b>'];
  if (s.seepH) return [s.pCrack >= 0.35 ? 'v2' : 'v0', `<b>seeping</b> — the rock is still draining after a wet spell; expect wet cracks, breaks and drainage streaks`];
  if (s.pCrack >= 0.35) return ['v2', '<b>may be damp at the back</b> — cracks dry slower than the face'];
  return ['v1', '<b>still damp</b> — cracks hold water long after the face dries'];
}

function rockText(s) {
  if (s.rockState === 'wet') return s.fragile
    ? ['v0', "<b>wet — leave it.</b> Wet grit is weak; holds and flakes snap."]
    : ['v0', '<b>wet</b> — slippery, not worth it.'];
  if (s.rockState === 'soaked') return s.fragile
    ? ['v2', '<b>saturated</b> after a wet spell — may look dry but go easy on flakes and soft holds.']
    : ['v2', '<b>seeping</b> after a wet spell — drainage lines and cracks likely wet.'];
  return ['v4', '<b>dry, good to go.</b>'];
}

// ---------- rendering ----------

const crg = () => CRAGS.filter(c => c.region === ui.region);
const selected = () => crg().find(c => c.id === ui.sel[ui.region]) || crg()[0];

function renderControls() {
  $('region').innerHTML = Object.entries(REGIONS).map(([k, r]) =>
    `<option value="${k}"${k === ui.region ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
  $('session').innerHTML = Object.entries(SESSIONS).map(([k, s]) =>
    `<option value="${k}"${k === ui.session ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  renderPickers();
}

function renderPickers() {
  const list = crg(), cur = selected();
  const crags = [...new Map(list.map(c => [c.crag, c])).values()];
  const groups = [...new Set(crags.map(c => c.group))];
  $('crag').innerHTML = groups.map(g => `<optgroup label="${esc(GROUPS[g] || g)}">` +
    crags.filter(c => c.group === g).map(c =>
      `<option value="${esc(c.crag)}"${c.crag === cur.crag ? ' selected' : ''}>${esc(c.crag)}</option>`).join('') +
    '</optgroup>').join('');
  const secs = list.filter(c => c.crag === cur.crag);
  $('sectorWrap').hidden = secs.length < 2;
  $('sector').innerHTML = secs.map(c =>
    `<option value="${c.id}"${c.id === cur.id ? ' selected' : ''}>${esc(c.sector || c.crag)}</option>`).join('');
}

const sums = (run, days) => days.map(d => summarise(run, d, SESSIONS[ui.session].hours));

function renderOverview({ runs, days }) {
  const d3 = days.slice(0, 3);
  const all = runs.map(r => ({ r, s: sums(r, d3) }));
  let html = `<h2>Next 3 days · ${esc(REGIONS[ui.region].name)}</h2><div class="cards">`;
  d3.forEach((d, k) => {
    const ss = all.map(x => x.s[k]).filter(Boolean);
    if (!ss.length) return;
    const avg = f => ss.reduce((a, s) => a + f(s), 0) / ss.length;
    const nDry = ss.filter(s => s.p >= 0.6).length;
    const status = nDry >= 0.7 * ss.length ? 'Mostly dry' : nDry >= 0.3 * ss.length ? 'Mixed' : nDry ? 'Mostly wet' : 'Wet';
    const v = verdict(avg(s => s.p ?? 0));
    const [e, lab] = wxEmoji(ss[0]);

    const best = new Map();   // best sector per crag
    all.forEach(({ r, s }) => {
      // Prefer crags with good VS–E2 classics; avoid MoD range crags on weekdays (firing).
      let sc = pickScore(s[k]) + 0.02 * Math.min(3, r.crag.classics?.length ?? 0);
      if (r.crag.weekday_closed && !isWeekend(d)) sc *= 0.3;
      const cur = best.get(r.crag.crag);
      if (!cur || sc > cur.sc) best.set(r.crag.crag, { sc, r, s: s[k] });
    });
    const top = [...best.values()].sort((a, b) => b.sc - a.sc)[0];
    const lt = lightTimes(runs[0], d);
    const why = top ? pickWhy(top, ss) : '';
    html += `<div class="card">
      <div class="day">${shortDay(d, k)} <span class="dim">${dateNum(d).split(' ')[0]}</span></div>
      <div class="row"><span class="dot v${v.v}" aria-hidden="true"></span><b class="v${v.v}">${status}</b></div>
      <div class="row">${em(e, lab)} ${Math.round(avg(s => s.tmax))}° · rain ${Math.round(avg(s => s.rainChance) * 10) * 10}%</div>
      <div class="row dim">${windWord(avg(s => s.wind))}${avg(s => s.fogH) >= 2 ? ' · clag' : ''}</div>
      <div class="best">${top && top.sc >= 0.35
        ? `Best bet:<br><button data-pick="${top.r.crag.id}">${esc(top.r.crag.short)}</button>${why ? `<br><span class="dim">${esc(why)}</span>` : ''}`
        : '<span class="dim">Nowhere looks dry</span>'}</div>
      ${lt ? `<div class="light">sun ${hm(lt.rise)}–${hm(lt.set)}<br>light ${hm(lt.dawn)}–${hm(lt.dusk)}</div>` : ''}
    </div>`;
  });
  $('overview').innerHTML = html + '</div>';
}

function pickWhy({ s }, ss) {
  const bits = [];
  const avgFace = ss.reduce((a, x) => a + x.faceWind, 0) / ss.length;
  if (s.wind >= 25 && s.faceWind < 0.75 * avgFace) bits.push('out of the wind');
  if (s.sunH >= 2) bits.push('sun on the rock');
  if ((s.grip ?? 0) > 0.8) bits.push('prime conditions');
  if (!bits.length && s.p >= 0.8) bits.push('quick drying');
  return bits.slice(0, 2).join(', ');
}

function renderCrag({ runs, days }) {
  const c = selected();
  const run = runs.find(r => r.crag.id === c.id);
  const ss = sums(run, days);
  let html = `<div class="cragHead">
    <div class="name">${esc(c.crag)}${c.sector ? ` · ${esc(c.sector)}` : ''}</div>
    <div class="meta">faces ${COMPASS[oct(c.aspect_deg)]} · ${esc(c.rock)} · ${c.alt} m${c.tidal ? ' · tidal' : ''}${c.ukc_url ? ` · <a href="${esc(c.ukc_url)}" target="_blank" rel="noopener">UKC ↗</a>` : ''}</div>
    ${c.drying_notes ? `<div class="notes">${esc(c.drying_notes)}</div>` : ''}
    ${c.classics?.length ? `<div class="notes"><span class="dim">Classics:</span> ${esc(c.classics.join(' · '))}</div>` : ''}
    ${c.access ? `<div class="warn">⚠︎ Access: ${esc(c.access)}</div>` : ''}
  </div><div class="days">`;
  days.forEach((d, k) => {
    const s = ss[k];
    if (!s || s.p == null) return;   // beyond the forecast (backup mode is shorter)
    const [e, lab] = wxEmoji(s);
    const open = ui.openDay === d;
    const cond = condWord(s.grip);
    html += `<div class="dayrow${open ? ' open' : ''}">
      <button data-day="${d}" aria-expanded="${open}">
        <span class="dname">${dayName(d, k)}<small>${dateNum(d)}${isWeekend(d) ? ' · wknd' : ''}</small></span>
        <span class="line">${verdictHTML(s.p)}<br><span class="sub">${whenText(s)}${cond && s.rockState !== 'wet' ? ` · ${cond} conditions` : ''}${s.p >= 0.6 && s.pCrack != null && s.pCrack < 0.4 ? (s.seepH ? ' · seeping' : ' · damp cracks') : ''}${c.weekday_closed && !isWeekend(d) ? ' · ⚠︎ range may be firing' : ''}</span></span>
        <span class="wxcol">${em(e, lab)} ${Math.round(s.tmax)}°<br><span class="sub">${Math.round(s.wind)} km/h</span></span>
      </button>
      ${open ? detail(run, s, d, k) : ''}
    </div>`;
  });
  html += '</div><p class="dim" style="font-size:12px">Tap a day for hour-by-hour detail. More than 3 days ahead, treat it as a rough guide.</p>';
  html += reportForm(c);
  $('cragView').innerHTML = html;
}

// Weather emoji for one hour: rain chance from the ensemble, the rest from the main
// model's weather code and our mist estimate.
function hourSymbol(run, i, dark) {
  const x = run.det[i].x, pr = run.pRain[i] ?? 0, c = x.code;
  if (c >= 95) return ['⛈️', 'thunder'];
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return ['🌨️', 'snow'];
  if (pr >= 0.5) return ['🌧️', `rain likely (${Math.round(pr * 100)}%)`];
  if (x.fog >= 0.5) return ['🌫️', 'mist / low cloud'];
  if (pr >= 0.25) return [dark ? '🌧️' : '🌦️', `chance of rain (${Math.round(pr * 100)}%)`];
  if (c <= 1) return dark ? ['🌙', 'clear'] : ['☀️', 'sunny'];
  if (c === 2) return dark ? ['🌙', 'partly cloudy'] : ['🌤️', 'sunny spells'];
  return ['☁️', 'cloudy'];
}

function detail(run, s, d, k) {
  const c = run.crag;
  const lt = lightTimes(run, d);
  let cells = '', ticks = '';
  for (let hr = STRIP[0]; hr < STRIP[1]; hr++) {
    const h = s.hours.find(x => x.hour === hr);
    const p = h ? run.pDry[h.i] : null;
    const t = h ? run.t[h.i] : null;
    // fraction of this hour that is dark (before first light / after last light)
    let dark = 0;
    if (lt && t != null) {
      dark = (Math.max(0, Math.min(t + 3600, lt.dawn) - t) + Math.max(0, t + 3600 - Math.max(t, lt.dusk))) / 3600;
    }
    const [sym, what] = h ? hourSymbol(run, h.i, dark >= 0.5) : ['', ''];
    const cls = ['hc', dark >= 0.75 ? 'night' : dark > 0.25 ? 'dusk' : ''].join(' ');
    const tip = `${ampm(hr)}: ${what}${p == null ? '' : ', rock ' + verdict(p).word.toLowerCase()}`;
    cells += `<span class="${cls}" title="${esc(tip)}"><i class="emoji">${sym}</i>${p == null ? '<span class="dot"></span>' : dotHTML(p)}</span>`;
    ticks += `<span>${hr % 3 === 0 ? ampm(hr) : ''}</span>`;
  }

  const facts = [];
  const rc = Math.round(s.rainChance * 10) * 10;
  facts.push(['rain', s.rainChance < 0.1 ? '<b>unlikely</b> while you\'re out'
    : `<b>${rc}% chance</b> while you're out${s.rainAmt >= 0.2 ? `, ${rainWord(s.rainAmt).replace(' of', '')} (~${s.rainAmt.toFixed(1)} mm)` : ''}`]);
  if (s.fogH) facts.push(['clag', `<b>mist / low cloud for ~${s.fogH}h</b> — soaks the rock even without proper rain`]);
  if (s.rain48 >= 0.3) {
    const lp = s.lastRain ? localParts(s.lastRain) : null;
    const when = lp ? `, last at ${ampm(lp.hour)}${lp.date !== d ? ' ' + fmt(lp.date, { weekday: 'short' }) : ''}` : '';
    facts.push(['before', `${rainWord(s.rain48)} rain in the previous 48h (${s.rain48.toFixed(1)} mm${when})`]);
  } else facts.push(['before', '<b>dry</b> for the previous 48h']);
  facts.push(['sun', s.sunH
    ? `on the rock for ~<b>${s.sunH}h</b> from ${clock(s.sunFirst)}`
    : `<b>little or none</b> on the rock${angDiff(c.aspect_deg, 180) > 120 ? ' (this face rarely gets any)' : ''}`]);
  const o = oct(s.dir), rel = angDiff(s.dir, c.aspect_deg);
  facts.push(['wind', `<b>${windWord(s.wind)}</b>, ${Math.round(s.wind)} km/h ${WINDADJ[o]} ${ARROW[o]}` +
    `${s.gust >= 45 ? `, gusting ${Math.round(s.gust)}` : ''}` +
    `${s.wind >= 20 && rel < 60 ? ' — straight onto the face' : s.wind >= 20 && rel > 120 ? ' — crag is in the lee' : ''}`]);
  facts.push(['air', `<b>${airWord(s.rh)}</b>, ${Math.round(s.rh)}% humidity` +
    `${s.rh >= 92 ? ' — slow drying, greasy' : s.rh >= 82 ? ' — slows drying' : s.rh < 70 ? ' — good for drying and friction' : ''}`]);
  facts.push(['temp', `<b>${tempWord(s.tmax)}</b>, ${Math.round(s.tmin)}–${Math.round(s.tmax)}°C${s.tmax < 4 ? ' — numb fingers' : s.tmax > 18 && s.fragile ? ' — too warm for good grit friction' : ''}`]);
  if (s.sweat) facts.push(['sweat', 'rock may be sweating — damp air condensing on cold rock, usually early on']);
  if (s.grip != null && s.rockState !== 'wet') facts.push(['friction', `<b>${condWord(s.grip)}</b> when dry`]);
  const [rc2, rt] = rockText(s);
  facts.push(['rock', `<span class="${rc2}">${rt}</span>`]);
  const ct = crackText(s);
  if (ct && s.rockState !== 'wet') facts.push(['cracks', `<span class="${ct[0]}">${ct[1]}</span>`]);
  if (s.tide) {
    const ts = type => s.tide.ext.filter(x => x.type === type).map(x => '~' + ampm(localParts(x.t).hour)).join(' & ') || '–';
    const w = s.tide.wave;
    facts.push(['tide', `low ${ts('low')}, high ${ts('high')}; swell <b>${w < 0.8 ? 'small' : w < 1.5 ? 'moderate' : w < 2.5 ? 'big' : 'huge'}</b> (${w.toFixed(1)} m)` +
      `${c.tide_note ? `. ${esc(c.tide_note)}` : ''}`]);
  }
  if (lt) facts.push(['light', `${clock(lt.dawn)}–${clock(lt.dusk)}, head torch outside that (sunrise ${clock(lt.rise)}, sunset ${clock(lt.set)})`]);

  return `<div class="detail">
    <div class="strip"><div class="hours">${cells}</div><div class="ticks">${ticks}</div>
    <div class="cap">top: weather · bottom: rock face (<span class="dot v4"></span>dry <span class="dot v2"></span>50/50 <span class="dot v0"></span>wet) · dark = night</div></div>
    <dl class="facts">${facts.map(([l, t]) => `<dt>${l}</dt><dd>${t}</dd>`).join('')}</dl>
    ${k >= 3 ? '<p class="dim" style="font-size:12px;margin:8px 0 0">This far out the forecast can still change a lot.</p>' : ''}
  </div>`;
}

// ---------- condition reports ----------
// Ground truth for checking the model: what people actually found at the crag.

const REPORT_Q = [
  ['face', 'The rock', [['dry', 'Dry'], ['patchy', 'Damp patches'], ['wet', 'Wet']]],
  ['cracks', 'Cracks', [['dry', 'Dry'], ['damp', 'Damp'], ['seeping', 'Seeping'], ['na', "Didn't check"]]],
  ['conditions', 'Conditions', [['prime', 'Prime'], ['good', 'Good'], ['average', 'Average'], ['greasy', 'Greasy']]],
];
const report = { open: false, ans: {}, sent: null };

function reportForm(c) {
  const today = localParts(Date.now() / 1000).date;
  const yest = localParts(Date.now() / 1000 - 86400).date;
  if (report.sent === c.id) return `<div class="report"><p><b>Thanks!</b> Report saved${REPORT_URL ? ' and sent' : ' on this phone'}. It helps tune the model.</p>
    <p class="dim">${myReports().length} report(s) from this device · <button class="linkish" id="dlReports">download CSV</button></p></div>`;
  if (!report.open) return `<div class="report"><button class="chipbtn" id="openReport">Been to ${esc(c.sector || c.crag)}? Report conditions</button></div>`;
  const chips = ([key, label, opts]) => `<div class="q"><div class="dim">${label}</div><div class="chips">${
    opts.map(([v, t]) => `<button class="chip${report.ans[key] === v ? ' on' : ''}" data-q="${key}" data-v="${v}">${t}</button>`).join('')}</div></div>`;
  return `<div class="report">
    <div class="q"><div class="dim">When</div><div class="chips">
      <button class="chip${(report.ans.date ?? today) === today ? ' on' : ''}" data-q="date" data-v="${today}">Today</button>
      <button class="chip${report.ans.date === yest ? ' on' : ''}" data-q="date" data-v="${yest}">Yesterday</button></div></div>
    <div class="q"><div class="dim">Roughly what time</div><div class="chips">
      ${[['am', 'Morning'], ['pm', 'Afternoon'], ['eve', 'Evening']].map(([v, t]) =>
        `<button class="chip${report.ans.time === v ? ' on' : ''}" data-q="time" data-v="${v}">${t}</button>`).join('')}</div></div>
    ${REPORT_Q.map(chips).join('')}
    <div class="q"><div class="dim">Anything else? (optional)</div>
      <input id="repNote" maxlength="200" placeholder="e.g. green at the back of Hollyash, rest fine" value="${esc(report.ans.note || '')}"></div>
    <div class="chips"><button class="chipbtn" id="sendReport"${report.ans.face ? '' : ' disabled'}>Send report</button>
      <button class="linkish dim" id="cancelReport">cancel</button></div>
  </div>`;
}

function myReports() { return store.get('reports', []); }

async function sendReport() {
  const c = selected();
  const data = cache[ui.region];
  const run = data.runs.find(r => r.crag.id === c.id);
  const date = report.ans.date ?? localParts(Date.now() / 1000).date;
  const hours = { am: [8, 12], pm: [12, 17], eve: [16, 20] }[report.ans.time] ?? SESSIONS[ui.session].hours;
  const s = summarise(run, date, hours);
  const rec = {
    reported_at: new Date().toISOString(), date, time: report.ans.time ?? '',
    crag_id: c.id, crag: c.crag, sector: c.sector ?? '',
    face: report.ans.face, cracks: report.ans.cracks ?? '', conditions: report.ans.conditions ?? '',
    note: ($('repNote')?.value ?? '').slice(0, 200),
    pred_face: s?.p != null ? +s.p.toFixed(2) : '', pred_cracks: s?.pCrack != null ? +s.pCrack.toFixed(2) : '',
    pred_conditions: s?.grip != null ? +s.grip.toFixed(2) : '', pred_hours: hours.join('-'), model: MODEL_VERSION,
  };
  store.set('reports', [...myReports(), rec]);
  if (REPORT_URL) {
    // no-cors: Apps Script doesn't send CORS headers; the request still lands.
    try { await fetch(REPORT_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(rec) }); }
    catch (e) { console.warn('report send failed', e); }
  }
  report.sent = c.id; report.open = false; report.ans = {};
  renderCrag(cache[ui.region]);
}

function downloadReports() {
  const rows = myReports();
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map(r => cols.map(k => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'isitdry-reports.csv';
  a.click();
}

function renderAll({ runs, days }) {
  const cur = selected();
  let html = '<table><thead><tr><th></th>' + days.map((d, k) =>
    `<th>${shortDay(d, k)}<br>${dateNum(d).split(' ')[0]}</th>`).join('') + '</tr></thead><tbody>';
  let g = null;
  for (const r of runs) {
    if (r.crag.group !== g) { g = r.crag.group; html += `<tr class="grp"><td colspan="${days.length + 1}">${esc(GROUPS[g] || g)}</td></tr>`; }
    html += `<tr class="r${r.crag.id === cur.id ? ' sel' : ''}" data-pick="${r.crag.id}"><td class="n">${esc(r.crag.short)}</td>` +
      sums(r, days).map(s => `<td title="${s ? verdict(s.p).word : ''}">${s ? dotHTML(s.p) : ''}</td>`).join('') + '</tr>';
  }
  $('all').innerHTML = html + '</tbody></table><p class="dim" style="font-size:12px">Fuller circle = drier. Tap a crag to see its forecast.</p>';
}

function renderHowto() {
  const meaning = ['nearly every forecast has it wet', 'most forecasts have it damp or wet',
    'forecasts split — could go either way', 'most forecasts have it dry', 'nearly every forecast has it dry'];
  $('howto').innerHTML = `
    <p>Each day is the chance the rock is dry for most of the hours you picked under <b>When</b>.
    Fuller circle = drier:</p>
    <ul class="key">${[...VERDICTS].reverse().map(x => `<li><span class="dot v${x.v}"></span> <b class="v${x.v}">${x.word}</b> — ${meaning[x.v]}</li>`).join('')}</ul>
    <p><b>Conditions</b> is friction on dry rock: <b>prime</b> (cold, dry, breezy) → good → average →
    <b>greasy</b> (mild and humid) → <b>minging</b>.</p>
    <p>Tap a day for the hourly bar (dark boxes = night) and the details:</p>
    <dl class="facts">
      <dt>rain</dt><dd>chance of rain while you're out</dd>
      <dt>clag</dt><dd>mist / low cloud — wets moorland edges even when it isn't really raining</dd>
      <dt>sun</dt><dd>hours of sun actually on the face, not just in the sky</dd>
      <dt>wind</dt><dd>dries rock fast; arrow shows where it's blowing to; "in the lee" = sheltered</dd>
      <dt>air</dt><dd>humidity: muggy air dries rock slowly and makes it greasy</dd>
      <dt>cracks</dt><dd>cracks, breaks and the backs of chimneys dry about half as fast as open faces, collect run-off, and seep after a wet spell</dd>
      <dt>rock</dt><dd>wet grit is weak and holds snap, so leave it; "saturated" or "seeping" = damp inside after a wet spell</dd>
      <dt>tide</dt><dd>approximate tide times and swell for sea cliffs</dd>
      <dt>light</dt><dd>first to last light; head torch outside that</dd>
    </dl>
    <p><b>Best bet</b> is the crag most likely to be dry with the best conditions, avoiding faces
    taking the full force of a strong wind.</p>`;
}

function renderStatus(msg) {
  if (msg) { $('status').textContent = msg; return; }
  const d = cache[ui.region];
  const t = new Date(d.fetched).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const note = d.mode === 'cached' ? ` · <span class="v1">weather server busy, showing the forecast from ${t}</span>`
    : d.mode === 'backup' ? ' · <span class="v1">main weather server busy, using a backup forecast (a bit less accurate)</span>' : '';
  $('status').innerHTML = `Updated ${t}${note} · <button class="linkish" id="refresh">refresh</button>`;
  $('refresh').onclick = () => load(true);
}

function renderData() {
  const d = cache[ui.region];
  if (!d) return;
  renderOverview(d);
  renderCrag(d);
  if ($('allWrap').open) renderAll(d);
}

// ---------- events ----------

function choose(id, scroll) {
  ui.sel[ui.region] = id;
  report.open = false; report.ans = {}; report.sent = null;
  store.set('sel', ui.sel);
  renderPickers();
  renderData();
  if (scroll) document.querySelector('.pick').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('region').onchange = e => { ui.region = e.target.value; store.set('region', ui.region); ui.openDay = null; renderPickers(); load(); };
$('session').onchange = e => { ui.session = e.target.value; store.set('session', ui.session); renderData(); };
$('crag').onchange = e => choose(crg().find(c => c.crag === e.target.value).id, false);
$('sector').onchange = e => choose(e.target.value, false);
$('allWrap').ontoggle = () => { if ($('allWrap').open && cache[ui.region]) renderAll(cache[ui.region]); };

document.addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'openReport') { report.open = true; report.sent = null; renderCrag(cache[ui.region]); return; }
  if (t.id === 'cancelReport') { report.open = false; report.ans = {}; renderCrag(cache[ui.region]); return; }
  if (t.id === 'sendReport') { report.ans.note = $('repNote')?.value; sendReport(); return; }
  if (t.id === 'dlReports') { downloadReports(); return; }
  const chip = t.closest('button[data-q]');
  if (chip) {
    report.ans.note = $('repNote')?.value;
    report.ans[chip.dataset.q] = chip.dataset.v;
    renderCrag(cache[ui.region]);
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (pick) { choose(pick.dataset.pick, true); return; }
  const day = e.target.closest('button[data-day]');
  if (day) { ui.openDay = ui.openDay === day.dataset.day ? null : day.dataset.day; renderCrag(cache[ui.region]); }
});

async function load(force = false) {
  const region = ui.region;
  const c = cache[region];
  if (c && !force && c.mode === 'live' && Date.now() - c.fetched < 30 * 60e3) { renderStatus(); renderData(); return; }
  renderStatus('Loading forecast…');
  try {
    const crags = CRAGS.filter(x => x.region === region);
    const wx = await fetchRegion(REGIONS[region], crags, region);
    const runs = runRegion(REGIONS[region], crags, wx);
    cache[region] = { runs, days: dayList(runs[0]), fetched: wx.fetched, mode: wx.mode };
    if (region !== ui.region) return;
    renderStatus();
    renderData();
  } catch (err) {
    console.error(err);
    renderStatus(`Couldn't load the forecast (${err.message}). Check your signal and tap refresh.`);
  }
}

renderControls();
renderHowto();
load();
