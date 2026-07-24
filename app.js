// ART Tracker frontend — dark UI + task drill-down + granularity toggle.
// All aggregation runs as SQL in Turso; JS just renders.

// ============================================================
// Chart.js global defaults — read from CSS vars so dark/light works
// ============================================================
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function applyChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = css('--text-muted');
  Chart.defaults.borderColor = css('--border');
  Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
  Chart.defaults.font.size = 12;
}
applyChartDefaults();

// ============================================================
// HTTP + helpers
// ============================================================
async function query(sql, args = []) {
  const r = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, args }),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' — ' + await r.text());
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j;
}
function esc(v) {
  if (v == null) return '';
  return String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function round1(n) { return typeof n === 'number' ? Math.round(n * 10) / 10 : n; }
function fmt(n) {
  if (n == null || n === '') return '—';
  if (typeof n !== 'number') return String(n);
  if (n >= 1000) return n.toLocaleString();
  return round1(n);
}

// Compute {start, end} YYYY-MM-DD from a preset. Trailing-window presets
// (last 30d, 3m, 6m, 12m) show trend leading up to today — MoM/QoQ view.
function presetRange(preset) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0,10);
  const end = iso(now);
  const d = new Date(now);
  if (preset === '30d') { d.setDate(now.getDate() - 30); return { start: iso(d), end }; }
  if (preset === '3m')  { d.setMonth(now.getMonth() - 3); return { start: iso(d), end }; }
  if (preset === '6m')  { d.setMonth(now.getMonth() - 6); return { start: iso(d), end }; }
  if (preset === '12m') { d.setMonth(now.getMonth() - 12); return { start: iso(d), end }; }
  if (preset === 'ytd') return { start: now.getFullYear() + '-01-01', end };
  if (preset === 'all') return { start: '1970-01-01', end: '2999-12-31' };
  return { start: '1970-01-01', end };
}
function rangeLabel(range, start, end) {
  const presets = { '30d':'Last 30 days','3m':'Last 3 months','6m':'Last 6 months','12m':'Last 12 months','ytd':'Year to date','all':'All time' };
  if (presets[range]) return presets[range];
  return start + ' → ' + end;
}
// Read current range from state; if custom, use its dates; else compute from preset
function currentRange() {
  const custom = STATE.customStart || STATE.customEnd;
  if (custom) return { start: STATE.customStart || '1970-01-01', end: STATE.customEnd || '2999-12-31' };
  return presetRange(STATE.range);
}

// SQL expression for granularity bucket key.
// Week uses %U (Sunday-start) instead of %W (Monday-start).
function granExpr(col, gran) {
  if (gran === 'day')     return `substr(${col},1,10)`;
  if (gran === 'week')    {
    // Return the Sunday date of that week — e.g. '2026-07-19'.
    // This gives a real date on the axis instead of "2026-W29".
    return `date(${col}, 'weekday 0', '-7 days')`;
  }
  if (gran === 'month')   return `substr(${col},1,7)`;
  if (gran === 'quarter') return `substr(${col},1,4) || '-Q' || ((cast(substr(${col},6,2) AS INTEGER) - 1)/3 + 1)`;
  if (gran === 'year')    return `substr(${col},1,4)`;
  return `substr(${col},1,7)`;
}

// ============================================================
// State
// ============================================================
const STATE = {
  view: 'overview',
  range: '12m',        // default = last 12 months (MoM view)
  customStart: '',     // if user picks custom dates, presets are ignored
  customEnd: '',
  gran: 'month',       // overview time chart granularity
  taskGran: 'month',   // task-card chart granularity
  q: '',
  selectedTask: '',    // for reviewer view
};

// ============================================================
// Chart cache — destroy before re-creating
// ============================================================
const CHARTS = {};
function destroyChart(id) { if (CHARTS[id]) { CHARTS[id].destroy(); delete CHARTS[id]; } }
function palette() { return ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#f97316','#a855f7','#84cc16','#ef4444']; }

function bar(canvasId, labels, data, dataLabel, opts = {}) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  CHARTS[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{
      label: dataLabel, data,
      backgroundColor: opts.horizontal ? palette().slice(0, labels.length) : css('--accent'),
      borderRadius: 4, maxBarThickness: 40,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: { legend: { display: false }, tooltip: { intersect: false, mode: 'index' } },
      scales: {
        x: { grid: { display: false }, ticks: { autoSkip: true, maxRotation: 45 } },
        y: { grid: { color: css('--border') }, beginAtZero: true, ticks: { precision: 0 } },
      },
    },
  });
}
function line(canvasId, labels, datasets, opts = {}) {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const colors = palette();
  const ds = datasets.map((d, i) => ({
    label: d.label, data: d.data,
    borderColor: d.color || colors[i % colors.length],
    backgroundColor: (d.color || colors[i % colors.length]) + '33',
    borderWidth: 2, tension: 0.3, pointRadius: 3, fill: opts.fill || false,
  }));
  CHARTS[canvasId] = new Chart(ctx, {
    type: 'line', data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1, position: 'top', labels: { boxWidth: 10 } }, tooltip: { intersect: false, mode: 'index' } },
      scales: { x: { grid: { display: false } }, y: { grid: { color: css('--border') }, beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

// ============================================================
// Table renderer
// ============================================================
function renderTable(tblId, cols, rows) {
  const tbl = document.getElementById(tblId);
  if (!tbl) return;
  const head = '<thead><tr>' + cols.map(c => `<th class="${c.num?'num':''}">${esc(c.label)}</th>`).join('') + '</tr></thead>';
  if (!rows || !rows.length) {
    tbl.innerHTML = head + `<tbody><tr><td colspan="${cols.length}" class="empty">No data in this range.</td></tr></tbody>`;
    return;
  }
  const body = '<tbody>' + rows.map(r =>
    '<tr>' + cols.map(c => {
      let v = r[c.key];
      if (c.num && typeof v === 'number') v = fmt(v);
      if (c.render) v = c.render(r);
      return `<td class="${c.num?'num':''}">${c.raw ? v : esc(v == null ? '' : v)}</td>`;
    }).join('') + '</tr>'
  ).join('') + '</tbody>';
  tbl.innerHTML = head + body;
}

// ============================================================
// Views
// ============================================================
function setView(name) {
  STATE.view = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  document.getElementById('pageTitle').textContent = {
    overview: 'Overview', tasks: 'Analysis by task', reviewers: 'Analysis by reviewer', rows: 'Assignments',
  }[name];
  refresh();
}

async function refresh() {
  const R = currentRange();
  const label = rangeLabel(STATE.range, R.start, R.end);
  document.getElementById('pageSub').textContent = 'Loading ' + label + '…';
  const t0 = performance.now();
  try {
    if (STATE.view === 'overview')  await loadOverview(R);
    if (STATE.view === 'tasks')     await loadTasks(R);
    if (STATE.view === 'reviewers') await loadReviewers(R);
    if (STATE.view === 'rows')      await loadRows(R);
    const dt = Math.round(performance.now() - t0);
    document.getElementById('pageSub').textContent = `${label} · ${dt} ms`;
  } catch (e) {
    document.getElementById('pageSub').innerHTML = `<span class="error">ERR: ${esc(e.message)}</span>`;
    console.error(e);
  }
}

// --- Overview: KPI cards only ---
async function loadOverview(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;

  // Global KPI counts — assignments-only (no JOIN inflation)
  const kpi = (await query(`
    SELECT
      COUNT(*)                              AS assignments,
      COUNT(DISTINCT match_id)              AS distinct_matches,
      COUNT(DISTINCT code)                  AS reviewers,
      COUNT(DISTINCT task)                  AS tasks
    FROM assignments
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR task LIKE ?3 OR code LIKE ?3 OR team LIKE ?3)
  `, [start, end, like])).rows[0] || {};

  // Overall avg review time = avg across all data_logs matching assignments
  // in range. One row per (matchid, code) log — no over-count.
  const overall = (await query(`
    SELECT AVG(dl.actual_time_taken) AS avg_actual, COUNT(dl.matchid) AS log_rows
    FROM data_logs dl
    WHERE EXISTS (
      SELECT 1 FROM assignments a
      WHERE a.match_id = dl.matchid AND a.code = dl.code
        AND a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3 OR a.team LIKE ?3)
    )
  `, [start, end, like])).rows[0] || {};

  // Fastest / slowest task by avg (need >= 5 samples to avoid outliers)
  const perTask = (await query(`
    SELECT task, avg_actual, samples FROM (
      SELECT a.task AS task,
             AVG(dl.actual_time_taken) AS avg_actual,
             COUNT(dl.matchid) AS samples
      FROM assignments a
      JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3 OR a.team LIKE ?3)
        AND a.task IS NOT NULL AND a.task <> ''
      GROUP BY a.task
      HAVING samples >= 5
    )
    ORDER BY avg_actual ASC
  `, [start, end, like])).rows;
  const fastest = perTask[0];
  const slowest = perTask[perTask.length - 1];

  const cards = [
    { label: 'Assignments',       value: fmt(kpi.assignments),       sub: 'total rows' },
    { label: 'Distinct matches',  value: fmt(kpi.distinct_matches),  sub: 'unique games' },
    { label: 'Reviewers',         value: fmt(kpi.reviewers),         sub: 'active in range' },
    { label: 'Tasks',             value: fmt(kpi.tasks),             sub: 'assigned in range' },
    { label: 'Avg review time',   value: overall.avg_actual != null ? fmt(overall.avg_actual) + ' min' : '—',
      sub: fmt(overall.log_rows) + ' log rows' },
    { label: 'Fastest task',      value: fastest ? fastest.task : '—',
      sub: fastest ? fmt(fastest.avg_actual) + ' min avg · ' + fmt(fastest.samples) + ' logs' : '—' },
    { label: 'Slowest task',      value: slowest && slowest !== fastest ? slowest.task : '—',
      sub: slowest && slowest !== fastest ? fmt(slowest.avg_actual) + ' min avg · ' + fmt(slowest.samples) + ' logs' : '—' },
  ];
  document.getElementById('kpis').innerHTML = cards.map(c => `
    <div class="kpi">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>
  `).join('');
}

// --- Tasks: two summary charts + 2-col cards, each expandable ---
async function loadTasks(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;

  // Query 1 — pure assignment counts + top month per task, one row per task.
  // Uses window function to rank months by count within each task.
  const summary = (await query(`
    WITH filtered AS (
      SELECT match_id, code, task, substr(assignment_date, 1, 7) AS ym
      FROM assignments
      WHERE assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR reviewer_name LIKE ?3 OR task LIKE ?3 OR code LIKE ?3)
        AND task IS NOT NULL AND task <> ''
    ),
    counts AS (
      SELECT task, COUNT(*) AS assignments, COUNT(DISTINCT match_id) AS distinct_matches
      FROM filtered GROUP BY task
    ),
    ranked_months AS (
      SELECT task, ym, COUNT(*) AS n,
        ROW_NUMBER() OVER (PARTITION BY task ORDER BY COUNT(*) DESC) AS rn
      FROM filtered GROUP BY task, ym
    ),
    top_month AS (SELECT task, ym FROM ranked_months WHERE rn = 1)
    SELECT c.task, c.assignments, c.distinct_matches, t.ym AS top_month
    FROM counts c LEFT JOIN top_month t ON t.task = c.task
    ORDER BY c.assignments DESC
  `, [start, end, like])).rows;

  // Query 2 — avg review time per task from data_logs, WITHOUT joining
  // multiplies. One row per (matchid, code) log; average grouped by task
  // via subquery lookup.
  const avgRows = (await query(`
    SELECT a.task AS task, AVG(dl.actual_time_taken) AS avg_actual
    FROM assignments a
    JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
      AND a.task IS NOT NULL AND a.task <> ''
    GROUP BY a.task
  `, [start, end, like])).rows;
  const avgByTask = {};
  avgRows.forEach(r => { avgByTask[r.task] = r.avg_actual; });

  // Merge avg into summary
  summary.forEach(t => { t.avg_actual = avgByTask[t.task] ?? null; });

  // Top charts
  bar('chartTaskCount', summary.map(t => t.task), summary.map(t => t.assignments), 'Total assignments');
  const withAvg = summary.filter(t => t.avg_actual != null);
  bar('chartTaskAvg', withAvg.map(t => t.task), withAvg.map(t => round1(t.avg_actual)), 'Avg review time (min)');

  const grid = document.getElementById('taskGrid');
  if (!summary.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No tasks in this range.</div>';
    return;
  }
  grid.innerHTML = summary.map(t => `
    <div class="task-card" data-task="${esc(t.task)}">
      <div class="task-card-head">
        <div class="task-card-name">${esc(t.task)}</div>
        <button class="task-card-expand" data-action="expand">+</button>
      </div>
      <div class="task-card-stats">
        <div class="task-card-stat">
          <div class="task-card-stat-label">Assignments</div>
          <div class="task-card-stat-value">${fmt(t.assignments)}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Distinct matches</div>
          <div class="task-card-stat-value">${fmt(t.distinct_matches)}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Avg time (min)</div>
          <div class="task-card-stat-value">${t.avg_actual != null ? fmt(t.avg_actual) : '—'}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Top month</div>
          <div class="task-card-stat-value">${esc(t.top_month || '—')}</div>
        </div>
      </div>
      <div class="task-card-detail">
        <div class="chart-wrap short" style="margin-top:8px"><canvas id="fullTaskChart_${esc(t.task).replace(/\W/g,'_')}"></canvas></div>
      </div>
    </div>
  `).join('');

  // Per-task trend (single query, split by task)
  const gexpr = granExpr('a.assignment_date', STATE.taskGran);
  const trend = (await query(`
    SELECT a.task AS task, ${gexpr} AS bucket, COUNT(*) AS n
    FROM assignments a
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
      AND a.task IS NOT NULL AND a.task <> ''
    GROUP BY a.task, bucket
    ORDER BY a.task, bucket
  `, [start, end, like])).rows;

  const bucketsSet = new Set();
  trend.forEach(r => bucketsSet.add(r.bucket));
  const buckets = Array.from(bucketsSet).sort();
  const byTaskData = {};
  trend.forEach(r => {
    if (!byTaskData[r.task]) byTaskData[r.task] = {};
    byTaskData[r.task][r.bucket] = r.n;
  });
  summary.forEach(t => {
    const safe = t.task.replace(/\W/g, '_');
    const dataArr = buckets.map(b => byTaskData[t.task]?.[b] || 0);
    line('fullTaskChart_' + safe, buckets, [{ label: t.task, data: dataArr, color: css('--accent') }], { fill: true });
  });

  // Expand button wiring
  grid.querySelectorAll('.task-card-expand').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const card = btn.closest('.task-card');
      const open = card.classList.toggle('expanded');
      btn.textContent = open ? '−' : '+';
    };
  });
  grid.querySelectorAll('.task-card').forEach(card => {
    card.onclick = () => card.querySelector('.task-card-expand').click();
  });
}

// --- Reviewers view — scoped to a single task ---
async function loadReviewers(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;

  // Populate task dropdown if empty
  const sel = document.getElementById('revTaskSel');
  if (sel.options.length <= 1) {
    const tasks = (await query(`
      SELECT DISTINCT task FROM assignments
      WHERE task IS NOT NULL AND task <> '' ORDER BY task
    `)).rows.map(r => r.task);
    sel.innerHTML = '<option value="">— All tasks —</option>' +
      tasks.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    if (STATE.selectedTask) sel.value = STATE.selectedTask;
  }
  const task = sel.value;
  STATE.selectedTask = task;

  const taskFilter = task ? 'AND a.task = ?4' : '';
  const args = task ? [start, end, like, task] : [start, end, like];

  // Two-step: pure counts from assignments, then avg time from data_logs.
  // Avoids row-multiplication from the JOIN.
  const counts = (await query(`
    SELECT
      code, reviewer_name, team,
      COUNT(*) AS matches_listed,
      COUNT(DISTINCT match_id) AS distinct_matches
    FROM assignments a
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.team LIKE ?3 OR a.code LIKE ?3)
      ${taskFilter}
    GROUP BY code, reviewer_name, team
  `, args)).rows;

  const stats = (await query(`
    SELECT a.code AS code,
           AVG(dl.actual_time_taken) AS avg_actual,
           MIN(dl.actual_time_taken) AS min_actual,
           MAX(dl.actual_time_taken) AS max_actual
    FROM assignments a
    JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.team LIKE ?3 OR a.code LIKE ?3)
      ${taskFilter}
    GROUP BY a.code
  `, args)).rows;
  const statsBy = {};
  stats.forEach(s => { statsBy[s.code] = s; });

  const revs = counts.map(c => ({
    ...c,
    avg_actual: statsBy[c.code]?.avg_actual ?? null,
    min_actual: statsBy[c.code]?.min_actual ?? null,
    max_actual: statsBy[c.code]?.max_actual ?? null,
  })).filter(r => r.avg_actual != null)
     .sort((a, b) => a.avg_actual - b.avg_actual)
     .slice(0, 300);

  // Chart: top 20 fastest (lowest avg) with data
  const withData = revs.filter(r => r.avg_actual != null).slice(0, 20);
  bar('chartReviewer',
    withData.map(r => (r.reviewer_name || '?') + ' (' + r.code + ')'),
    withData.map(r => round1(r.avg_actual)),
    'Avg actual (min)',
    { horizontal: true },
  );

  renderTable('tblReviewer', [
    { key:'code',             label:'Code' },
    { key:'reviewer_name',    label:'Reviewer' },
    { key:'team',             label:'Team' },
    { key:'matches_listed',   label:'Assignments',      num:true },
    { key:'distinct_matches', label:'Distinct matches', num:true },
    { key:'avg_actual',       label:'Avg actual (min)', num:true },
    { key:'min_actual',       label:'Min',              num:true },
    { key:'max_actual',       label:'Max',              num:true },
  ], revs);
}

// --- Rows — minimal columns (no review time, diff, notes) ---
async function loadRows(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;
  const { rows } = await query(`
    SELECT match_id, assignment_date, competition, home_team, away_team,
           code, reviewer_name, team, task, half, side
    FROM assignments
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR match_id LIKE ?3 OR task LIKE ?3 OR code LIKE ?3 OR home_team LIKE ?3 OR away_team LIKE ?3)
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 500
  `, [start, end, like]);
  document.getElementById('rowsCount').textContent = rows.length + ' rows (max 500)';
  renderTable('tblRows', [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned',    render: r => (r.assignment_date || '').slice(0,10), raw:false },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
  ], rows);
}

// ============================================================
// Wire UI
// ============================================================
document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

document.getElementById('rangeSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  STATE.range = b.dataset.range;
  STATE.customStart = ''; STATE.customEnd = '';
  document.getElementById('dateStart').value = '';
  document.getElementById('dateEnd').value = '';
  document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.toggle('active', x === b));
  refresh();
});
function onDateChange() {
  STATE.customStart = document.getElementById('dateStart').value;
  STATE.customEnd   = document.getElementById('dateEnd').value;
  if (STATE.customStart || STATE.customEnd) {
    document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.remove('active'));
  }
  refresh();
}
document.getElementById('dateStart').addEventListener('change', onDateChange);
document.getElementById('dateEnd').addEventListener('change', onDateChange);

// Overview granularity control was removed — no listener needed.
document.getElementById('taskGranSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  STATE.taskGran = b.dataset.gran;
  document.querySelectorAll('#taskGranSeg button').forEach(x => x.classList.toggle('active', x === b));
  if (STATE.view === 'tasks') refresh();
});

document.getElementById('q').addEventListener('input', e => {
  STATE.q = e.target.value.trim();
  clearTimeout(window._t);
  window._t = setTimeout(refresh, 300);
});
document.getElementById('reloadBtn').addEventListener('click', refresh);
document.getElementById('revTaskSel').addEventListener('change', e => {
  STATE.selectedTask = e.target.value;
  if (STATE.view === 'reviewers') loadReviewers().catch(err => console.error(err));
});

// Theme toggle — persists to localStorage
const themeBtn = document.getElementById('themeToggle');
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('art_theme', t); } catch(_) {}
  applyChartDefaults();
  // redraw all charts w/ new colors
  refresh();
}
themeBtn.addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  setTheme(cur === 'dark' ? 'light' : 'dark');
});
try {
  const saved = localStorage.getItem('art_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch(_) {}

// ============================================================
// CSV Import
// ============================================================
const IMPORT_CONFIG = {
  assignments: {
    // DB columns to write; source column looked up case+punct-insensitive
    dbCols: ['match_id','code','task','half','side','reviewer_name','team','competition',
             'home_team','away_team','home_priority','away_priority','comp_priority',
             'match_date','sla','assignment_date','last_modified'],
    aliases: {},
  },
  data_logs: {
    dbCols: ['matchid','code','partid','full_name','review_started','review_ended',
             'actual_time_taken','total_break_time','total_time_taken'],
    aliases: { code: 'hr_code' },
  },
  productivity_config: {
    dbCols: ['task','expected_minutes'],
    aliases: {},
  },
};
function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Robust minimal CSV parser: handles quoted fields, escaped quotes, commas
// inside quotes, and CRLF/LF line endings. No dependency.
function parseCSV(text) {
  const rows = [];
  let cur = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQ) {
      if (c === '"' && n === '"') { field += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\r' && n === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; }
      else if (c === '\n' || c === '\r') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  // drop trailing empty row
  while (rows.length && rows[rows.length-1].every(x => x === '')) rows.pop();
  return rows;
}

function impLog(msg, cls) {
  const el = document.getElementById('impLog');
  const line = document.createElement('div');
  if (cls === 'err') line.style.color = 'var(--pos)';
  if (cls === 'ok')  line.style.color = 'var(--neg)';
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function runImport() {
  const tableName = document.getElementById('impTable').value;
  const token = document.getElementById('impToken').value.trim();
  const fileInput = document.getElementById('impFile');
  const cfg = IMPORT_CONFIG[tableName];
  if (!token) { impLog('Missing admin token.', 'err'); return; }
  if (!fileInput.files.length) { impLog('No file selected.', 'err'); return; }

  const file = fileInput.files[0];
  impLog('Reading ' + file.name + ' (' + Math.round(file.size/1024) + ' KB)…');
  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) { impLog('CSV has no data rows.', 'err'); return; }

  const header = rows.shift().map(h => String(h || '').trim());
  const headerNorm = {};
  header.forEach((h, i) => { headerNorm[normKey(h)] = i; });

  // Map each DB col → source column index (with aliases)
  const mapping = {};
  cfg.dbCols.forEach(dbCol => {
    const alias = cfg.aliases[dbCol];
    if (alias) {
      const ai = headerNorm[normKey(alias)];
      if (ai !== undefined) { mapping[dbCol] = ai; return; }
    }
    const i = headerNorm[normKey(dbCol)];
    if (i !== undefined) mapping[dbCol] = i;
  });
  const found = Object.keys(mapping);
  const missing = cfg.dbCols.filter(c => !(c in mapping));
  impLog(`Header cols detected: ${header.length}. Mapped ${found.length}/${cfg.dbCols.length} DB cols. Missing: ${missing.join(', ') || '(none)'}`);
  impLog('Rows to push: ' + rows.length);

  // Build INSERT OR REPLACE statements
  const colList = cfg.dbCols.join(',');
  const qMarks  = cfg.dbCols.map(() => '?').join(',');
  const sql = `INSERT OR REPLACE INTO ${tableName} (${colList}) VALUES (${qMarks})`;

  const BATCH = 500;
  let pushed = 0, failed = 0;
  const t0 = performance.now();
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const statements = slice.map(row => ({
      sql,
      args: cfg.dbCols.map(c => {
        const j = mapping[c];
        return (j != null && j < row.length) ? row[j] : '';
      }),
    }));
    try {
      const r = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
        body: JSON.stringify({ statements }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (j.error ? JSON.stringify(j.error).slice(0,200) : await r.text()));
      pushed += slice.length;
    } catch (e) {
      failed += slice.length;
      impLog('Batch ' + (i / BATCH + 1) + ' FAILED: ' + e.message, 'err');
    }
    impLog(`Progress: ${pushed}/${rows.length} pushed (${failed} failed)`);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  impLog(`Done. Pushed ${pushed} rows in ${secs}s. Failed ${failed}.`, failed ? 'err' : 'ok');
}

async function wipeTable() {
  const tableName = document.getElementById('impTable').value;
  const token = document.getElementById('impToken').value.trim();
  if (!token) { impLog('Missing admin token.', 'err'); return; }
  if (!confirm('DELETE all rows from ' + tableName + '?')) return;
  const r = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ statements: [{ sql: 'DELETE FROM ' + tableName, args: [] }] }),
  });
  if (r.ok) impLog('Wiped table ' + tableName, 'ok');
  else impLog('Wipe failed: HTTP ' + r.status, 'err');
}

document.getElementById('impStart').addEventListener('click', () => runImport().catch(e => impLog(e.message, 'err')));
document.getElementById('impClear').addEventListener('click', () => wipeTable().catch(e => impLog(e.message, 'err')));

// Initial load
refresh();
