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

// ============================================================
// Comments — shared across 5 views: nologs, partial, players_nologs,
// bc_nologs, players_partial. Each view has its own DB table.
// ============================================================
const COMMENT_AUTHORS = ['Ehab Ashraf','Mohamed Mokhtar','Mohamed Mohsen','Sherif Badawy','Omar Alaa'];
const COMMENT_STATUSES = ['', 'approved', 'investigation'];
const VIEW_TO_COMMENT_TABLE = {
  nologs: 'comments_nologs',
  partial: 'comments_partial',
  players_nologs: 'comments_players_nologs',
  bc_nologs: 'comments_bc_nologs',
  players_partial: 'comments_players_partial',
};
const COMMENTS = { byTable: {}, filter: { hasComment: 'all', author: '', status: '' } };

function getAdminToken() {
  return localStorage.getItem('adminToken') || '';
}
function setAdminToken(t) {
  if (t) localStorage.setItem('adminToken', t);
}
// Build a stable row-key for any row shape. Order-sensitive.
function rowKey(row, keys) {
  return keys.map(k => String(row[k] == null ? '' : row[k]).trim()).join('|');
}
async function loadCommentsFor(table) {
  const { rows } = await query(`SELECT row_key, author, comment, status, created_at, updated_at
                                FROM ${table}`);
  const map = {};
  rows.forEach(r => { map[r.row_key] = r; });
  COMMENTS.byTable[table] = map;
  return map;
}
// Save comment. If `changeStatus` is true, uses admin-gated endpoint.
// Otherwise uses the public /api/comment/note endpoint (comment+author only).
async function saveComment(table, row_key, row_data, author, comment, status, changeStatus) {
  const token = getAdminToken();
  let url, headers, body;
  if (changeStatus) {
    if (!token) { alert('Setting status requires admin token — open Import CSV, paste token, reload.'); return null; }
    url = '/api/comment';
    headers = { 'Content-Type': 'application/json', 'X-Admin-Token': token };
    body = JSON.stringify({ table, row_key, row_data, author, comment, status });
  } else {
    url = '/api/comment/note';
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({ table, row_key, row_data, author, comment });
  }
  const r = await fetch(url, { method: 'POST', headers, body });
  if (!r.ok) { alert('Save failed: ' + await r.text()); return null; }
  const j = await r.json();
  COMMENTS.byTable[table] = COMMENTS.byTable[table] || {};
  const prev = COMMENTS.byTable[table][row_key] || {};
  COMMENTS.byTable[table][row_key] = {
    row_key, author, comment,
    status: changeStatus ? status : (prev.status || ''),
    created_at: prev.created_at || j.updated_at,
    updated_at: j.updated_at,
  };
  return j;
}
async function deleteComment(table, row_key) {
  const token = getAdminToken();
  if (!token) { alert('Admin token missing.'); return null; }
  const r = await fetch('/api/comment/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
    body: JSON.stringify({ table, row_key }),
  });
  if (!r.ok) { alert('Delete failed'); return null; }
  if (COMMENTS.byTable[table]) delete COMMENTS.byTable[table][row_key];
  return true;
}

// Modal — open for a specific row. Shared DOM.
function openCommentModal(table, row_key, row_data, refreshFn) {
  const existing = (COMMENTS.byTable[table] || {})[row_key] || {};
  document.getElementById('cmModalTitle').textContent = existing.comment ? 'Edit comment' : 'Add comment';
  document.getElementById('cmModalRowKey').textContent = row_key;
  const authorSel = document.getElementById('cmAuthor');
  authorSel.innerHTML = '<option value="">-- select --</option>' +
    COMMENT_AUTHORS.map(a => `<option value="${esc(a)}"${a===existing.author?' selected':''}>${esc(a)}</option>`).join('');
  const statusSel = document.getElementById('cmStatus');
  const hasAdminToken = !!getAdminToken();
  statusSel.innerHTML = COMMENT_STATUSES.map(s =>
    `<option value="${s}"${s===(existing.status||'')?' selected':''}>${s || '(none)'}</option>`).join('');
  statusSel.disabled = !hasAdminToken;
  const statusHint = document.getElementById('cmStatusHint');
  if (statusHint) {
    statusHint.textContent = hasAdminToken
      ? 'Editable — requires admin token (loaded ✓)'
      : 'Locked — paste admin token in Import CSV tab to change';
    statusHint.style.color = hasAdminToken ? '#4caf50' : 'var(--text-dim)';
  }
  document.getElementById('cmText').value = existing.comment || '';
  document.getElementById('cmMeta').textContent = existing.updated_at
    ? `Last edit: ${existing.updated_at.slice(0,19).replace('T',' ')} by ${existing.author || '—'}`
    : 'New comment';

  const saveBtn = document.getElementById('cmSave');
  const delBtn  = document.getElementById('cmDelete');
  const closeBtn= document.getElementById('cmClose');
  delBtn.style.display = (existing.comment && hasAdminToken) ? 'inline-block' : 'none';

  saveBtn.onclick = async () => {
    const author = authorSel.value;
    const status = statusSel.value;
    const text = document.getElementById('cmText').value.trim();
    if (!author) { alert('Pick a name'); return; }
    if (!text)   { alert('Write a comment'); return; }
    // changeStatus = did the user actually change the status vs. what's stored?
    const changeStatus = (status !== (existing.status || ''));
    saveBtn.disabled = true;
    await saveComment(table, row_key, row_data, author, text, status, changeStatus);
    saveBtn.disabled = false;
    document.getElementById('cmModal').style.display = 'none';
    if (refreshFn) refreshFn();
  };
  delBtn.onclick = async () => {
    if (!confirm('Delete this comment?')) return;
    await deleteComment(table, row_key);
    document.getElementById('cmModal').style.display = 'none';
    if (refreshFn) refreshFn();
  };
  closeBtn.onclick = () => { document.getElementById('cmModal').style.display = 'none'; };

  document.getElementById('cmModal').style.display = 'flex';
}

// Attach comment column + apply filter. Returns { cols, filteredRows }.
function withComments(table, cols, rows, keyFields, refreshFn) {
  const cache = COMMENTS.byTable[table] || {};
  // Attach row_key + comment ref to each row
  const enriched = rows.map(r => {
    const rk = rowKey(r, keyFields);
    return { ...r, _rk: rk, _cm: cache[rk] || null };
  });
  // Apply comment filters
  const f = COMMENTS.filter;
  const filtered = enriched.filter(r => {
    if (f.hasComment === 'yes' && !r._cm) return false;
    if (f.hasComment === 'no'  &&  r._cm) return false;
    if (f.author && (!r._cm || r._cm.author !== f.author)) return false;
    if (f.status && (!r._cm || (r._cm.status || '') !== f.status)) return false;
    return true;
  });
  const newCols = cols.concat([
    {
      key: '_status', label: 'Status', raw: true,
      render: (r) => {
        const s = r._cm?.status || '';
        if (s === 'approved') return `<span style="background:#1e4620;color:#4caf50;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">✓ Approved</span>`;
        if (s === 'investigation') return `<span style="background:#4a3620;color:#ff9800;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">⚠ Investigation</span>`;
        return `<span style="color:var(--text-dim);">—</span>`;
      }
    },
    {
      key: '_comment', label: 'Comment', raw: true,
      render: (r) => {
        const c = r._cm;
        if (!c) return `<button class="btn-icon cm-btn" data-tbl="${table}" data-rk="${esc(r._rk)}">+ add</button>`;
        const snippet = esc((c.comment || '').slice(0, 60));
        return `<button class="btn-icon cm-btn" data-tbl="${table}" data-rk="${esc(r._rk)}" title="${esc(c.comment || '')}">${esc(c.author || '?')}: ${snippet}${c.comment && c.comment.length > 60 ? '…' : ''}</button>`;
      }
    }
  ]);
  // Delegate click on cm-btn to open modal (attach once per render)
  setTimeout(() => {
    document.querySelectorAll('.cm-btn').forEach(btn => {
      btn.onclick = () => {
        const rk = btn.getAttribute('data-rk');
        const tbl = btn.getAttribute('data-tbl');
        const rowData = (filtered.find(x => x._rk === rk)) || {};
        openCommentModal(tbl, rk, rowData, refreshFn);
      };
    });
  }, 0);
  return { cols: newCols, rows: filtered };
}

// Render standard comment-filter bar. Call once per view when it mounts.
function renderCommentFilterBar(containerId, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `
    <select id="${containerId}_has" class="ctrl">
      <option value="all">All rows</option>
      <option value="yes">With comment</option>
      <option value="no">Without comment</option>
    </select>
    <select id="${containerId}_author" class="ctrl">
      <option value="">Any author</option>
      ${COMMENT_AUTHORS.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}
    </select>
    <select id="${containerId}_status" class="ctrl">
      <option value="">Any status</option>
      <option value="approved">Approved</option>
      <option value="investigation">Investigation</option>
    </select>
  `;
  document.getElementById(containerId + '_has').value = COMMENTS.filter.hasComment;
  document.getElementById(containerId + '_author').value = COMMENTS.filter.author;
  document.getElementById(containerId + '_status').value = COMMENTS.filter.status;
  document.getElementById(containerId + '_has').onchange    = e => { COMMENTS.filter.hasComment = e.target.value; onChange(); };
  document.getElementById(containerId + '_author').onchange = e => { COMMENTS.filter.author     = e.target.value; onChange(); };
  document.getElementById(containerId + '_status').onchange = e => { COMMENTS.filter.status     = e.target.value; onChange(); };
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
  // End = today PLUS 1 day so we're inclusive of ISO-timestamped rows
  // like '2026-07-27T00:00:00' (which is > '2026-07-27' lexicographically).
  const endDate = new Date(now); endDate.setDate(endDate.getDate() + 1);
  const end = iso(endDate);
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
// SQL fragment: Half/Side rules per Apps Script
//   half=1st          → only partid=1
//   half=2nd          → only partid=2
//   half=Both + side=Home/Away → all partids (incl. extras)
//   half=Both + side=Both/blank → partid IN (1,2) only
// Returns the actual_time_taken value ONLY when the log row's partid
// counts under the assignment's Half/Side spec; else 0. Wrap in SUM()
// grouped by (match_id, code, task, half, side) to get match total.
// ============================================================
function ruleActualExpr(aliasA, aliasDL) {
  const A  = aliasA  ? aliasA  + '.' : '';
  const DL = aliasDL ? aliasDL + '.' : '';
  return `
    CASE
      WHEN lower(IFNULL(${A}half, '')) = '1st' THEN
        CASE WHEN ${DL}partid = '1' THEN ${DL}actual_time_taken ELSE 0 END
      WHEN lower(IFNULL(${A}half, '')) = '2nd' THEN
        CASE WHEN ${DL}partid = '2' THEN ${DL}actual_time_taken ELSE 0 END
      WHEN lower(IFNULL(${A}side, '')) IN ('home', 'away') THEN
        ${DL}actual_time_taken
      ELSE
        CASE WHEN ${DL}partid IN ('1', '2') THEN ${DL}actual_time_taken ELSE 0 END
    END
  `;
}

// ============================================================
// State
// ============================================================
const STATE = {
  view: 'overview',
  range: '12m',
  customStart: '',
  customEnd: '',
  gran: 'month',
  taskGran: 'month',
  taskExcludeSameDay: false,   // exclude same-reviewer, same-day multi-match units from stats
  q: '',
  teams: [],           // multi-select include (empty = all)
  teamsExclude: [],    // deprecated — kept for backward compat, always empty now
  reviewer: '',
  atMode: '',          // Actual Time filter: '' | 'lt' | 'between'
  atMin: null,
  atMax: null,
  rowsPage: 1,
  rowsPerPage: 500,
  rowsTotal: 0,
  code: '',
  taskFilter: '',      // global task filter (used everywhere)
  selectedTask: '',    // still used inside By Reviewer view (synced w/ taskFilter)
  revTopN: 20,
  revShowAll: false,
  hoursGran: 'week',   // 'day' | 'week'
  extraTask: 'all',    // 'all' | 'Players New Players' | 'B - C Review'
  filtersLoaded: false,
  sortState: {},       // { tblId: { key, dir } }
  lastRows: {},        // { tblId: [rows] } — for CSV export
};

// Format 'YYYY-MM' → 'Mar 2026'
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}/.test(ym)) return ym || '';
  const [y, m] = ym.split('-').map(Number);
  return MONTHS[m-1] + ' ' + y;
}
// Format bucket by current granularity — YYYY-MM → 'Mar 2026', dates → dates
function fmtBucket(bucket, gran) {
  if (gran === 'month' && /^\d{4}-\d{2}$/.test(bucket)) return monthLabel(bucket);
  return bucket;
}

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

  // Persist the row set + cols for CSV export
  STATE.lastRows[tblId] = { cols, rows: rows || [] };

  // Apply saved sort
  const s = STATE.sortState[tblId];
  let sortedRows = (rows || []).slice();
  if (s && s.key) {
    const col = cols.find(c => c.key === s.key);
    sortedRows.sort((a, b) => {
      const va = a[s.key], vb = b[s.key];
      const na = (va == null || va === ''), nb = (vb == null || vb === '');
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return s.dir === 'asc' ? va - vb : vb - va;
      const sa = String(va), sb = String(vb);
      return s.dir === 'asc' ? sa.localeCompare(sb, undefined, { numeric: true }) : sb.localeCompare(sa, undefined, { numeric: true });
    });
  }

  const head = '<thead><tr>' + cols.map(c => {
    const sortCls = s && s.key === c.key ? (s.dir === 'asc' ? 'sort-asc' : 'sort-desc') : '';
    const cls = [c.num ? 'num' : '', c.noSort ? '' : 'sortable', sortCls].filter(Boolean).join(' ');
    return `<th class="${cls}" data-sort-key="${esc(c.key)}">${esc(c.label)}</th>`;
  }).join('') + '</tr></thead>';

  if (!sortedRows.length) {
    tbl.innerHTML = head + `<tbody><tr><td colspan="${cols.length}" class="empty">No data in this range.</td></tr></tbody>`;
    wireSortHeaders(tbl, tblId);
    return;
  }

  const body = '<tbody>' + sortedRows.map(r =>
    '<tr>' + cols.map(c => {
      let v = r[c.key];
      if (c.render) {
        v = c.render(r);
      } else if (c.num && typeof v === 'number') {
        v = fmt(v);
      }
      const cell = c.raw
        ? (v == null ? '—' : v)
        : (v == null || v === '' ? (c.num ? '—' : '') : esc(v));
      return `<td class="${c.num?'num':''}">${cell}</td>`;
    }).join('') + '</tr>'
  ).join('') + '</tbody>';
  tbl.innerHTML = head + body;
  wireSortHeaders(tbl, tblId);
}
function wireSortHeaders(tbl, tblId) {
  tbl.querySelectorAll('th.sortable').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sortKey;
      const cur = STATE.sortState[tblId];
      const dir = (cur && cur.key === key && cur.dir === 'asc') ? 'desc' : 'asc';
      STATE.sortState[tblId] = { key, dir };
      const saved = STATE.lastRows[tblId];
      if (saved) renderTable(tblId, saved.cols, saved.rows);
    };
  });
}

// CSV export from saved table state
function exportTableCsv(tblId) {
  const saved = STATE.lastRows[tblId];
  if (!saved) return;
  const { cols, rows } = saved;
  const escape = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const header = cols.map(c => escape(c.label)).join(',');
  const body = rows.map(r => cols.map(c => {
    let v = r[c.key];
    if (c.render && !c.raw) {
      // Render may return HTML — strip tags for CSV
      const html = c.render(r);
      v = String(html || '').replace(/<[^>]+>/g, '');
    } else if (typeof v === 'number') {
      v = round1(v);
    }
    return escape(v);
  }).join(',')).join('\n');
  const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = tblId + '_' + new Date().toISOString().slice(0,10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// Views
// ============================================================
function setView(name) {
  STATE.view = name;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== 'view-' + name));
  document.getElementById('pageTitle').textContent = {
    overview: 'Overview', tasks: 'Analysis by task', reviewers: 'Analysis by reviewer',
    rows: 'Assignments',
    players: 'Players', bc: 'B - C Review',
    players_nologs: 'Players — No Logs', bc_nologs: 'B - C — No Logs',
    players_partial: 'Players — Partial Coverage',
    nologs: 'No Logs', partial: 'Partial Coverage',
    hours: 'Reviewer hours', import: 'Import CSV',
  }[name] || name;
  refresh();
}

// Populate Team / Reviewer / Code dropdowns once (from DISTINCT queries)
async function loadFilters() {
  if (STATE.filtersLoaded) return;
  const [teams, revs, codes] = await Promise.all([
    query(`SELECT DISTINCT team FROM assignments WHERE team IS NOT NULL AND team <> '' ORDER BY team`),
    query(`SELECT DISTINCT reviewer_name FROM assignments WHERE reviewer_name IS NOT NULL AND reviewer_name <> '' ORDER BY reviewer_name`),
    query(`SELECT DISTINCT code FROM assignments WHERE code IS NOT NULL AND code <> '' ORDER BY code`),
  ]);
  fillTeamCheckboxes(teams.rows.map(r => r.team));
  fillSel('fReviewer',      'All reviewers', revs.rows.map(r => r.reviewer_name));
  fillSel('fCode',          'All codes',     codes.rows.map(r => r.code));
  // Global Task dropdown (single select)
  const tasks = (await query(`
    SELECT DISTINCT task FROM assignments
    WHERE task IS NOT NULL AND task <> '' ORDER BY task
  `)).rows.map(r => r.task);
  fillSel('fTaskGlobal', 'All tasks', tasks);
  STATE.filtersLoaded = true;
}
function fillSel(id, allLabel, options) {
  const sel = document.getElementById(id);
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(allLabel)}</option>` +
    options.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = cur;
}
// Team filter — checkbox popup (replaces the two multi-selects)
function fillTeamCheckboxes(teamsList) {
  const container = document.getElementById('teamCheckboxes');
  if (!container) return;
  container.dataset.teams = JSON.stringify(teamsList);
  const chosen = new Set(STATE.teams || []);
  container.innerHTML = teamsList.map(t => `
    <label style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;">
      <input type="checkbox" class="teamOpt" value="${esc(t)}"${chosen.has(t) ? ' checked' : ''}>
      <span>${esc(t)}</span>
    </label>
  `).join('');
  updateTeamButton();
}
function updateTeamButton() {
  const btn = document.getElementById('teamFilterBtn');
  if (!btn) return;
  const n = (STATE.teams || []).length;
  btn.textContent = n === 0 ? 'All teams' : (n === 1 ? STATE.teams[0] : n + ' teams selected');
}

// Format minutes as "1h 23m" (or "45m" if <60, or "12h" if exact hour)
function minToHM(min) {
  if (min == null || isNaN(min)) return '';
  const total = Math.round(Number(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return m + 'm';
  if (m === 0) return h + 'h';
  return h + 'h ' + m + 'm';
}

// Build the shared WHERE clause + args starting at position 4
// (positions 1-3 already used: start, end, q-like)
function extraFilterSQL(prefix) {
  const parts = [];
  const args  = [];
  let n = 4;
  // Hard-coded: never show umbrella app rows or pre-Jan-3 rows.
  parts.push(`IFNULL(lower(${prefix}app), '') <> 'umbrella'`);
  parts.push(`${prefix}assignment_date >= '2026-01-03'`);
  // Multi-select include teams
  if (STATE.teams && STATE.teams.length) {
    const ph = STATE.teams.map(() => '?' + (n++)).join(',');
    parts.push(`${prefix}team IN (${ph})`);
    args.push(...STATE.teams);
  }
  // Multi-select exclude teams
  if (STATE.teamsExclude && STATE.teamsExclude.length) {
    const ph = STATE.teamsExclude.map(() => '?' + (n++)).join(',');
    parts.push(`${prefix}team NOT IN (${ph})`);
    args.push(...STATE.teamsExclude);
  }
  if (STATE.reviewer)   { parts.push(`${prefix}reviewer_name = ?${n++}`); args.push(STATE.reviewer); }
  if (STATE.code)       { parts.push(`${prefix}code = ?${n++}`);          args.push(STATE.code); }
  // Global task filter
  if (STATE.taskFilter) { parts.push(`${prefix}task = ?${n++}`);          args.push(STATE.taskFilter); }
  return { sql: ' AND ' + parts.join(' AND '), args };
}

async function refresh(opts) {
  opts = opts || {};
  if (!opts.keepPage) STATE.rowsPage = 1;
  const R = currentRange();
  const label = rangeLabel(STATE.range, R.start, R.end);
  document.getElementById('pageSub').textContent = 'Loading ' + label + '…';
  const t0 = performance.now();
  try {
    await loadFilters();
    if (STATE.view === 'overview')  await loadOverview(R);
    if (STATE.view === 'tasks')     await loadTasks(R);
    if (STATE.view === 'reviewers') await loadReviewers(R);
    if (STATE.view === 'rows')      await loadRows(R);
    if (STATE.view === 'players_nologs') await loadExtraNoLogs(R, { table: 'players',   tblId: 'tblPlayersNoLogs', countId: 'playersNoLogsCount' });
    if (STATE.view === 'bc_nologs')      await loadExtraNoLogs(R, { table: 'bc_review', tblId: 'tblBcNoLogs',      countId: 'bcNoLogsCount' });
    if (STATE.view === 'players')   await loadExtraTable(R, {
      table: 'players', taskLabel: 'Players New Players',
      kpisId: 'playersKpis',
      tblReviewer: 'tblPlayersReviewer', tblRows: 'tblPlayersRows', countId: 'playersRowsCount',
    });
    if (STATE.view === 'bc')        await loadExtraTable(R, {
      table: 'bc_review', taskLabel: 'B - C Review',
      kpisId: 'bcKpis',
      tblReviewer: 'tblBcReviewer', tblRows: 'tblBcRows', countId: 'bcRowsCount',
    });
    if (STATE.view === 'nologs')    await loadNoLogs(R);
    if (STATE.view === 'partial')          await loadPartial(R);
    if (STATE.view === 'players_partial')  await loadPlayersPartial(R);
    if (STATE.view === 'hours')     await loadHours(R);
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
  const ef = extraFilterSQL('');
  const efA = extraFilterSQL('a.');

  const kpi = (await query(`
    SELECT
      COUNT(*)                              AS assignments,
      COUNT(DISTINCT match_id)              AS distinct_matches,
      COUNT(DISTINCT code)                  AS reviewers,
      COUNT(DISTINCT task)                  AS tasks
    FROM assignments
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR task LIKE ?3 OR code LIKE ?3 OR team LIKE ?3)
      ${ef.sql}
  `, [start, end, like, ...ef.args])).rows[0] || {};

  // Overall avg = avg of per-(match, code) totals, deduped so multi-task
  // assignments on the same match don't multi-count the same log time.
  const overall = (await query(`
    SELECT AVG(match_total) AS avg_actual, COUNT(*) AS matches
    FROM (
      SELECT dl.matchid AS match_id, dl.code AS code,
             SUM(dl.actual_time_taken) AS match_total
      FROM data_logs dl
      WHERE EXISTS (
        SELECT 1 FROM assignments a
        WHERE a.match_id = dl.matchid AND a.code = dl.code
          AND a.assignment_date BETWEEN ?1 AND ?2
          AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3 OR a.team LIKE ?3)
          ${efA.sql}
      )
      GROUP BY dl.matchid, dl.code
    )
  `, [start, end, like, ...efA.args])).rows[0] || {};

  const perTask = (await query(`
    SELECT task, avg_actual, samples FROM (
      SELECT task,
        AVG(match_total) AS avg_actual,
        COUNT(*) AS samples
      FROM (
        SELECT a.task AS task, a.match_id AS match_id, a.code AS code,
               SUM(${ruleActualExpr('a','dl')}) AS match_total
        FROM assignments a
        JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
        WHERE a.assignment_date BETWEEN ?1 AND ?2
          AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3 OR a.team LIKE ?3)
          AND a.task IS NOT NULL AND a.task <> ''
          ${efA.sql}
        GROUP BY a.task, a.match_id, a.code, a.half, a.side
      )
      GROUP BY task HAVING samples >= 5
    )
    ORDER BY avg_actual ASC
  `, [start, end, like, ...efA.args])).rows;
  const fastest = perTask[0];
  const slowest = perTask[perTask.length - 1];

  const cards = [
    { label: 'Assignments',       value: fmt(kpi.assignments),       sub: 'total rows' },
    { label: 'Distinct matches',  value: fmt(kpi.distinct_matches),  sub: 'unique games' },
    { label: 'Reviewers',         value: fmt(kpi.reviewers),         sub: 'active in range' },
    { label: 'Tasks',             value: fmt(kpi.tasks),             sub: 'assigned in range' },
    { label: 'Avg review time',   value: overall.avg_actual != null ? fmt(overall.avg_actual) + ' min' : '—',
      sub: fmt(overall.matches) + ' matches counted' },
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
  const ef  = extraFilterSQL('');
  const efA = extraFilterSQL('a.');

  // Base summary — counts by task from assignments
  const mainSummary = (await query(`
    WITH filtered AS (
      SELECT match_id, code, task, substr(assignment_date, 1, 7) AS ym
      FROM assignments
      WHERE assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR reviewer_name LIKE ?3 OR task LIKE ?3 OR code LIKE ?3)
        AND task IS NOT NULL AND task <> ''
        ${ef.sql}
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
  `, [start, end, like, ...ef.args])).rows;

  // Players count
  const playersCount = (await query(`
    SELECT 'Players New Players' AS task,
           COUNT(*) AS assignments,
           COUNT(DISTINCT match_id) AS distinct_matches
    FROM players
    WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}
  `, [start, end, ...ef.args])).rows;

  // BC count
  const bcCount = (await query(`
    SELECT 'B - C Review' AS task,
           COUNT(*) AS assignments,
           COUNT(DISTINCT match_id) AS distinct_matches
    FROM bc_review
    WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}
  `, [start, end, ...ef.args])).rows;

  const summary = [...mainSummary, ...playersCount, ...bcCount].filter(r => r.assignments > 0);

  // Exclude same-reviewer/same-day multi-match units when toggle is on.
  // A "unit" is dropped if its (code, day) has more than one distinct match_id
  // in the same source table.
  const exclMain = STATE.taskExcludeSameDay ? `
    AND NOT EXISTS (
      SELECT 1 FROM assignments a2
      WHERE a2.code = a.code
        AND substr(a2.assignment_date, 1, 10) = substr(a.assignment_date, 1, 10)
        AND a2.match_id <> a.match_id
        AND a2.assignment_date BETWEEN ?1 AND ?2
    )` : '';
  const exclPlayers = STATE.taskExcludeSameDay ? `
    AND NOT EXISTS (
      SELECT 1 FROM players p2
      WHERE p2.code = p.code
        AND substr(p2.assignment_date, 1, 10) = substr(p.assignment_date, 1, 10)
        AND p2.match_id <> p.match_id
        AND p2.assignment_date BETWEEN ?1 AND ?2
    )` : '';
  const exclBc = STATE.taskExcludeSameDay ? `
    AND NOT EXISTS (
      SELECT 1 FROM bc_review b2
      WHERE b2.code = b.code
        AND substr(b2.assignment_date, 1, 10) = substr(b.assignment_date, 1, 10)
        AND b2.match_id <> b.match_id
        AND b2.assignment_date BETWEEN ?1 AND ?2
    )` : '';

  // Per-match totals — one row per (task, match, reviewer). Actual = SUM of
  // ALL data_logs sessions for that reviewer × match, regardless of half/side/partid.
  // Compared against full-match expected minutes from productivity_config.
  const mainUnits = (await query(`
    SELECT task, match_id, code,
           COALESCE(SUM(actual_time_taken), 0) AS actual
    FROM (
      SELECT DISTINCT a.task AS task, a.match_id AS match_id, a.code AS code
      FROM assignments a
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
        AND a.task IS NOT NULL AND a.task <> ''
        ${efA.sql}
        ${exclMain}
    ) tc
    JOIN data_logs dl ON dl.matchid = tc.match_id AND dl.code = tc.code
    GROUP BY task, match_id, code
  `, [start, end, like, ...efA.args])).rows;

  // Players — per-match total.
  const playersUnits = (await query(`
    SELECT p.task AS task,
      COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                WHERE dl.matchid = p.match_id AND dl.code = p.code), 0) AS actual
    FROM (SELECT DISTINCT match_id, code, task, assignment_date FROM players
          WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}) p
    WHERE 1=1 ${exclPlayers.replace(/\bp\./g, 'p.')}
  `, [start, end, ...ef.args])).rows;

  // BC — per-match total.
  const bcUnits = (await query(`
    SELECT b.task AS task,
      COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                WHERE dl.matchid = b.match_id AND dl.code = b.code), 0) AS actual
    FROM (SELECT DISTINCT match_id, code, task, assignment_date FROM bc_review
          WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}) b
    WHERE 1=1 ${exclBc.replace(/\bb\./g, 'b.')}
  `, [start, end, ...ef.args])).rows;

  // Group by task → array of actuals for stat computation
  const actualsByTask = {};
  [...mainUnits, ...playersUnits, ...bcUnits].forEach(r => {
    const v = parseFloat(r.actual);
    if (isNaN(v) || v <= 0) return;
    (actualsByTask[r.task] = actualsByTask[r.task] || []).push(v);
  });

  function statsOf(arr) {
    if (!arr || !arr.length) return { n: 0, avg: null, median: null, min: null, max: null };
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    const avg = s.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? s[(n-1)/2] : (s[n/2 - 1] + s[n/2]) / 2;
    return { n, avg, median, min: s[0], max: s[n-1] };
  }
  const statsByTask = {};
  Object.keys(actualsByTask).forEach(t => { statsByTask[t] = statsOf(actualsByTask[t]); });

  // Fetch expected minutes for every task shown
  const taskNames = summary.map(t => t.task);
  const expByTask = {};
  if (taskNames.length) {
    const ph = taskNames.map((_, i) => '?' + (i + 1)).join(',');
    const { rows } = await query(
      `SELECT task, expected_minutes FROM productivity_config WHERE task IN (${ph})`,
      taskNames
    );
    rows.forEach(r => { expByTask[r.task] = parseFloat(r.expected_minutes) || 0; });
  }

  // Merge stats + expected into summary
  summary.forEach(t => {
    const s = statsByTask[t.task] || { n: 0, avg: null, median: null, min: null };
    t.avg_actual = s.avg;
    t.median_actual = s.median;
    t.min_actual = s.min;
    t.n = s.n;
    t.expected = expByTask[t.task] ?? null;
    t.diff_avg    = (t.avg_actual    != null && t.expected != null) ? t.avg_actual    - t.expected : null;
    t.diff_median = (t.median_actual != null && t.expected != null) ? t.median_actual - t.expected : null;
  });
  summary.sort((a, b) => (b.assignments || 0) - (a.assignments || 0));
  const avgByTask = {}; summary.forEach(t => { avgByTask[t.task] = t.avg_actual; });

  // Top charts — one for avg, one for median
  bar('chartTaskCount', summary.map(t => t.task), summary.map(t => t.assignments), 'Total assignments');
  const withAvg = summary.filter(t => t.avg_actual != null);
  const canvas = document.getElementById('chartTaskAvg');
  if (canvas) {
    if (canvas._chart) canvas._chart.destroy();
    canvas._chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: withAvg.map(t => t.task),
        datasets: [
          { label: 'Average (min)', data: withAvg.map(t => round1(t.avg_actual)),    backgroundColor: css('--accent') || '#4a9eff' },
          { label: 'Median (min)',  data: withAvg.map(t => round1(t.median_actual)), backgroundColor: css('--pos')    || '#4caf50' },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
    });
  }

  const grid = document.getElementById('taskGrid');
  if (!summary.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No tasks in this range.</div>';
    return;
  }
  // Card shows 4 top stats + per-stat rows: median | avg | diff (both) | expected
  grid.innerHTML = summary.map(t => {
    function diffCell(v) {
      if (v == null) return '—';
      const cls = v > 0 ? 'color:var(--pos,#4caf50)' : v < 0 ? 'color:var(--neg,#f66)' : '';
      return `<span style="${cls};font-weight:600;">${v > 0 ? '+' : ''}${fmt(v)}</span>`;
    }
    return `
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
          <div class="task-card-stat-label">Expected (min)</div>
          <div class="task-card-stat-value">${t.expected != null ? fmt(t.expected) : '—'}</div>
        </div>
        <div class="task-card-stat">
          <div class="task-card-stat-label">Sample size</div>
          <div class="task-card-stat-value">${fmt(t.n || 0)}</div>
        </div>
      </div>
      <table style="width:100%;margin-top:8px;font-size:12px;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid var(--border,#333);">
            <th style="text-align:left;padding:4px;">Metric</th>
            <th style="text-align:right;padding:4px;">Value (min)</th>
            <th style="text-align:right;padding:4px;">Δ Expected</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:4px;">Median</td>
            <td style="text-align:right;padding:4px;font-weight:600;">${t.median_actual != null ? fmt(t.median_actual) : '—'}</td>
            <td style="text-align:right;padding:4px;">${diffCell(t.diff_median)}</td>
          </tr>
          <tr>
            <td style="padding:4px;">Average</td>
            <td style="text-align:right;padding:4px;font-weight:600;">${t.avg_actual != null ? fmt(t.avg_actual) : '—'}</td>
            <td style="text-align:right;padding:4px;">${diffCell(t.diff_avg)}</td>
          </tr>
        </tbody>
      </table>
      <div class="task-card-detail">
        <div class="chart-wrap short" style="margin-top:8px"><canvas id="fullTaskChart_${esc(t.task).replace(/\W/g,'_')}"></canvas></div>
      </div>
    </div>
  `;
  }).join('');

  // Trend — return per-unit rows tagged (task, bucket, actual). JS computes
  // avg + median per bucket. Covers main tasks + Players + BC.
  const gexprA = granExpr('a.assignment_date', STATE.taskGran);
  const gexprP = granExpr('p.assignment_date', STATE.taskGran);
  const gexprB = granExpr('b.assignment_date', STATE.taskGran);

  const trendMain = (await query(`
    SELECT task, bucket, SUM(actual_time_taken) AS actual
    FROM (
      SELECT DISTINCT a.task AS task, ${gexprA} AS bucket,
             a.match_id AS match_id, a.code AS code
      FROM assignments a
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
        AND a.task IS NOT NULL AND a.task <> ''
        ${efA.sql}
        ${exclMain}
    ) tc
    JOIN data_logs dl ON dl.matchid = tc.match_id AND dl.code = tc.code
    GROUP BY task, bucket, match_id, code
  `, [start, end, like, ...efA.args])).rows;

  const trendPlayers = (await query(`
    SELECT p.task AS task, ${gexprP} AS bucket,
      COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                WHERE dl.matchid = p.match_id AND dl.code = p.code), 0) AS actual
    FROM (SELECT DISTINCT match_id, code, task, assignment_date FROM players
          WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}) p
    WHERE 1=1 ${exclPlayers.replace(/\bp\./g, 'p.')}
  `, [start, end, ...ef.args])).rows;

  const trendBc = (await query(`
    SELECT b.task AS task, ${gexprB} AS bucket,
      COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                WHERE dl.matchid = b.match_id AND dl.code = b.code), 0) AS actual
    FROM (SELECT DISTINCT match_id, code, task, assignment_date FROM bc_review
          WHERE assignment_date BETWEEN ?1 AND ?2 ${ef.sql}) b
    WHERE 1=1 ${exclBc.replace(/\bb\./g, 'b.')}
  `, [start, end, ...ef.args])).rows;

  // Group per (task, bucket) → array of actuals
  const trendMap = {}; // task -> bucket -> [actuals]
  [...trendMain, ...trendPlayers, ...trendBc].forEach(r => {
    const v = parseFloat(r.actual);
    if (isNaN(v) || v <= 0) return;
    if (!trendMap[r.task]) trendMap[r.task] = {};
    if (!trendMap[r.task][r.bucket]) trendMap[r.task][r.bucket] = [];
    trendMap[r.task][r.bucket].push(v);
  });

  const bucketsSet = new Set();
  Object.values(trendMap).forEach(m => Object.keys(m).forEach(b => bucketsSet.add(b)));
  const buckets = Array.from(bucketsSet).sort();
  const labels = buckets.map(b => fmtBucket(b, STATE.taskGran));

  function bucketStats(arr) {
    if (!arr || !arr.length) return { avg: null, median: null };
    const s = arr.slice().sort((a, b) => a - b);
    const n = s.length;
    const avg = s.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    return { avg, median };
  }

  summary.forEach(t => {
    const safe = t.task.replace(/\W/g, '_');
    const perBucket = buckets.map(b => bucketStats(trendMap[t.task]?.[b] || []));
    const avgArr    = perBucket.map(s => s.avg    != null ? round1(s.avg)    : null);
    const medianArr = perBucket.map(s => s.median != null ? round1(s.median) : null);
    line('fullTaskChart_' + safe, labels, [
      { label: 'Average (min)', data: avgArr,    color: css('--accent') || '#4a9eff' },
      { label: 'Median (min)',  data: medianArr, color: css('--pos')    || '#4caf50' },
    ], { fill: false });
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

// --- Reviewers view — REQUIRES a task pick (no "all tasks" option) ---
async function loadReviewers(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;
  const efA = extraFilterSQL('a.');

  const sel = document.getElementById('revTaskSel');

  // Populate task dropdown from DB — first task auto-picked
  if (sel.options.length <= 1 || sel.options[0].value === '') {
    const tasks = (await query(`
      SELECT DISTINCT task FROM assignments
      WHERE task IS NOT NULL AND task <> '' ORDER BY task
    `)).rows.map(r => r.task);
    sel.innerHTML = tasks.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    // Restore previous choice, or first task
    if (STATE.selectedTask && tasks.indexOf(STATE.selectedTask) >= 0) sel.value = STATE.selectedTask;
    else if (tasks.length) sel.value = tasks[0];
    STATE.selectedTask = sel.value;
  }
  const task = sel.value;
  STATE.selectedTask = task;

  if (!task) {
    document.querySelector('#tblReviewer').innerHTML = '<tbody><tr><td class="empty">Pick a task above.</td></tr></tbody>';
    destroyChart('chartReviewer');
    return;
  }

  const args = [start, end, like, ...efA.args, task];
  const taskParam = '?' + (4 + efA.args.length);

  // Counts per reviewer — GROUP BY code only. If a code has multiple teams
  // or reviewer_name variants in the source, collapse them here so the row
  // appears once. GROUP_CONCAT gives all distinct values.
  const counts = (await query(`
    SELECT code,
      COALESCE((SELECT reviewer_name FROM assignments WHERE code = a.code
                 AND reviewer_name IS NOT NULL AND reviewer_name <> ''
                 GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1),
               MAX(reviewer_name)) AS reviewer_name,
      (SELECT GROUP_CONCAT(DISTINCT team) FROM assignments WHERE code = a.code
         AND team IS NOT NULL AND team <> '') AS team,
      COUNT(*) AS matches_listed,
      COUNT(DISTINCT match_id) AS distinct_matches
    FROM assignments a
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.team LIKE ?3 OR a.code LIKE ?3)
      ${efA.sql}
      AND a.task = ${taskParam}
    GROUP BY code
  `, args)).rows;

  // Match-total based stats — SUM logs per (code, match_id) first, then
  // AVG / MIN / MAX across those match totals. Avoids log-row bias.
  const stats = (await query(`
    SELECT code,
      AVG(match_total) AS avg_actual,
      MIN(match_total) AS min_actual,
      MAX(match_total) AS max_actual
    FROM (
      SELECT a.code AS code, a.match_id AS match_id,
             SUM(${ruleActualExpr('a','dl')}) AS match_total
      FROM assignments a
      JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.team LIKE ?3 OR a.code LIKE ?3)
        ${efA.sql}
        AND a.task = ${taskParam}
      GROUP BY a.code, a.match_id, a.half, a.side
    )
    GROUP BY code
  `, args)).rows;
  const statsBy = {};
  stats.forEach(s => { statsBy[s.code] = s; });

  const revs = counts.map(c => ({
    ...c,
    avg_actual: statsBy[c.code]?.avg_actual ?? null,
    min_actual: statsBy[c.code]?.min_actual ?? null,
    max_actual: statsBy[c.code]?.max_actual ?? null,
  })).filter(r => r.avg_actual != null)
     .sort((a, b) => a.avg_actual - b.avg_actual);

  // Top-N picker: user chooses how many to display in chart (default 20) or "All"
  const topN = STATE.revShowAll ? revs.length : Math.max(5, Math.min(revs.length, STATE.revTopN || 20));
  const shown = revs.slice(0, topN);

  // Dynamically resize the chart container to fit N horizontal bars
  const wrap = document.getElementById('reviewerChartWrap');
  const heightPx = Math.max(300, shown.length * 22 + 60);
  wrap.style.height = heightPx + 'px';

  bar('chartReviewer',
    shown.map(r => (r.reviewer_name || '?') + ' (' + r.code + ')'),
    shown.map(r => round1(r.avg_actual)),
    'Avg actual (min) — ' + task,
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

// --- Rows — assignments w/ Apps Script rules applied ---
// Half/Side scaling for expected time:
//   scale = (side ∈ {Home,Away} ? 2 : 1) * (half ∈ {1st,2nd} ? 2 : 1)
//   expected = base_task_minutes / scale
// Actual time from data_logs:
//   half=1st       → partid 1
//   half=2nd       → partid 2
//   half=Both,side=Both → partid 1+2 only
//   half=Both,side=Home/Away → all partids present (incl. 3rd/4th/5th)
// 24-hour rule per (matchid, code, partid):
//   sort logs asc by review_started; anchor = first; keep rows where
//   start ≤ anchor + 24h; log excluded ones as "additional logs after N days".
async function loadRows(R) {
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const start = R.start, end = R.end;
  const ef = extraFilterSQL('');

  // Sub-query: other tasks reviewer worked on same date (Players / B-C).
  const otherTasksExpr = `(
    SELECT GROUP_CONCAT(DISTINCT t) FROM (
      SELECT 'Players' AS t FROM players
        WHERE code = assignments.code
          AND substr(assignment_date, 1, 10) = substr(assignments.assignment_date, 1, 10)
      UNION
      SELECT 'B - C Review' FROM bc_review
        WHERE code = assignments.code
          AND substr(assignment_date, 1, 10) = substr(assignments.assignment_date, 1, 10)
    )
  )`;

  // Assignments in range, capped at the latest review_started in the logs.
  // Also do a COUNT(*) to drive pagination.
  const commonWhere = `
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR match_id LIKE ?3 OR task LIKE ?3 OR code LIKE ?3 OR home_team LIKE ?3 OR away_team LIKE ?3)
      AND substr(assignment_date, 1, 10) <= COALESCE(
        (SELECT substr(MAX(review_started), 1, 10) FROM data_logs),
        '2999-12-31'
      )
      AND EXISTS (
        SELECT 1 FROM data_logs dl
        WHERE dl.matchid = assignments.match_id AND dl.code = assignments.code
      )
      ${ef.sql}
  `;
  const totalRow = (await query(
    `SELECT COUNT(*) AS c FROM assignments ${commonWhere}`,
    [start, end, like, ...ef.args]
  )).rows[0] || { c: 0 };
  STATE.rowsTotal = totalRow.c;

  const perPage = STATE.rowsPerPage;
  const totalPages = Math.max(1, Math.ceil(STATE.rowsTotal / perPage));
  if (STATE.rowsPage > totalPages) STATE.rowsPage = 1;
  const offset = (STATE.rowsPage - 1) * perPage;

  const arows = (await query(`
    SELECT match_id, assignment_date, competition, home_team, away_team,
           code, reviewer_name, team, task, half, side,
           ${otherTasksExpr} AS other_tasks_same_day
    FROM assignments
    ${commonWhere}
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT ${perPage} OFFSET ${offset}
  `, [start, end, like, ...ef.args])).rows;

  if (!arows.length) {
    document.getElementById('rowsCount').textContent = '0 rows';
    renderTable('tblRows', [{ key:'x', label:'—' }], []);
    return;
  }

  // Distinct (match_id, code) pairs → fetch logs + expected minutes together
  const uniqPairs = new Set(arows.map(r => r.match_id + '||' + r.code));
  const uniqTasks = new Set(arows.map(r => r.task).filter(Boolean));

  // Pull matching data_logs for all pairs. Chunk into groups so IN() doesn't
  // exceed SQL parameter limits (~999 args).
  const pairKeys = Array.from(uniqPairs);
  const logsByPair = {}; // 'match||code' → { partid: [ {start_ts, actual, brk, tot} ] }
  const CHUNK = 200;
  for (let i = 0; i < pairKeys.length; i += CHUNK) {
    const chunk = pairKeys.slice(i, i + CHUNK);
    const matchIds = chunk.map(k => k.split('||')[0]);
    const codes    = chunk.map(k => k.split('||')[1]);
    const placeholders = chunk.map((_, j) => `(?${j*2+1}, ?${j*2+2})`).join(',');
    const args = [];
    chunk.forEach(k => { const [m, c] = k.split('||'); args.push(m, c); });
    const { rows } = await query(`
      SELECT matchid, code, partid, review_started, actual_time_taken, total_break_time, total_time_taken
      FROM data_logs
      WHERE (matchid, code) IN (VALUES ${placeholders})
    `, args);
    rows.forEach(r => {
      const key = r.matchid + '||' + r.code;
      if (!logsByPair[key]) logsByPair[key] = {};
      const p = String(r.partid);
      if (!logsByPair[key][p]) logsByPair[key][p] = [];
      const ts = r.review_started ? new Date(r.review_started).getTime() : 0;
      logsByPair[key][p].push({
        ts,
        actual: parseFloat(r.actual_time_taken) || 0,
        brk:    parseFloat(r.total_break_time)  || 0,
        tot:    parseFloat(r.total_time_taken)  || 0,
      });
    });
  }
  // Sort each partid group asc by start ts
  Object.values(logsByPair).forEach(perPart => {
    Object.values(perPart).forEach(arr => arr.sort((a, b) => a.ts - b.ts));
  });

  // Expected minutes per task
  const expByTask = {};
  const taskList = Array.from(uniqTasks);
  if (taskList.length) {
    const placeholders = taskList.map((_, i) => '?' + (i+1)).join(',');
    const { rows } = await query(
      `SELECT task, expected_minutes FROM productivity_config WHERE task IN (${placeholders})`,
      taskList,
    );
    rows.forEach(r => { expByTask[r.task] = parseFloat(r.expected_minutes) || 0; });
  }

  // Compute actual / expected / diff / notes for each assignment
  const enriched = arows.map(a => {
    const key = a.match_id + '||' + a.code;
    const partMap = logsByPair[key] || {};
    const availablePartids = Object.keys(partMap);
    const halfL = (a.half || '').toLowerCase();
    const sideL = (a.side || '').toLowerCase();

    // Which partids to sum?
    let targetPartids;
    if (halfL === '1st') targetPartids = ['1'];
    else if (halfL === '2nd') targetPartids = ['2'];
    else if (sideL === 'home' || sideL === 'away') {
      // all halves worked incl. extras
      targetPartids = availablePartids.length ? availablePartids : ['1', '2'];
    } else {
      // Both/Both → 1st + 2nd only
      targetPartids = ['1', '2'];
    }

    // Apply 24hr rule per partid
    const WINDOW = 24 * 60 * 60 * 1000;
    let actual = 0, brk = 0, tot = 0;
    const lateDays = new Set();
    targetPartids.forEach(pid => {
      const rows = partMap[pid];
      if (!rows || !rows.length) return;
      const anchor = rows[0].ts;
      rows.forEach(r => {
        if (anchor && r.ts && (r.ts - anchor) > WINDOW) {
          lateDays.add(Math.round((r.ts - anchor) / (24*60*60*1000)));
          return;
        }
        actual += r.actual;
        brk += r.brk;
        tot += r.tot;
      });
    });

    // Scale expected by side/half narrowing
    const sideNarrow = (sideL === 'home' || sideL === 'away');
    const halfNarrow = (halfL === '1st' || halfL === '2nd');
    const scale = (sideNarrow ? 2 : 1) * (halfNarrow ? 2 : 1); // 1, 2, or 4
    const base = expByTask[a.task];
    const expected = (base != null) ? base / scale : null;
    const diff = (expected != null) ? (actual - expected) : null;
    const noteParts = [];
    if (lateDays.size) {
      noteParts.push('Additional logs after (' + Array.from(lateDays).sort((x,y)=>x-y).map(d => d + ' day' + (d===1?'':'s')).join(', ') + ')');
    }
    if (a.other_tasks_same_day) {
      noteParts.push('Same day also: ' + a.other_tasks_same_day);
    }
    const notes = noteParts.join(' · ');

    return {
      ...a,
      assignment_date: (a.assignment_date || '').slice(0, 10),
      actual: actual > 0 ? actual : (Object.keys(partMap).length ? actual : null),
      expected,
      diff,
      scale,
      notes,
    };
  });

  // Post-JS Actual Time filter (applied on the computed actual value)
  let filtered = enriched;
  if (STATE.atMode === 'lt' && STATE.atMin != null) {
    filtered = filtered.filter(r => r.actual != null && r.actual < STATE.atMin);
  } else if (STATE.atMode === 'between' && STATE.atMin != null && STATE.atMax != null) {
    filtered = filtered.filter(r =>
      r.actual != null && r.actual >= STATE.atMin && r.actual <= STATE.atMax);
  }

  document.getElementById('rowsCount').textContent =
    filtered.length + ' rows' + (filtered.length !== enriched.length ? ' (of ' + enriched.length + ')' : '');
  renderTable('tblRows', [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned' },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
    { key:'actual',          label:'Actual (min)',   num:true },
    { key:'expected',        label:'Expected (min)', num:true },
    { key:'scale',           label:'/x',             num:true },
    {
      key:'diff', label:'Diff (min)', num:true, raw:true,
      render: r => {
        if (r.diff == null) return '—';
        const v = round1(r.diff);
        const cls = v > 0 ? 'style="color:var(--pos);font-weight:600"' : (v < 0 ? 'style="color:var(--neg);font-weight:600"' : '');
        return `<span ${cls}>${v > 0 ? '+' : ''}${v}</span>`;
      },
    },
    { key:'notes', label:'Notes' },
  ], filtered);

  renderPager(totalPages);
}

// Pager for the Assignments table
function renderPager(totalPages) {
  const info = document.getElementById('rowsPagerInfo');
  const nav  = document.getElementById('rowsPagerNav');
  if (!info || !nav) return;
  const per = STATE.rowsPerPage;
  const p   = STATE.rowsPage;
  const total = STATE.rowsTotal;
  const from = total === 0 ? 0 : (p - 1) * per + 1;
  const to   = Math.min(p * per, total);
  info.textContent = total === 0
    ? 'no rows'
    : `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;

  if (totalPages <= 1) { nav.innerHTML = ''; return; }

  const pages = [];
  const window = 2;
  const push = n => pages.push(n);
  push(1);
  if (p - window > 2) pages.push('…');
  for (let i = Math.max(2, p - window); i <= Math.min(totalPages - 1, p + window); i++) push(i);
  if (p + window < totalPages - 1) pages.push('…');
  if (totalPages > 1) push(totalPages);

  nav.innerHTML =
    `<button ${p === 1 ? 'disabled' : ''} data-page="${p - 1}">‹ Prev</button>` +
    pages.map(n =>
      n === '…' ? `<span class="num" style="cursor:default;">…</span>`
                : `<span class="num${n === p ? ' active' : ''}" data-page="${n}">${n}</span>`
    ).join('') +
    `<button ${p === totalPages ? 'disabled' : ''} data-page="${p + 1}">Next ›</button>`;

  nav.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      const n = parseInt(el.dataset.page, 10);
      if (isNaN(n) || n < 1 || n > totalPages) return;
      STATE.rowsPage = n;
      refresh({ keepPage: true });
      const wrap = document.querySelector('#tab-rows .table-wrap');
      if (wrap) wrap.scrollTop = 0;
    });
  });
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
document.getElementById('taskExcludeSameDay').addEventListener('change', e => {
  STATE.taskExcludeSameDay = e.target.checked;
  if (STATE.view === 'tasks') refresh();
});

// Search input removed in favor of dropdown filters — guard in case it's absent.
const qEl = document.getElementById('q');
if (qEl) {
  qEl.addEventListener('input', e => {
    STATE.q = e.target.value.trim();
    clearTimeout(window._t);
    window._t = setTimeout(refresh, 300);
  });
}
document.getElementById('reloadBtn').addEventListener('click', refresh);

// Team filter popup wiring
(function () {
  const btn    = document.getElementById('teamFilterBtn');
  const panel  = document.getElementById('teamFilterPanel');
  const allCb  = document.getElementById('teamAll');
  const apply  = document.getElementById('teamApply');
  const cancel = document.getElementById('teamCancel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.body.addEventListener('click', e => {
    if (!panel.contains(e.target) && e.target !== btn) panel.style.display = 'none';
  });
  allCb.addEventListener('change', e => {
    panel.querySelectorAll('.teamOpt').forEach(cb => cb.checked = e.target.checked);
  });
  apply.addEventListener('click', () => {
    const boxes = Array.from(panel.querySelectorAll('.teamOpt'));
    const allChecked = boxes.every(cb => cb.checked);
    const noneChecked = boxes.every(cb => !cb.checked);
    STATE.teams = (allChecked || noneChecked) ? [] : boxes.filter(cb => cb.checked).map(cb => cb.value);
    updateTeamButton();
    panel.style.display = 'none';
    refresh();
  });
  cancel.addEventListener('click', () => { panel.style.display = 'none'; });
})();

document.getElementById('fReviewer').addEventListener('change', e => { STATE.reviewer = e.target.value; refresh(); });
document.getElementById('fCode').addEventListener('change', e => { STATE.code = e.target.value; refresh(); });
document.getElementById('fTaskGlobal').addEventListener('change', e => {
  STATE.taskFilter = e.target.value;
  STATE.selectedTask = e.target.value;  // sync Reviewer view
  const revSel = document.getElementById('revTaskSel');
  if (revSel && e.target.value) revSel.value = e.target.value;
  refresh();
});

// Hours granularity switch
const hoursSeg = document.getElementById('hoursGranSeg');
if (hoursSeg) hoursSeg.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  STATE.hoursGran = b.dataset.hg;
  hoursSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  if (STATE.view === 'hours') refresh();
});

// Actual Time filter (Assignments view)
const atMode = document.getElementById('atMode');
if (atMode) {
  atMode.addEventListener('change', e => {
    const v = e.target.value;
    document.getElementById('atMax').style.display = (v === 'between') ? '' : 'none';
  });
  document.getElementById('atApply').addEventListener('click', () => {
    STATE.atMode = document.getElementById('atMode').value;
    const min = document.getElementById('atMin').value;
    const max = document.getElementById('atMax').value;
    STATE.atMin = min === '' ? null : parseFloat(min);
    STATE.atMax = max === '' ? null : parseFloat(max);
    if (STATE.view === 'rows') refresh();
  });
}

// CSV Export buttons — one delegated handler for every `data-export` attr
document.body.addEventListener('click', e => {
  const btn = e.target.closest('[data-export]');
  if (btn) exportTableCsv(btn.dataset.export);
});

document.getElementById('revTaskSel').addEventListener('change', e => {
  STATE.selectedTask = e.target.value;
  if (STATE.view === 'reviewers') refresh();
});
const revTopN = document.getElementById('revTopN');
if (revTopN) revTopN.addEventListener('input', e => {
  STATE.revTopN = parseInt(e.target.value || '20', 10);
  if (STATE.view === 'reviewers') refresh();
});
const revShowAll = document.getElementById('revShowAll');
if (revShowAll) revShowAll.addEventListener('change', e => {
  STATE.revShowAll = e.target.checked;
  document.getElementById('revTopN').disabled = e.target.checked;
  if (STATE.view === 'reviewers') refresh();
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
// Extra table view — parameterized by (table name, DOM ids, kind).
// kind = 'players' → per-side actual (halve when reviewer has both sides)
// kind = 'bc'      → per-part actual (specific partid)
// ============================================================
async function loadExtraTable(R, opt) {
  const table = opt.table;
  const kind  = opt.kind || (table === 'players' ? 'players' : 'bc');
  const start = R.start, end = R.end;
  const like  = STATE.q ? '%' + STATE.q + '%' : '';
  const args  = [start, end, like];

  // SQL fragment for actual time — parameterized by outer alias
  function actualExprAs(a) {
    if (kind === 'players') {
      return `(
        CASE
          WHEN (SELECT COUNT(*) FROM ${table} pp
                WHERE pp.match_id = ${a}.match_id AND pp.code = ${a}.code) >= 2
          THEN COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                        WHERE dl.matchid = ${a}.match_id AND dl.code = ${a}.code), 0) / 2.0
          ELSE COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                        WHERE dl.matchid = ${a}.match_id AND dl.code = ${a}.code), 0)
        END
      )`;
    }
    return `(
      COALESCE((SELECT SUM(dl.actual_time_taken) FROM data_logs dl
                WHERE dl.matchid = ${a}.match_id AND dl.code = ${a}.code
                  AND dl.partid = CASE
                    WHEN lower(${a}.half) = '1st' THEN '1'
                    WHEN lower(${a}.half) = '2nd' THEN '2'
                    ELSE '0' END), 0)
    )`;
  }
  const actualExpr = actualExprAs('a');
  const threshold = kind === 'players' ? 30 : 45;

  // KPIs
  const kpi = (await query(`
    SELECT
      COUNT(*) AS assignments,
      COUNT(DISTINCT match_id) AS distinct_matches,
      COUNT(DISTINCT code) AS reviewers
    FROM ${table}
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR match_id LIKE ?3 OR code LIKE ?3)
  `, args)).rows[0] || {};

  // Per-side/per-part avg + threshold split (above/below expected minutes)
  const avg = (await query(`
    SELECT AVG(t) AS avg_actual,
           SUM(CASE WHEN t > ${threshold} THEN 1 ELSE 0 END) AS above,
           SUM(CASE WHEN t > 0 AND t <= ${threshold} THEN 1 ELSE 0 END) AS below,
           SUM(CASE WHEN t = 0 THEN 1 ELSE 0 END) AS zero_time
    FROM (
      SELECT ${actualExpr} AS t
      FROM ${table} a
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.match_id LIKE ?3 OR a.code LIKE ?3)
    )
  `, args)).rows[0] || {};

  const cards = [
    { label: 'Assignments',      value: fmt(kpi.assignments),      sub: 'total rows' },
    { label: 'Distinct matches', value: fmt(kpi.distinct_matches), sub: 'unique games' },
    { label: 'Reviewers',        value: fmt(kpi.reviewers),        sub: 'active in range' },
    { label: 'Avg time / ' + (kind === 'players' ? 'side' : 'part'),
      value: avg.avg_actual != null ? fmt(avg.avg_actual) + ' min' : '—',
      sub: 'expected ≈ ' + threshold + ' min' },
    { label: 'Above ' + threshold + ' min', value: fmt(avg.above || 0), sub: 'slower than expected' },
    { label: 'Below ' + threshold + ' min', value: fmt(avg.below || 0), sub: 'faster than expected' },
  ];
  document.getElementById(opt.kpisId).innerHTML = cards.map(c => `
    <div class="kpi">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>
  `).join('');

  // Reviewer breakdown — per-side/per-part avg + threshold flags
  const revs = (await query(`
    SELECT a.code AS code,
           (SELECT reviewer_name FROM assignments WHERE code = a.code
              AND reviewer_name IS NOT NULL AND reviewer_name <> ''
              GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1) AS reviewer_name,
           (SELECT team FROM assignments WHERE code = a.code
              AND team IS NOT NULL AND team <> ''
              GROUP BY team ORDER BY COUNT(*) DESC LIMIT 1) AS team,
           COUNT(*) AS assignments,
           AVG(${actualExpr}) AS avg_actual,
           MIN(${actualExpr}) AS min_actual,
           MAX(${actualExpr}) AS max_actual,
           SUM(CASE WHEN ${actualExpr} > ${threshold} THEN 1 ELSE 0 END) AS above,
           SUM(CASE WHEN ${actualExpr} > 0 AND ${actualExpr} <= ${threshold} THEN 1 ELSE 0 END) AS below
    FROM ${table} a
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.code LIKE ?3)
    GROUP BY a.code
    ORDER BY assignments DESC
    LIMIT 500
  `, args)).rows;
  renderTable(opt.tblReviewer, [
    { key:'code',           label:'Code' },
    { key:'reviewer_name',  label:'Reviewer' },
    { key:'team',           label:'Team' },
    { key:'assignments',    label:'Assignments',    num:true },
    { key:'avg_actual',     label:'Avg (min)',      num:true, raw:true, render: r => {
      const v = round1(r.avg_actual || 0);
      const cls = v > threshold ? 'style="color:var(--pos);font-weight:600"'
                : (v > 0 ? 'style="color:var(--neg);font-weight:600"' : '');
      return `<span ${cls}>${v}</span>`;
    }},
    { key:'min_actual',     label:'Min',            num:true },
    { key:'max_actual',     label:'Max',            num:true },
    { key:'above',          label:'> ' + threshold, num:true },
    { key:'below',          label:'≤ ' + threshold, num:true },
  ], revs);

  // Raw assignments list — enriched via JOIN + per-side/per-part actual time
  // Team/reviewer/code filters run on resolved values (from assignments lookup)
  // since players/bc_review may have blank team.
  let n = 4;
  const teamFilters = [];
  const rowsArgs = args.slice();
  if (STATE.teams && STATE.teams.length) {
    const ph = STATE.teams.map(() => '?' + (n++)).join(',');
    teamFilters.push(`team IN (${ph})`);
    rowsArgs.push(...STATE.teams);
  }
  if (STATE.teamsExclude && STATE.teamsExclude.length) {
    const ph = STATE.teamsExclude.map(() => '?' + (n++)).join(',');
    teamFilters.push(`team NOT IN (${ph})`);
    rowsArgs.push(...STATE.teamsExclude);
  }
  if (STATE.reviewer)   { teamFilters.push(`reviewer_name = ?${n++}`); rowsArgs.push(STATE.reviewer); }
  if (STATE.code)       { teamFilters.push(`code = ?${n++}`);          rowsArgs.push(STATE.code); }
  const outerWhere = teamFilters.length ? 'WHERE ' + teamFilters.join(' AND ') : '';

  const rows = (await query(`
    SELECT * FROM (
      SELECT p.match_id, p.assignment_date,
             COALESCE(NULLIF(p.competition, ''), am.competition) AS competition,
             COALESCE(NULLIF(p.home_team, ''),   am.home_team)   AS home_team,
             COALESCE(NULLIF(p.away_team, ''),   am.away_team)   AS away_team,
             p.task, p.half, p.side, p.code,
             COALESCE(NULLIF(p.reviewer_name, ''), ac.reviewer_name) AS reviewer_name,
             COALESCE(NULLIF(p.team, ''),          ac.team)          AS team,
             ${actualExprAs('p')} AS actual_time
      FROM ${table} p
      LEFT JOIN (
        SELECT code,
               (SELECT reviewer_name FROM assignments WHERE code = a.code
                  AND reviewer_name IS NOT NULL AND reviewer_name <> ''
                  GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1) AS reviewer_name,
               (SELECT team FROM assignments WHERE code = a.code
                  AND team IS NOT NULL AND team <> ''
                  GROUP BY team ORDER BY COUNT(*) DESC LIMIT 1) AS team
        FROM assignments a WHERE code IS NOT NULL AND code <> '' GROUP BY code
      ) ac ON ac.code = p.code
      LEFT JOIN (
        SELECT match_id,
               MAX(competition) AS competition,
               MAX(home_team) AS home_team,
               MAX(away_team) AS away_team
        FROM assignments WHERE match_id IS NOT NULL AND match_id <> '' GROUP BY match_id
      ) am ON am.match_id = p.match_id
      WHERE p.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR p.reviewer_name LIKE ?3 OR p.match_id LIKE ?3 OR p.code LIKE ?3
             OR ac.reviewer_name LIKE ?3 OR am.competition LIKE ?3)
        AND substr(p.assignment_date, 1, 10) <= COALESCE(
          (SELECT substr(MAX(review_started), 1, 10) FROM data_logs),
          '2999-12-31'
        )
    )
    ${outerWhere}
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 1000
  `, rowsArgs)).rows;
  document.getElementById(opt.countId).textContent = rows.length + ' rows';
  renderTable(opt.tblRows, [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
    { key:'actual_time',     label:'Actual (min)', num:true, raw:true, render: r => {
      const v = round1(r.actual_time || 0);
      const cls = v > threshold ? 'style="color:var(--pos);font-weight:600"'
                : (v > 0 ? 'style="color:var(--neg);font-weight:600"' : 'style="color:var(--text-dim)"');
      return `<span ${cls}>${v}</span>`;
    }},
  ], rows);
}

// Players/BC "No Logs" view — rows in table with zero matching data_logs.
async function loadExtraNoLogs(R, opt) {
  const start = R.start, end = R.end;
  const like  = STATE.q ? '%' + STATE.q + '%' : '';
  const args  = [start, end, like];
  // Build team/reviewer/code filter clauses that operate on the resolved team
  // (from assignments lookup) since players/bc_review may have team blank.
  let n = 4;
  const teamFilters = [];
  if (STATE.teams && STATE.teams.length) {
    const ph = STATE.teams.map(() => '?' + (n++)).join(',');
    teamFilters.push(`resolved_team IN (${ph})`);
    args.push(...STATE.teams);
  }
  if (STATE.teamsExclude && STATE.teamsExclude.length) {
    const ph = STATE.teamsExclude.map(() => '?' + (n++)).join(',');
    teamFilters.push(`resolved_team NOT IN (${ph})`);
    args.push(...STATE.teamsExclude);
  }
  if (STATE.reviewer)   { teamFilters.push(`resolved_reviewer = ?${n++}`); args.push(STATE.reviewer); }
  if (STATE.code)       { teamFilters.push(`code = ?${n++}`);              args.push(STATE.code); }
  const havingClause = teamFilters.length ? 'WHERE ' + teamFilters.join(' AND ') : '';

  const rows = (await query(`
    SELECT * FROM (
      SELECT p.match_id, p.assignment_date, p.task, p.half, p.side, p.code,
             COALESCE(NULLIF(p.reviewer_name, ''),
                      (SELECT reviewer_name FROM assignments WHERE code = p.code
                         AND reviewer_name IS NOT NULL AND reviewer_name <> ''
                         GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1)) AS resolved_reviewer,
             COALESCE(NULLIF(p.team, ''),
                      (SELECT team FROM assignments WHERE code = p.code
                         AND team IS NOT NULL AND team <> ''
                         GROUP BY team ORDER BY COUNT(*) DESC LIMIT 1)) AS resolved_team
      FROM ${opt.table} p
      WHERE p.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR p.reviewer_name LIKE ?3 OR p.match_id LIKE ?3 OR p.code LIKE ?3)
        AND p.code IS NOT NULL AND p.code <> ''
        AND substr(p.assignment_date, 1, 10) <= COALESCE(
          (SELECT substr(MAX(review_started), 1, 10) FROM data_logs),
          '2999-12-31'
        )
        AND NOT EXISTS (
          SELECT 1 FROM data_logs dl WHERE dl.matchid = p.match_id AND dl.code = p.code
        )
    )
    ${havingClause}
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 2000
  `, args)).rows;
  // Rename for existing renderer
  rows.forEach(r => { r.reviewer_name = r.resolved_reviewer; r.team = r.resolved_team; });
  // Comments — different table per view
  const TBL = opt.table === 'players' ? 'comments_players_nologs' : 'comments_bc_nologs';
  const FID = opt.table === 'players' ? 'cmFilter_players_nologs' : 'cmFilter_bc_nologs';
  await loadCommentsFor(TBL);
  renderCommentFilterBar(FID, () => loadExtraNoLogs(R, opt));
  const baseCols = [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
  ];
  const { cols, rows: fr } = withComments(TBL, baseCols, rows,
    ['match_id','code','task','half','side'], () => loadExtraNoLogs(R, opt));
  document.getElementById(opt.countId).textContent = fr.length + ' rows';
  renderTable(opt.tblId, cols, fr);
}

// LEGACY — no longer used, kept as reference stub
async function loadExtra(R) {
  const start = R.start, end = R.end;
  const like  = STATE.q ? '%' + STATE.q + '%' : '';
  const taskFilter = STATE.extraTask === 'all' ? '' : "AND task = ?4";
  const args = STATE.extraTask === 'all' ? [start, end, like] : [start, end, like, STATE.extraTask];

  // KPI cards — one per task shown separately + a total
  const kpi = (await query(`
    SELECT task,
           COUNT(*) AS assignments,
           COUNT(DISTINCT match_id) AS distinct_matches,
           COUNT(DISTINCT code) AS reviewers
    FROM extra_tasks
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR match_id LIKE ?3 OR task LIKE ?3 OR code LIKE ?3)
      ${taskFilter}
    GROUP BY task
    ORDER BY task
  `, args)).rows;

  // Avg review time per task via data_logs join (Half/Side rule aware)
  const avg = (await query(`
    SELECT task, AVG(match_total) AS avg_actual FROM (
      SELECT a.task AS task, a.match_id, a.code, a.half, a.side,
             SUM(${ruleActualExpr('a','dl')}) AS match_total
      FROM extra_tasks a
      JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
      WHERE a.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.match_id LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
        ${taskFilter}
      GROUP BY a.task, a.match_id, a.code, a.half, a.side
    )
    GROUP BY task
  `, args)).rows;
  const avgBy = {};
  avg.forEach(r => { avgBy[r.task] = r.avg_actual; });

  // KPI card render
  const cards = kpi.map(k => ({
    label: k.task, value: fmt(k.assignments),
    sub: `${fmt(k.distinct_matches)} matches · ${fmt(k.reviewers)} reviewers · avg ${avgBy[k.task] != null ? fmt(avgBy[k.task]) + ' min' : '—'}`,
  }));
  document.getElementById('extraKpis').innerHTML = cards.length ? cards.map(c => `
    <div class="kpi">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>
  `).join('') : '<div class="empty">No data.</div>';

  // Charts
  bar('chartExtraCount', kpi.map(r => r.task), kpi.map(r => r.assignments), 'Assignments');
  bar('chartExtraAvg', kpi.map(r => r.task), kpi.map(r => avgBy[r.task] != null ? round1(avgBy[r.task]) : 0), 'Avg (min)');

  // Reviewer breakdown
  const revs = (await query(`
    SELECT a.code AS code, a.reviewer_name AS reviewer_name, a.team AS team, a.task AS task,
           COUNT(*) AS matches_listed,
           COUNT(DISTINCT a.match_id) AS distinct_matches,
           (SELECT AVG(match_total) FROM (
              SELECT a2.match_id, a2.code, a2.half, a2.side,
                     SUM(${ruleActualExpr('a2','dl2')}) AS match_total
              FROM extra_tasks a2
              JOIN data_logs dl2 ON dl2.matchid = a2.match_id AND dl2.code = a2.code
              WHERE a2.code = a.code AND a2.task = a.task
                AND a2.assignment_date BETWEEN ?1 AND ?2
              GROUP BY a2.match_id, a2.code, a2.half, a2.side
            )) AS avg_actual
    FROM extra_tasks a
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.code LIKE ?3 OR a.task LIKE ?3)
      ${taskFilter}
    GROUP BY a.code, a.reviewer_name, a.team, a.task
    ORDER BY matches_listed DESC
    LIMIT 300
  `, args)).rows;
  renderTable('tblExtraReviewer', [
    { key:'task',             label:'Task' },
    { key:'code',             label:'Code' },
    { key:'reviewer_name',    label:'Reviewer' },
    { key:'team',             label:'Team' },
    { key:'matches_listed',   label:'Assignments',      num:true },
    { key:'distinct_matches', label:'Distinct matches', num:true },
    { key:'avg_actual',       label:'Avg actual (min)', num:true },
  ], revs);

  // Raw assignments listing
  const rows = (await query(`
    SELECT match_id, assignment_date, competition, home_team, away_team,
           task, half, side, code, reviewer_name, team
    FROM extra_tasks
    WHERE assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR reviewer_name LIKE ?3 OR match_id LIKE ?3 OR task LIKE ?3 OR code LIKE ?3)
      ${taskFilter}
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 1000
  `, args)).rows;
  document.getElementById('extraRowsCount').textContent = rows.length + ' rows';
  renderTable('tblExtraRows', [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
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
// No Logs view — assignments w/ NO data_logs, BUT only where
// assignment_date <= max(review_started) in logs (i.e. work was
// expected by now). Recent unlogged assignments hidden.
// ============================================================
async function loadNoLogs(R) {
  const start = R.start, end = R.end;
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const ef = extraFilterSQL('a.');
  const { rows } = await query(`
    WITH cutoff AS (
      SELECT substr(MAX(review_started), 1, 10) AS max_review FROM data_logs
    )
    SELECT a.match_id, a.assignment_date, a.competition, a.home_team, a.away_team,
           a.task, a.half, a.side, a.code, a.reviewer_name, a.team
    FROM assignments a
    LEFT JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE dl.matchid IS NULL
      AND a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.match_id LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
      AND a.assignment_date <= (SELECT max_review FROM cutoff)
      ${ef.sql}
    GROUP BY a.match_id, a.code, a.task, a.half, a.side
    ORDER BY a.assignment_date DESC
    LIMIT 2000
  `, [start, end, like, ...ef.args]);
  const TBL = 'comments_nologs';
  await loadCommentsFor(TBL);
  renderCommentFilterBar('cmFilter_nologs', () => loadNoLogs(R));
  const baseCols = [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'half',            label:'Half' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
  ];
  const { cols, rows: fr } = withComments(TBL, baseCols, rows,
    ['match_id','code','task','half','side'], () => loadNoLogs(R));
  document.getElementById('nologsCount').textContent = fr.length + ' rows';
  renderTable('tblNoLogs', cols, fr);
}

// ============================================================
// Partial Coverage — half=Both assignments where only one partid
// (1 or 2) has logs.
// ============================================================
async function loadPartial(R) {
  const start = R.start, end = R.end;
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const ef = extraFilterSQL('a.');
  const { rows } = await query(`
    SELECT a.match_id, a.assignment_date, a.competition, a.home_team, a.away_team,
           a.task, a.half, a.side, a.code, a.reviewer_name, a.team,
           SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) AS logs_1st,
           SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) AS logs_2nd,
           CASE
             WHEN SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) > 0
              AND SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) = 0
             THEN 'Missing 2nd'
             WHEN SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) = 0
              AND SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) > 0
             THEN 'Missing 1st'
             ELSE 'ok'
           END AS missing
    FROM assignments a
    LEFT JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.match_id LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
      AND lower(a.half) = 'both'
      ${ef.sql}
    GROUP BY a.match_id, a.code, a.task, a.half, a.side
    HAVING (logs_1st > 0 AND logs_2nd = 0) OR (logs_1st = 0 AND logs_2nd > 0)
    ORDER BY a.assignment_date DESC
    LIMIT 2000
  `, [start, end, like, ...ef.args]);
  const TBL = 'comments_partial';
  await loadCommentsFor(TBL);
  renderCommentFilterBar('cmFilter_partial', () => loadPartial(R));
  const baseCols = [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
    { key:'missing',         label:'Missing half' },
    { key:'logs_1st',        label:'Logs 1st', num:true },
    { key:'logs_2nd',        label:'Logs 2nd', num:true },
  ];
  const { cols, rows: fr } = withComments(TBL, baseCols, rows,
    ['match_id','code','task','side'], () => loadPartial(R));
  document.getElementById('partialCount').textContent = fr.length + ' rows';
  renderTable('tblPartial', cols, fr);
}

// ============================================================
// Players — partial coverage. Players rows where data_logs have
// only partid=1 OR only partid=2 (not both). Same 1-side reviewers
// (Home OR Away only) don't count as partial — that's expected.
// ============================================================
async function loadPlayersPartial(R) {
  const start = R.start, end = R.end;
  const like  = STATE.q ? '%' + STATE.q + '%' : '';
  const args  = [start, end, like];
  let n = 4;
  const teamFilters = [];
  if (STATE.teams && STATE.teams.length) {
    const ph = STATE.teams.map(() => '?' + (n++)).join(',');
    teamFilters.push(`resolved_team IN (${ph})`);
    args.push(...STATE.teams);
  }
  if (STATE.teamsExclude && STATE.teamsExclude.length) {
    const ph = STATE.teamsExclude.map(() => '?' + (n++)).join(',');
    teamFilters.push(`resolved_team NOT IN (${ph})`);
    args.push(...STATE.teamsExclude);
  }
  if (STATE.reviewer) { teamFilters.push(`resolved_reviewer = ?${n++}`); args.push(STATE.reviewer); }
  if (STATE.code)     { teamFilters.push(`code = ?${n++}`);              args.push(STATE.code); }
  const outerWhere = teamFilters.length ? 'AND ' + teamFilters.join(' AND ') : '';

  const { rows } = await query(`
    SELECT * FROM (
      SELECT p.match_id, p.assignment_date,
             (SELECT MAX(competition) FROM assignments WHERE match_id = p.match_id) AS competition,
             (SELECT MAX(home_team)   FROM assignments WHERE match_id = p.match_id) AS home_team,
             (SELECT MAX(away_team)   FROM assignments WHERE match_id = p.match_id) AS away_team,
             p.task, p.side, p.code,
             COALESCE(NULLIF(p.reviewer_name, ''),
                      (SELECT reviewer_name FROM assignments WHERE code = p.code
                         AND reviewer_name IS NOT NULL AND reviewer_name <> ''
                         GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1)) AS resolved_reviewer,
             COALESCE(NULLIF(p.team, ''),
                      (SELECT team FROM assignments WHERE code = p.code
                         AND team IS NOT NULL AND team <> ''
                         GROUP BY team ORDER BY COUNT(*) DESC LIMIT 1)) AS resolved_team,
             (SELECT SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) FROM data_logs dl
                WHERE dl.matchid = p.match_id AND dl.code = p.code) AS logs_1st,
             (SELECT SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) FROM data_logs dl
                WHERE dl.matchid = p.match_id AND dl.code = p.code) AS logs_2nd,
             CASE
               WHEN (SELECT SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) FROM data_logs dl
                       WHERE dl.matchid = p.match_id AND dl.code = p.code) > 0
                AND COALESCE((SELECT SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) FROM data_logs dl
                       WHERE dl.matchid = p.match_id AND dl.code = p.code), 0) = 0
               THEN 'Missing 2nd'
               WHEN COALESCE((SELECT SUM(CASE WHEN dl.partid = '1' THEN 1 ELSE 0 END) FROM data_logs dl
                       WHERE dl.matchid = p.match_id AND dl.code = p.code), 0) = 0
                AND (SELECT SUM(CASE WHEN dl.partid = '2' THEN 1 ELSE 0 END) FROM data_logs dl
                       WHERE dl.matchid = p.match_id AND dl.code = p.code) > 0
               THEN 'Missing 1st'
               ELSE 'ok'
             END AS missing
      FROM players p
      WHERE p.assignment_date BETWEEN ?1 AND ?2
        AND (?3 = '' OR p.reviewer_name LIKE ?3 OR p.match_id LIKE ?3 OR p.code LIKE ?3)
        AND p.code IS NOT NULL AND p.code <> ''
        AND substr(p.assignment_date, 1, 10) <= COALESCE(
          (SELECT substr(MAX(review_started), 1, 10) FROM data_logs),
          '2999-12-31'
        )
    )
    WHERE missing IN ('Missing 1st', 'Missing 2nd')
      ${outerWhere}
    ORDER BY assignment_date DESC, match_id DESC
    LIMIT 2000
  `, args);
  rows.forEach(r => { r.reviewer_name = r.resolved_reviewer; r.team = r.resolved_team; });
  const TBL = 'comments_players_partial';
  await loadCommentsFor(TBL);
  renderCommentFilterBar('cmFilter_players_partial', () => loadPlayersPartial(R));
  const baseCols = [
    { key:'match_id',        label:'Match ID' },
    { key:'assignment_date', label:'Assigned', render: r => (r.assignment_date || '').slice(0,10) },
    { key:'competition',     label:'Competition' },
    { key:'home_team',       label:'Home' },
    { key:'away_team',       label:'Away' },
    { key:'task',            label:'Task' },
    { key:'side',            label:'Side' },
    { key:'code',            label:'Code' },
    { key:'reviewer_name',   label:'Reviewer' },
    { key:'team',            label:'Team' },
    { key:'missing',         label:'Missing half' },
    { key:'logs_1st',        label:'Logs 1st', num:true },
    { key:'logs_2nd',        label:'Logs 2nd', num:true },
  ];
  const { cols, rows: fr } = withComments(TBL, baseCols, rows,
    ['match_id','code','task','side'], () => loadPlayersPartial(R));
  document.getElementById('playersPartialCount').textContent = fr.length + ' rows';
  renderTable('tblPlayersPartial', cols, fr);
}

// ============================================================
// Hours — per reviewer, per day or per week
// ============================================================
async function loadHours(R) {
  const start = R.start, end = R.end;
  const like = STATE.q ? '%' + STATE.q + '%' : '';
  const ef = extraFilterSQL('a.');

  const bucketExpr = STATE.hoursGran === 'day'
    ? `substr(dl.review_started, 1, 10)`
    : `date(dl.review_started, 'weekday 0', '-7 days')`;   // Sunday start

  // JOIN data_logs to assignments to inherit team/reviewer filters
  const { rows } = await query(`
    SELECT a.code AS code, a.reviewer_name AS reviewer_name, a.team AS team,
           ${bucketExpr} AS bucket,
           SUM(dl.actual_time_taken)  AS actual,
           SUM(dl.total_break_time)   AS break_time,
           SUM(dl.total_time_taken)   AS total,
           COUNT(DISTINCT a.match_id) AS matches
    FROM assignments a
    JOIN data_logs dl ON dl.matchid = a.match_id AND dl.code = a.code
    WHERE a.assignment_date BETWEEN ?1 AND ?2
      AND (?3 = '' OR a.reviewer_name LIKE ?3 OR a.match_id LIKE ?3 OR a.task LIKE ?3 OR a.code LIKE ?3)
      ${ef.sql}
    GROUP BY a.code, a.reviewer_name, a.team, bucket
    ORDER BY bucket DESC, actual DESC
    LIMIT 5000
  `, [start, end, like, ...ef.args]);

  document.getElementById('hoursCount').textContent = rows.length + ' rows';
  renderTable('tblHours', [
    { key:'bucket',         label: STATE.hoursGran === 'day' ? 'Day' : 'Week (Sun)' },
    { key:'code',           label:'Code' },
    { key:'reviewer_name',  label:'Reviewer' },
    { key:'team',           label:'Team' },
    { key:'matches',        label:'Matches',   num:true },
    { key:'actual',         label:'Actual',    num:true, render: r => minToHM(r.actual) },
    { key:'break_time',     label:'Break',     num:true, render: r => minToHM(r.break_time) },
    { key:'total',          label:'Total',     num:true, render: r => minToHM(r.total) },
  ], rows);
}

// ============================================================
// CSV Import
// ============================================================
const IMPORT_CONFIG = {
  assignments: {
    // DB columns to write; source column looked up case+punct-insensitive
    dbCols: ['match_id','app','code','task','half','side','reviewer_name','team','competition',
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
  players: {
    dbCols: ['match_id','code','task','half','side','reviewer_name','team',
             'competition','home_team','away_team','assignment_date','app'],
    aliases: {
      side: 'Side',
      assignment_date: 'review_date',
    },
    constants: { task: 'Players New Players', half: 'Both', app: 'tornado' },
    requiredCols: ['match_id', 'code'],
  },
  bc_review: {
    dbCols: ['match_id','code','task','half','side','reviewer_name','team',
             'competition','home_team','away_team','assignment_date','app'],
    aliases: {
      match_id: 'Match ID',
      code: 'Reviewer Code',
      reviewer_name: 'Reviewer Name',
      assignment_date: 'Review Date',
      half: 'part id',
    },
    constants: { task: 'B - C Review', side: 'Both', app: 'tornado' },
    valueTransforms: {
      half: v => {
        const s = String(v == null ? '' : v).trim();
        if (s === '1') return '1st';
        if (s === '2') return '2nd';
        return s;
      },
    },
    requiredCols: ['match_id', 'code'],
  },
};
function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// Normalize date-ish cell values to ISO yyyy-mm-dd (or yyyy-mm-ddTHH:MM:SS).
// Handles: 'YYYY-MM-DD', 'M/D/YYYY', 'MM/DD/YYYY', with optional time.
// Anything unrecognized → original string.
// Force canonical form: 'YYYY-MM-DD' (date-only) or 'YYYY-MM-DDTHH:MM:SS'.
// Accepts inputs like:
//   2026-08-06T09:02:00, 2026-08-01 10:48, 2026-08-01,
//   8/6/2026 9:02:00 AM, 8/6/2026 09:02, 8/6/2026
function normalizeDate(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';

  // ISO-shape (with T or space separator, optional seconds)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const y  = m[1], mo = m[2], d = m[3];
    if (!m[4]) return `${y}-${mo}-${d}`;
    const h  = String(parseInt(m[4], 10)).padStart(2, '0');
    const mi = m[5];
    const se = m[6] || '00';
    return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  }

  // M/D/YYYY [H:MM[:SS] [AM/PM]] — US Sheets format
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    const yyyy = m[3];
    const mo = m[1].padStart(2, '0');
    const d  = m[2].padStart(2, '0');
    if (!m[4]) return `${yyyy}-${mo}-${d}`;
    let h = parseInt(m[4], 10);
    const mi = m[5];
    const se = m[6] || '00';
    const ampm = (m[7] || '').toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return `${yyyy}-${mo}-${d}T${String(h).padStart(2, '0')}:${mi}:${se}`;
  }

  return s;
}

// Column-name → is-this-a-date? — used to decide whether to normalize.
function isDateColName(name) {
  return /(_date|_started|_ended|last_modified)$/i.test(name);
}

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
  if (token) setAdminToken(token);
  const fileInput = document.getElementById('impFile');
  const cfg = IMPORT_CONFIG[tableName];
  if (!token) { impLog('Missing admin token.', 'err'); return; }
  if (!fileInput.files.length) { impLog('No file selected.', 'err'); return; }

  const file = fileInput.files[0];
  impLog('Reading ' + file.name + ' (' + Math.round(file.size/1024) + ' KB)…');
  const text = await file.text();
  let rows = parseCSV(text);
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
  // INSERT OR IGNORE: same PK → skip. Prevents overwrites on repeat uploads.
  const sql = `INSERT OR IGNORE INTO ${tableName} (${colList}) VALUES (${qMarks})`;

  // Pre-filter: drop rows where any requiredCol is empty.
  const requiredCols = cfg.requiredCols || [];
  let skippedRequired = 0;
  if (requiredCols.length) {
    const before = rows.length;
    rows = rows.filter(row => {
      for (const c of requiredCols) {
        const j = mapping[c];
        const v = (j != null && j < row.length) ? String(row[j] || '').trim() : '';
        if (!v) return false;
      }
      return true;
    });
    skippedRequired = before - rows.length;
    if (skippedRequired) impLog(`Skipped ${skippedRequired} rows w/ missing required cols: ${requiredCols.join(', ')}`);
  }

  const BATCH = 500;
  let pushed = 0, failed = 0;
  const t0 = performance.now();
  const importTs = new Date().toISOString();
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const constants  = cfg.constants || {};
    const transforms = cfg.valueTransforms || {};
    const computed   = cfg.computedCols || {};
    const statements = slice.map(row => {
      const rowByCol = (colName) => {
        const jj = mapping[colName];
        return (jj != null && jj < row.length) ? row[jj] : '';
      };
      return {
        sql,
        args: cfg.dbCols.map(c => {
          const j = mapping[c];
          let v = (j != null && j < row.length) ? row[j] : '';
          // Value transform (e.g. part id → 1st/2nd)
          if (transforms[c]) v = transforms[c](v);
          // Constant fill when CSV has no value for that col
          if ((v === '' || v == null) && constants[c] != null) v = constants[c];
          // Computed col (e.g. review_date derived from review_started)
          if ((v === '' || v == null) && computed[c]) v = computed[c](rowByCol);
          // Normalize known date columns to ISO — fixes M/D/YYYY → YYYY-MM-DD.
          if (isDateColName(c)) v = normalizeDate(v);
          // Auto-fill last_modified when CSV doesn't provide it.
          if (c === 'last_modified' && (v === '' || v == null)) v = importTs;
          return v;
        }),
      };
    });
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
  if (token) setAdminToken(token);
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
// Auto-fill token from localStorage on page load
(() => {
  const t = getAdminToken();
  const inp = document.getElementById('impToken');
  if (t && inp && !inp.value) inp.value = t;
})();
document.getElementById('impClear').addEventListener('click', () => wipeTable().catch(e => impLog(e.message, 'err')));

// Initial load
refresh();
