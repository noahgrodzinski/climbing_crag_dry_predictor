import { CRAGS, AREAS } from './crags.js';
import { fetchWeather, runAll, dayList, summarise, localParts, pad } from './forecast.js';
import { frictionLabel } from './model.js';

const SESSIONS = {
  day: [10, 18],
  morning: [7, 11],
  evening: [16, 20],
  long: [7, 19],
};
const STRIP = [6, 21];          // hours shown in the detail strip
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = d => COMPASS[Math.round(d / 45) % 8];

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('isitdry.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('isitdry.' + k, JSON.stringify(v)); } catch {} },
};

const ui = {
  session: store.get('session', 'day'),
  area: store.get('area', 'all'),
  sortDay: null,
  open: new Set(),
};

let runs = null, days = [], fetchedAt = null;
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cls(p) { return p == null ? 'na' : p >= 0.65 ? 'ok' : p >= 0.35 ? 'mid' : 'bad'; }
const dow = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }).toLowerCase();
const isWeekend = d => [0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay());
const dateLabel = d => `${dow(d)} ${d.slice(8)}`;

function renderCmd() {
  const flag = (name, opts, cur) =>
    `<span class="flag">--${name}=${opts.map(o =>
      `<button data-flag="${name}" data-val="${o}" aria-pressed="${o === cur}">${o}</button>`).join('|')}</span>`;
  const [a, b] = SESSIONS[ui.session];
  $('cmd').innerHTML = `<span class="prompt">$</span> isitdry ` +
    flag('session', Object.keys(SESSIONS), ui.session) +
    `<span class="flag dim">[${pad(a)}–${pad(b)}h]</span> ` +
    flag('area', ['all', ...Object.keys(AREAS)], ui.area) +
    (ui.sortDay ? `<span class="flag">--sort=<button data-flag="sort" data-val="" aria-pressed="true">${dateLabel(ui.sortDay)}</button></span>` : '');
}

function renderGrid() {
  if (!runs) return;
  const sess = SESSIONS[ui.session];
  const rows = runs
    .map(r => ({ r, sums: days.map(d => summarise(r, d, sess)) }))
    .filter(({ r }) => ui.area === 'all' || r.crag.area === ui.area);

  if (ui.sortDay) {
    const k = days.indexOf(ui.sortDay);
    rows.sort((a, b) => (b.sums[k]?.p ?? -1) - (a.sums[k]?.p ?? -1));
  }

  let html = '<thead><tr><th>crag</th><th class="asp">asp</th>' +
    days.map(d => `<th class="day${isWeekend(d) ? ' we' : ''}${d === ui.sortDay ? ' sorted' : ''}" data-day="${d}" title="sort by this day">${dow(d).slice(0, 2)}<br>${d.slice(8)}</th>`).join('') +
    '</tr></thead><tbody>';

  let lastArea = null;
  for (const { r, sums } of rows) {
    const c = r.crag;
    if (!ui.sortDay && c.area !== lastArea) {
      html += `<tr class="group"><td colspan="${days.length + 2}"># ${esc(AREAS[c.area])}</td></tr>`;
      lastArea = c.area;
    }
    const open = ui.open.has(c.id);
    html += `<tr class="crag${open ? ' open' : ''}" data-id="${c.id}"><td class="name" title="${esc(c.crag)} ${esc(c.sector || '')}">${esc(c.short)}</td>` +
      `<td class="asp">${compass(c.aspect_deg)}</td>` +
      sums.map((s, k) => {
        const p = s?.p;
        const txt = p == null ? '··' : Math.round(p * 100);
        return `<td class="cell${isWeekend(days[k]) ? ' we' : ''}"><span class="c-${cls(p)}">${txt}</span></td>`;
      }).join('') + '</tr>';
    if (open) html += `<tr class="detail"><td colspan="${days.length + 2}"><div class="detwrap">${detail(r, sums)}</div></td></tr>`;
  }
  $('grid').innerHTML = html + '</tbody>';
}

function strip(r, s, sess) {
  const nowU = Date.now() / 1000;
  let out = '';
  for (let hr = STRIP[0]; hr < STRIP[1]; hr++) {
    const h = s.hours.find(x => x.hour === hr);
    if (!h) { out += '<span class="h"> </span>'; continue; }
    const p = r.pDry[h.i];
    const st = p == null ? null : p >= 0.8 ? 0 : p >= 0.5 ? 1 : 2;
    const ch = p == null ? '·' : p >= 0.8 ? '█' : p >= 0.5 ? '▓' : p >= 0.2 ? '▒' : '░';
    const inSess = hr >= sess[0] && hr < sess[1];
    const isNow = r.t[h.i] <= nowU && nowU < r.t[h.i] + 3600;
    const tip = `${pad(hr)}:00 P(dry) ${p == null ? '–' : Math.round(p * 100) + '%'} · ${r.det[h.i].x.T.toFixed(0)}°C · rain ${r.det[h.i].x.P.toFixed(1)}mm`;
    out += `<span class="h s${st ?? ''}${inSess ? '' : ' out'}${isNow ? ' now' : ''}" title="${tip}">${ch}</span>`;
  }
  return out;
}

function why(s) {
  const bits = [];
  if (s.rain48 >= 0.2) {
    const last = s.lastRain ? localParts(s.lastRain) : null;
    bits.push(`${s.rain48.toFixed(1)}mm prev 48h` + (last ? ` (last ${pad(last.hour)}:00 ${dow(last.date)})` : ''));
  } else bits.push('dry prev 48h');
  if (s.rainIn >= 0.2) bits.push(`${s.rainIn.toFixed(1)}mm in session (main fcst)`);
  bits.push(s.sunH ? `${s.sunH}h sun on face` : 'no sun on face');
  bits.push(`wind ${Math.round(s.wind)}km/h`, `rh ${Math.round(s.rh)}%`,
    `${Math.round(s.tmin)}–${Math.round(s.tmax)}°C`, `dp ${Math.round(s.td)}°C`);
  if (s.fill > 0.6) bits.push('pores saturated');
  if (s.sweat) bits.push('condensation risk');
  return bits.join(' · ') + ` → ${s.window}`;
}

function detail(r, sums) {
  const c = r.crag;
  const sess = SESSIONS[ui.session];
  const axis = Array.from({ length: STRIP[1] - STRIP[0] }, (_, k) =>
    (STRIP[0] + k) % 3 === 0 ? String(STRIP[0] + k).padEnd(3, ' ') : '').join('').padEnd(STRIP[1] - STRIP[0]);
  let h = `<div class="det-head"><b>${esc(c.crag)}${c.sector ? ' / ' + esc(c.sector) : ''}</b> ` +
    `<span class="dim">${compass(c.aspect_deg)} ${c.aspect_deg}° · ${c.alt}m · ${esc(c.rock)}` +
    `${c.other_faces ? ' · also ' + esc(c.other_faces) : ''}` +
    `${c.ukc_url ? ` · <a href="${esc(c.ukc_url)}" target="_blank" rel="noopener">ukc↗</a>` : ''}</span><br>` +
    `<span class="dim">${esc(c.drying_notes || '')}</span>` +
    (c.classics?.length ? `<br><span class="dim">classics:</span> ${esc(c.classics.join(', '))}` : '') +
    (c.access ? `<br><span class="bad">access:</span> ${esc(c.access)}` : '') + `</div>`;
  h += `<div class="dim"><span style="display:inline-block;width:10ch"></span><span style="display:inline-block;width:5ch"></span><span class="axis">${axis.replace(/ /g, '&nbsp;')}</span></div>`;
  days.forEach((d, k) => {
    const s = sums[k];
    if (!s) return;
    const fr = s.fric == null ? '<span class="dim">friction –</span>'
      : `friction <span class="${s.fric > 0.6 ? 'ok' : s.fric > 0.4 ? 'mid' : 'bad'}">${frictionLabel(s.fric)}</span>`;
    const rock = ['<span class="ok">rock ok</span>', '<span class="mid">rock saturated, go gentle</span>',
      '<span class="bad">rock wet, don\'t climb</span>'][s.dmg];
    h += `<div class="det-day"><div class="line1">` +
      `<span><span style="display:inline-block;width:10ch">${dateLabel(d)}</span>` +
      `<span class="c-${cls(s.p)}" style="display:inline-block;width:4ch;text-align:right">${s.p == null ? '–' : Math.round(s.p * 100) + '%'}</span> ` +
      `<span class="strip">${strip(r, s, sess)}</span></span>` +
      `<span>${fr}</span><span>${rock}</span></div>` +
      `<div class="why">${esc(why(s))}</div></div>`;
  });
  return h;
}

function renderStatus(msg) {
  if (msg) { $('status').textContent = msg; return; }
  const t = new Date(fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const n = runs[0].mem.length;
  $('status').innerHTML = `updated ${t} · ${n > 1 ? n + ' ensemble members' : 'deterministic only (ensemble unavailable)'} · ` +
    `<button class="linkish" id="refresh">refresh</button> · click a crag for hourly detail`;
  $('refresh').onclick = load;
}

$('legend').textContent =
  'cell = P(dry for ≥75% of session) in %   ≥65 dry · 35–64 maybe · <35 wet   bold = weekend\n' +
  'strip █ ≥80% ▓ ≥50% ▒ ≥20% ░ <20% dry, per hour; faded = outside session; underline = now';

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-flag]');
  if (b) {
    const { flag, val } = b.dataset;
    if (flag === 'session') { ui.session = val; store.set('session', val); }
    if (flag === 'area') { ui.area = val; store.set('area', val); }
    if (flag === 'sort') ui.sortDay = null;
    renderCmd(); renderGrid(); return;
  }
  const th = e.target.closest('th.day');
  if (th) { ui.sortDay = ui.sortDay === th.dataset.day ? null : th.dataset.day; renderCmd(); renderGrid(); return; }
  const tr = e.target.closest('tr.crag');
  if (tr && !e.target.closest('a')) {
    const id = tr.dataset.id;
    ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id);
    renderGrid();
  }
});

async function load() {
  renderStatus('fetching open-meteo…');
  try {
    const wx = await fetchWeather(CRAGS);
    renderStatus('running model…');
    await new Promise(r => setTimeout(r));
    runs = runAll(CRAGS, wx);
    days = dayList(runs[0]);
    fetchedAt = wx.fetched;
    renderStatus();
    renderGrid();
  } catch (err) {
    console.error(err);
    renderStatus(`error: ${err.message}`);
  }
}

renderCmd();
load();
