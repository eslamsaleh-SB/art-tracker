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

// Range start (YYYY-MM-DD) based on current UI range selection
function rangeStart(range) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0,10);
  if (range === 'all')     return '1970-01-01';
  if (range === 'week')    { const d = new Date(now); d.setDate(now.getDate() - now.getDay()); return iso(d); }
  if (range === 'month')   return now.toISOString().slice(0,7) + '-01';
  if (range === 'quarter') { const qm = Math.floor(now.getMonth()/3)*3; return now.getFullYear() + '-' + String(qm+1).padStart(2,'0') + '-01'; }
  if (range === 'year')    return now.getFullYear() + '-01-01';
  return '1970-01-01';
}
function rangeLabel(range) {
  return { week:'This week', month:'This month', quarter:'This quarter', year:'This year', all:'All time' }[range] || range;
}

// SQL expression for granularity bucket key
function granExpr(col, gran) {
  // assignment_date is stored either as 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS' — use substr for portability
  if (gran === 'day')     return `substr(${col},1,10)`;
  if (gran === 'week')    return `strftime('%Y-W%W', ${col})`;
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
  range: 'month',
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
  document.getElementById('pageSub').textContent = 'Loading ' + rangeLabel(STATE.range) + '…';
  const t0 = performance.now();
  try {
    if (STATE.view === 'overview')  await loadOverview();
    if (STATE.view === 'tasks')     await loadTasks();
    if (STATE.view === 'reviewers') await loadReviewers();
    if (STATE.view === 'rows')      await loadRows();
    const dt = Math.round(performance.now() - t0);
    document.getElementById('pageSub').textContent = `${rangeLabel(STATE.range)} · ${dt} ms`;
  } catch (e) {
    document.getElementById('pageSub').innerHTML = `<span class="error">ERR: ${esc(e.message)}</span>`;
    console.error(e);
  }
}

// --- Overview ---
async function loadOverview() {
  const start = rangeStart(STATE.range);
  const like = STATE.q ? '%' + STATE.q + '%' : '';

  // KPIs
  const kpi = (await query(`
    SELECT
      COUNT(*)                              AS assignments,
      COUNT(DISTINCT match_id)              AS distinct_matches,
      COUNT(DISTINCT code)                  AS reviewers,
      COUNT(DISTINCT task)                  AS tasks
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR task LIKE ?2 OR code LIKE ?2 OR team LIKE ?2)
  `, [start, like])).rows[0] || {};

  const kpiHtml = [
    ['Assignments',       kpi.assignments,        'total rows'],
    ['Distinct matches',  kpi.distinct_matches,   'unique games'],
    ['Reviewers',         kpi.reviewers,          'active in range'],
    ['Tasks',             kpi.tasks,              'assigned in range'],
  ].map(([label, value, sub]) => `
    <div class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${fmt(value)}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`).join('');
  document.getElementById('kpis').innerHTML = kpiHtml;

  // Time series (assignments over time)
  const gexpr = granExpr('assignment_date', STATE.gran);
  const trend = (await query(`
    SELECT ${gexpr} AS bucket, COUNT(*) AS n
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR task LIKE ?2 OR code LIKE ?2 OR team LIKE ?2)
    GROUP BY bucket ORDER BY bucket
  `, [start, like])).rows;
  line('chartOverviewTime',
    trend.map(r => r.bucket),
    [{ label: 'Assignments', data: trend.map(r => r.n), color: css('--accent') }],
  );

  // Per-task and per-team bars
  const byTask = (await query(`
    SELECT task, COUNT(*) AS n
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR task LIKE ?2 OR code LIKE ?2 OR team LIKE ?2)
      AND task IS NOT NULL AND task <> ''
    GROUP BY task ORDER BY n DESC
  `, [start, like])).rows;
  bar('chartOverviewTasks', byTask.map(r => r.task), byTask.map(r => r.n), 'Assignments');

  const byTeam = (await query(`
    SELECT team, COUNT(*) AS n
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR task LIKE ?2 OR code LIKE ?2 OR team LIKE ?2)
      AND team IS NOT NULL AND team <> ''
    GROUP BY team ORDER BY n DESC
  `, [start, like])).rows;
  bar('chartOverviewTeams', byTeam.map(r => r.team), byTeam.map(r => r.n), 'Assignments');
}

// --- Tasks: grid of cards, each expandable ---
async function loadTasks() {
  const start = rangeStart(STATE.range);
  const like = STATE.q ? '%' + STATE.q + '%' : '';

  // Per-task summary + time series in one shot per task requires N+1 queries
  // for expandable charts. To stay fast, only fetch summaries here; each
  // card lazy-loads its own trend on expand.
  const summary = (await query(`
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
  `, [start, like])).rows;

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
          <div class="task-card-stat-value">${fmt(t.matches_listed)}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Distinct matches</div>
          <div class="task-card-stat-value">${fmt(t.distinct_matches)}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Reviewers</div>
          <div class="task-card-stat-value">${fmt(t.reviewers)}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Avg time (min)</div>
          <div class="task-card-stat-value">${fmt(t.avg_actual)}</div>
        </div>
      </div>
      <div class="task-card-chart"><canvas id="miniTaskChart_${esc(t.task).replace(/\W/g,'_')}"></canvas></div>
      <div class="task-card-detail">
        <div class="chart-wrap short" style="margin-top:8px"><canvas id="fullTaskChart_${esc(t.task).replace(/\W/g,'_')}"></canvas></div>
      </div>
    </div>
  `).join('');

  // Lazy-load mini charts (all tasks' trends in one query, then split)
  const gexpr = granExpr('a.assignment_date', STATE.taskGran);
  const trend = (await query(`
    SELECT a.task AS task, ${gexpr} AS bucket, COUNT(*) AS n
    FROM assignments a
    WHERE a.assignment_date >= ?1
      AND (?2 = '' OR a.reviewer_name LIKE ?2 OR a.task LIKE ?2 OR a.code LIKE ?2)
      AND a.task IS NOT NULL AND a.task <> ''
    GROUP BY a.task, bucket
    ORDER BY a.task, bucket
  `, [start, like])).rows;

  // Bucket labels union (so all cards share the same X axis)
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
    line('miniTaskChart_' + safe, buckets, [{ label: t.task, data: dataArr, color: css('--accent') }]);
    line('fullTaskChart_' + safe, buckets, [{ label: t.task, data: dataArr, color: css('--accent') }], { fill: true });
  });

  // Wire expand
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
async function loadReviewers() {
  const start = rangeStart(STATE.range);
  const like = STATE.q ? '%' + STATE.q + '%' : '';

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

  const taskFilter = task ? 'AND a.task = ?3' : '';
  const args = task ? [start, like, task] : [start, like];

  const revs = (await query(`
    SELECT
      a.code AS code,
      a.reviewer_name AS reviewer_name,
      a.team AS team,
      COUNT(*) AS matches_listed,
      COUNT(DISTINCT a.match_id) AS distinct_matches,
      AVG(dl.actual_time_taken) AS avg_actual,
      MIN(dl.actual_time_taken) AS min_actual,
      MAX(dl.actual_time_taken) AS max_actual
    FROM assignments a
    LEFT JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date >= ?1
      AND (?2 = '' OR a.reviewer_name LIKE ?2 OR a.team LIKE ?2 OR a.code LIKE ?2)
      ${taskFilter}
    GROUP BY a.code, a.reviewer_name, a.team
    HAVING avg_actual IS NOT NULL OR ?2 <> ''
    ORDER BY (avg_actual IS NULL) ASC, avg_actual ASC
    LIMIT 300
  `, args)).rows;

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
async function loadRows() {
  const start = rangeStart(STATE.range);
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const { rows } = await query(`
    SELECT match_id, assignment_date, competition, home_team, away_team,
           code, reviewer_name, team, task, half, side
    FROM assignments
    WHERE assignment_date >= ?1
      AND (?2 = '' OR reviewer_name LIKE ?2 OR match_id LIKE ?2 OR task LIKE ?2 OR code LIKE ?2 OR home_team LIKE ?2 OR away_team LIKE ?2)
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 500
  `, [start, like]);
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
  document.querySelectorAll('#rangeSeg button').forEach(x => x.classList.toggle('active', x === b));
  refresh();
});

document.getElementById('granSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  STATE.gran = b.dataset.gran;
  document.querySelectorAll('#granSeg button').forEach(x => x.classList.toggle('active', x === b));
  if (STATE.view === 'overview') refresh();
});
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

// Initial load
refresh();
