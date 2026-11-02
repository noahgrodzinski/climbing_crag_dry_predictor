import { CRAGS, REGIONS, GROUPS } from './crags.js';
import { fetchRegion, runRegion, dayList, summarise, localParts, lightTimes, pickScore } from './forecast.js';

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
  { min: 0.6, v: 3, word: 'Probably dry', dot: '◕' },
  { min: 0.4, v: 2, word: 'Maybe', dot: '◑' },
  { min: 0.2, v: 1, word: 'Probably wet', dot: '◔' },
  { min: -1, v: 0, word: 'Wet', dot: '○' },
];
const verdict = p => p == null ? { v: 2, word: 'No data', dot: '·' } : VERDICTS.find(x => p >= x.min);
const dotHTML = p => { const x = verdict(p); return `<span class="dot v${x.v}" aria-hidden="true"></span>`; };
const verdictHTML = p => { const x = verdict(p); return `${dotHTML(p)}<span class="verdict v${x.v}">${x.word}</span>`; };

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
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

const windWord = k => k < 8 ? 'calm' : k < 20 ? 'light wind' : k < 30 ? 'breezy' : k < 40 ? 'windy' : 'very windy';
const airWord = rh => rh < 65 ? 'dry air' : rh < 80 ? 'fairly dry air' : rh < 90 ? 'humid' : 'very humid';
const gripWord = f => f == null ? null : f > 0.8 ? 'great' : f > 0.6 ? 'good' : f > 0.4 ? 'okay' : f > 0.2 ? 'greasy' : 'poor';
const rainWord = mm => mm < 0.5 ? 'a few drops of' : mm < 3 ? 'light' : mm < 10 ? 'moderate' : 'heavy';

function wxEmoji(s) {
  if (s.rainChance >= 0.6) return ['🌧️', 'rain likely'];
  if (s.codes.some(c => c >= 95)) return ['⛈️', 'thunder possible'];
  if (s.codes.some(c => (c >= 71 && c <= 77) || c === 85 || c === 86)) return ['🌨️', 'snow'];
  if (s.rainChance >= 0.3) return ['🌦️', 'showers possible'];
  if (s.codes.filter(c => c === 45 || c === 48).length > s.codes.length / 2) return ['🌫️', 'fog'];
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

function rockText(s) {
  if (s.rockState === 'wet') return s.fragile
    ? ['🚫', "<b>wet — don't climb.</b> Wet gritstone is weaker and holds can snap."]
    : ['🚫', '<b>wet</b> — slippery, not worth it.'];
  if (s.rockState === 'soaked') return s.fragile
    ? ['⚠️', '<b>damp inside</b> after lots of rain — go gentle on flakes and soft holds.']
    : ['⚠️', '<b>seepage likely</b> after lots of rain — some lines may be wet.'];
  return ['✅', '<b>fine to climb.</b>'];
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
      <div class="row">${em(e, lab)} ${Math.round(avg(s => s.tmax))}° · ${em('☔', 'rain chance')} ${Math.round(avg(s => s.rainChance) * 10) * 10}%</div>
      <div class="row">${em('💨')} ${windWord(avg(s => s.wind))}</div>
      <div class="best">${top && top.sc >= 0.35
        ? `Best bet:<br><button data-pick="${top.r.crag.id}">${esc(top.r.crag.short)}</button>${why ? `<br><span class="dim">${esc(why)}</span>` : ''}`
        : '<span class="dim">Nowhere looks dry</span>'}</div>
      ${lt ? `<div class="light">${em('🌅', 'sunrise to sunset')} ${hm(lt.rise)}–${hm(lt.set)}<br>light ${hm(lt.dawn)}–${hm(lt.dusk)}</div>` : ''}
    </div>`;
  });
  $('overview').innerHTML = html + '</div>';
}

function pickWhy({ s }, ss) {
  const bits = [];
  const avgFace = ss.reduce((a, x) => a + x.faceWind, 0) / ss.length;
  if (s.wind >= 25 && s.faceWind < 0.75 * avgFace) bits.push('out of the wind');
  if (s.sunH >= 2) bits.push('sun on the rock');
  if ((s.grip ?? 0) > 0.8) bits.push('great grip');
  if (!bits.length && s.p >= 0.8) bits.push('dries fast');
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
    if (!s) return;
    const [e, lab] = wxEmoji(s);
    const open = ui.openDay === d;
    const grip = gripWord(s.grip);
    html += `<div class="dayrow${open ? ' open' : ''}">
      <button data-day="${d}" aria-expanded="${open}">
        <span class="dname">${dayName(d, k)}<small>${dateNum(d)}${isWeekend(d) ? ' · wknd' : ''}</small></span>
        <span class="line">${verdictHTML(s.p)}<br><span class="sub">${whenText(s)}${grip && s.rockState !== 'wet' ? ` · ${grip} grip` : ''}${c.weekday_closed && !isWeekend(d) ? ' · ⚠︎ range may be firing' : ''}</span></span>
        <span class="wxcol">${em(e, lab)} ${Math.round(s.tmax)}°<br><span class="sub">${s.wind >= 30 ? em('💨') + ' ' : ''}${Math.round(s.wind)} km/h</span></span>
      </button>
      ${open ? detail(run, s, d, k) : ''}
    </div>`;
  });
  html += '</div><p class="dim" style="font-size:12px">Tap a day for hour-by-hour detail. More than 3 days ahead, treat it as a rough guide.</p>';
  $('cragView').innerHTML = html;
}

function detail(run, s, d, k) {
  const c = run.crag;
  const [h0, h1] = SESSIONS[ui.session].hours;
  const lt = lightTimes(run, d);
  let bars = '', ticks = '';
  for (let hr = STRIP[0]; hr < STRIP[1]; hr++) {
    const h = s.hours.find(x => x.hour === hr);
    const p = h ? run.pDry[h.i] : null;
    const t = h ? run.t[h.i] : null;
    const night = lt && t != null && (t + 3600 <= lt.dawn || t >= lt.dusk);
    const cls = [p != null ? 'h' + verdict(p).v : '', hr < h0 || hr >= h1 ? 'out' : '', night ? 'night' : ''].join(' ');
    bars += `<span class="${cls}" title="${ampm(hr)}: ${p == null ? 'no data' : verdict(p).word}${night ? ' (dark)' : ''}"></span>`;
    ticks += `<span>${hr % 3 === 0 ? ampm(hr) : ''}</span>`;
  }

  const facts = [];
  const rc = Math.round(s.rainChance * 10) * 10;
  facts.push(['☔', s.rainChance < 0.1 ? 'Rain: <b>unlikely</b> while you climb.'
    : `Rain: <b>${rc}% chance</b> while you climb${s.rainAmt >= 0.2 ? `, ${rainWord(s.rainAmt).replace(' of', '')} (~${s.rainAmt.toFixed(1)} mm)` : ''}.`]);
  if (s.rain48 >= 0.3) {
    const lp = s.lastRain ? localParts(s.lastRain) : null;
    const when = lp ? `, last at ${ampm(lp.hour)}${lp.date !== d ? ' ' + fmt(lp.date, { weekday: 'short' }) : ''}` : '';
    facts.push(['🌧️', `Before: ${rainWord(s.rain48)} rain in the 2 days before (${s.rain48.toFixed(1)} mm${when}).`]);
  } else facts.push(['🌤️', 'Before: <b>dry</b> for the 2 days before.']);
  facts.push(['☀️', s.sunH
    ? `Sun on the rock: about <b>${s.sunH} hour${s.sunH > 1 ? 's' : ''}</b> from ${clock(s.sunFirst)}, helps drying.`
    : `Sun on the rock: <b>little or none</b>${angDiff(c.aspect_deg, 180) > 120 ? ' — this face rarely gets direct sun' : ''}.`]);
  const o = oct(s.dir), rel = angDiff(s.dir, c.aspect_deg);
  facts.push(['💨', `Wind: <b>${windWord(s.wind)}</b>, ${Math.round(s.wind)} km/h from the ${COMPASS[o]} ${ARROW[o]}` +
    `${s.gust >= 45 ? `, gusts ${Math.round(s.gust)}` : ''}` +
    `${s.wind >= 20 && rel < 60 ? ' — blowing straight onto the face' : s.wind >= 20 && rel > 120 ? ' — crag is sheltered from it' : ''}` +
    `${s.wind >= 15 ? '. Helps drying.' : '.'}`]);
  facts.push(['💧', `Air: <b>${airWord(s.rh)}</b> (${Math.round(s.rh)}% humidity)` +
    `${s.rh >= 92 ? ' — slow drying, rock feels greasy' : s.rh >= 82 ? ' — slows drying' : s.rh < 70 ? ' — good for drying and grip' : ''}.`]);
  facts.push(['🌡️', `Temperature: ${Math.round(s.tmin)}–${Math.round(s.tmax)}°C${s.tmax < 4 ? ', cold fingers' : s.tmax > 20 ? ', warm for friction' : ''}.`]);
  if (s.sweat) facts.push(['💦', 'Rock may “sweat”: damp air condensing on cold rock, usually early on.']);
  if (s.grip != null && s.rockState !== 'wet') facts.push(['🧗', `Grip: <b>${gripWord(s.grip)}</b> on dry rock.`]);
  const rd = rockText(s);
  facts.push([rd[0], `Rock: ${rd[1]}`]);
  if (s.tide) {
    const ts = type => s.tide.ext.filter(x => x.type === type).map(x => '~' + ampm(localParts(x.t).hour)).join(' & ') || '–';
    const w = s.tide.wave;
    facts.push(['🌊', `Tide: low ${ts('low')}, high ${ts('high')}. Waves <b>${w < 0.8 ? 'small' : w < 1.5 ? 'moderate' : w < 2.5 ? 'big' : 'very big'}</b> (${w.toFixed(1)} m)` +
      `${c.tide_note ? `. ${esc(c.tide_note)}` : ''}.`]);
  }
  if (lt) facts.push(['🌅', `Light: ${clock(lt.dawn)} to ${clock(lt.dusk)} (sunrise ${clock(lt.rise)}, sunset ${clock(lt.set)}).`]);

  return `<div class="detail">
    <div class="strip"><div class="bars">${bars}</div><div class="ticks">${ticks}</div>
    <div class="cap">Each bar is one hour: green dry · amber maybe · red wet. Faded = outside your session, faint = dark.</div></div>
    <ul class="facts">${facts.map(([e, t]) => `<li>${em(e)}<span>${t}</span></li>`).join('')}</ul>
    ${k >= 3 ? '<p class="dim" style="font-size:12px;margin:8px 0 0">This far ahead the forecast can still change a lot.</p>' : ''}
  </div>`;
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
  const meaning = ['nearly every forecast keeps it wet', 'most forecasts have it wet',
    'forecasts disagree, could go either way', 'most forecasts have it dry', 'nearly every forecast has it dry'];
  $('howto').innerHTML = `
    <p>Each day says how likely the rock is to be dry for most of the hours you picked under <b>When</b>.
    A fuller circle means drier rock:</p>
    <ul class="key">${[...VERDICTS].reverse().map(x => `<li><span class="dot v${x.v}"></span> <b class="v${x.v}">${x.word}</b> — ${meaning[x.v]}</li>`).join('')}</ul>
    <p>Tap a day for an hour-by-hour bar and the reasons behind it:</p>
    <ul class="key">
      <li>☔ chance of rain while you climb</li>
      <li>☀️ hours of sun actually on the rock face, not just in the sky</li>
      <li>💨 wind dries rock quickly; the arrow shows which way it blows</li>
      <li>💧 humidity: muggy air dries rock slowly and feels greasy</li>
      <li>🧗 grip: best when cool, dry and breezy; worst when warm and muggy</li>
      <li>✅ ⚠️ 🚫 is the rock OK to climb? Wet gritstone is weaker and holds can break</li>
      <li>🌊 tide times and wave size for sea cliffs</li>
      <li>🌅 sunrise/sunset; “light” is when you can climb without a head torch</li>
    </ul>
    <p><b>Best bet</b> picks the crag most likely to be dry with good grip, and avoids faces
    taking the full force of a strong wind.</p>`;
}

function renderStatus(msg) {
  if (msg) { $('status').textContent = msg; return; }
  const t = new Date(cache[ui.region].fetched).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('status').innerHTML = `Updated ${t} · <button class="linkish" id="refresh">refresh</button>`;
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
  const pick = e.target.closest('[data-pick]');
  if (pick) { choose(pick.dataset.pick, true); return; }
  const day = e.target.closest('button[data-day]');
  if (day) { ui.openDay = ui.openDay === day.dataset.day ? null : day.dataset.day; renderCrag(cache[ui.region]); }
});

async function load(force = false) {
  const region = ui.region;
  const c = cache[region];
  if (c && !force && Date.now() - c.fetched < 30 * 60e3) { renderStatus(); renderData(); return; }
  renderStatus('Loading forecast…');
  try {
    const crags = CRAGS.filter(x => x.region === region);
    const wx = await fetchRegion(REGIONS[region], crags);
    const runs = runRegion(REGIONS[region], crags, wx);
    cache[region] = { runs, days: dayList(runs[0]), fetched: wx.fetched };
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
