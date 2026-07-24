// ART Tracker frontend — talks to /api/query which proxies to Turso.
// All aggregation happens in SQL (Turso), not JavaScript.

// ---------- helpers ----------
async function query(sql, args = []) {
  const r = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, args }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + await r.text());
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j;
}
function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function round1(n) { return typeof n === 'number' ? Math.round(n * 10) / 10 : n; }
function rangeStart(range) {
  // Returns a YYYY-MM-DD string for the start of the chosen range.
  const now = new Date();
  if (range === 'all')     return '1970-01-01';
  if (range === 'week')    { const d = new Date(now); d.setDate(now.getDate() - now.getDay()); return d.toISOString().slice(0,10); }
  if (range === 'month')   return now.toISOString().slice(0,7) + '-01';
  if (range === 'quarter') { const qm = Math.floor(now.getMonth()/3)*3; return now.getFullYear() + '-' + String(qm+1).padStart(2,'0') + '-01'; }
  return '1970-01-01';
}
function rangeLabel(range) {
  return { week:'this week', month:'this month', quarter:'this quarter', all:'all time' }[range] || range;
}

// ---------- tab management ----------
let CURRENT_TAB = 'rows';
function showTab(name) {
  CURRENT_TAB = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.getElementById('tab-rows').hidden     = (name !== 'rows');
  document.getElementById('tab-task').hidden     = (name !== 'task');
  document.getElementById('tab-reviewer').hidden = (name !== 'reviewer');
  load();
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- table renderer ----------
function renderTable(tblId, cols, rows) {
  const tbl = document.getElementById(tblId);
  const head = '<thead><tr>' + cols.map(c =>
    `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`
  ).join('') + '</tr></thead>';
  if (!rows.length) {
    tbl.innerHTML = head + `<tbody><tr><td colspan="${cols.length}" class="loading">No data in this range.</td></tr></tbody>`;
    return;
  }
  const body = '<tbody>' + rows.map(r =>
    '<tr>' + cols.map(c => {
      let v = r[c.key];
      if (c.num && typeof v === 'number') v = round1(v);
      return `<td class="${c.num ? 'num' : ''}">${esc(v)}</td>`;
    }).join('') + '</tr>'
  ).join('') + '</tbody>';
  tbl.innerHTML = head + body;
}

// ---------- charts ----------
const CHARTS = {};
function drawBar(canvasId, labels, data, dataLabel, horizontal) {
  if (CHARTS[canvasId]) { CHARTS[canvasId].destroy(); }
  CHARTS[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'bar',
    data: { labels, datasets: [{ label: dataLabel, data, backgroundColor: '#2563eb', borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
      plugins: { legend: { display: false } },
      scales: { x: { grid:{display:false}, ticks:{autoSkip:false,maxRotation:45} }, y: { grid:{color:'#eef0f4'}, beginAtZero:true } },
    },
  });
}

// ---------- loaders ----------
async function load() {
  const range = document.getElementById('fRange').value;
  const start = rangeStart(range);
  const q = document.getElementById('q').value.trim();
  const meta = document.getElementById('meta');
  meta.textContent = 'Loading ' + rangeLabel(range) + '…';

  const t0 = performance.now();
  try {
    if (CURRENT_TAB === 'rows')     await loadRows(start, q);
    if (CURRENT_TAB === 'task')     await loadTask(start, q);
    if (CURRENT_TAB === 'reviewer') await loadReviewer(start, q);
    const dt = Math.round(performance.now() - t0);
    meta.textContent = `Range: ${rangeLabel(range)} · ${dt} ms`;
  } catch (e) {
    meta.innerHTML = `<span style="color:#b91c1c">ERR: ${esc(e.message)}</span>`;
  }
}

async function loadRows(start, q) {
  const like = q ? '%' + q + '%' : '';
  const sql = `
    SELECT match_id, assignment_date, code, reviewer_name, team, task, half, side
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR match_id LIKE ?2 OR task LIKE ?2 OR code LIKE ?2)
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 500
  `;
  const { rows } = await query(sql, [start, like]);
  document.getElementById('count').textContent = rows.length + ' rows (max 500)';
  renderTable('tblRows', [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
  ], rows);
}

async function loadTask(start, q) {
  const like = q ? '%' + q + '%' : '';
  // Per-task aggregation. avg_actual joins data_logs on (matchid, code) — only
  // rows w/ actual logs contribute to averages; rows without logs still count
  // toward matches_listed / distinct_matches.
  const sql = `
    SELECT
      a.task AS task,
      COUNT(*) AS matches_listed,
      COUNT(DISTINCT a.match_id) AS distinct_matches,
      COUNT(DISTINCT a.code) AS reviewers,
      AVG(dl.actual_time_taken) AS avg_actual
    FROM assignments a
    LEFT JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date >= ?1
      AND (?2 = '' OR a.reviewer_name LIKE ?2 OR a.task LIKE ?2 OR a.code LIKE ?2)
      AND a.task IS NOT NULL AND a.task <> ''
    GROUP BY a.task
    ORDER BY matches_listed DESC
  `;
  const { rows } = await query(sql, [start, like]);
  document.getElementById('count').textContent = rows.length + ' tasks';

  const top = rows.slice(0, 15);
  drawBar('chartTaskCount', top.map(r => r.task), top.map(r => r.matches_listed), 'Assignments');
  drawBar('chartTaskAvg',   top.map(r => r.task), top.map(r => round1(r.avg_actual || 0)), 'Avg actual (min)');

  renderTable('tblTask', [
    { key:'task',              label:'Task' },
    { key:'matches_listed',    label:'Assignments',       num:true },
    { key:'distinct_matches',  label:'Distinct matches',  num:true },
    { key:'reviewers',         label:'Reviewers',         num:true },
    { key:'avg_actual',        label:'Avg actual (min)',  num:true },
  ], rows);
}

async function loadReviewer(start, q) {
  const like = q ? '%' + q + '%' : '';
  const sql = `
    SELECT
      a.code AS code,
      a.reviewer_name AS reviewer_name,
      a.team AS team,
      COUNT(*) AS matches_listed,
      COUNT(DISTINCT a.match_id) AS distinct_matches,
      AVG(dl.actual_time_taken) AS avg_actual
    FROM assignments a
    LEFT JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date >= ?1
      AND (?2 = '' OR a.reviewer_name LIKE ?2 OR a.team LIKE ?2 OR a.code LIKE ?2)
    GROUP BY a.code, a.reviewer_name, a.team
    ORDER BY matches_listed DESC
    LIMIT 200
  `;
  const { rows } = await query(sql, [start, like]);
  document.getElementById('count').textContent = rows.length + ' reviewers';

  const top = rows.slice(0, 20);
  drawBar('chartReviewer',
    top.map(r => (r.reviewer_name || '?') + ' (' + r.code + ')'),
    top.map(r => r.matches_listed),
    'Assignments',
    /*horizontal*/ true,
  );

  renderTable('tblReviewer', [
    { key:'code',              label:'Code' },
    { key:'reviewer_name',     label:'Reviewer' },
    { key:'team',              label:'Team' },
    { key:'matches_listed',    label:'Assignments',       num:true },
    { key:'distinct_matches',  label:'Distinct matches',  num:true },
    { key:'avg_actual',        label:'Avg actual (min)',  num:true },
  ], rows);
}

// ---------- wire toolbar ----------
document.getElementById('reload').onclick = load;
document.getElementById('fRange').onchange = load;
document.getElementById('q').oninput = () => {
  clearTimeout(window._t);
  window._t = setTimeout(load, 300);
};
load();
