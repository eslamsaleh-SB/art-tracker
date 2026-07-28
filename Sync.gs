// ============================================================
// CONFIG — paste your Turso URL + token here
// ============================================================
// If Turso gave you libsql://xxx.turso.io , convert to:
//   https://xxx.turso.io/v2/pipeline
const TURSO_URL   = 'https://art-tracker-eslamsaleh-sb.aws-eu-west-1.turso.io/v2/pipeline';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODQ4NjAwMjMsImlkIjoiMDE5ZjkxZDUtYTIwMS03YjIwLTlkY2UtOTYyZjAzOTBhMjlkIiwia2lkIjoiTk5ndWEtc0k0SVVsVDRtdFpwMnpyemRKbldhQXczZTZuLXgtVGNGVExLVSIsInJpZCI6IjBkNDI5NjFjLTljNTItNGU1Ni05MmMzLTM3OGIyMWFkYzU0MSJ9.6iYZaILhAaGZ_1TI-_91XjfvLu7hzKBAuttydI0oDAOF4cue0G9OpBacwTps6Ha2eP5Rg_5siNKBflHV656NCA';

// ============================================================
// Source spreadsheets — sheet ID + tab (by gid) + column mapping.
// dbCols are the DB column names; source header names are matched
// case- and punctuation-insensitively (e.g. "assignment date"
// matches "assignment_date").
// ============================================================
// Global filters — applied only to `assignments` source (per row).
const START_DATE  = '2026-01-03';    // skip rows with assignment_date < this
const EXCLUDE_APP = 'umbrella';      // skip rows with app = this (case-insensitive)

const SOURCES = [
  {
    name: 'assignments',
    sheetId:  '1ihn9pm3yNaBVb0tRTFTUaBgFpeCtzRb6ugCS4CmWZ04',
    gid:      1474561682,
    dbTable:  'assignments',
    dbCols:   ['match_id','app','code','task','half','side','reviewer_name','team','competition',
               'home_team','away_team','home_priority','away_priority','comp_priority',
               'match_date','sla','assignment_date','last_modified'],
    dateCol:  'assignment_date',
    propKey:  'sync_assignments_lastdate',
    // Row-level filter — returns true to KEEP the row, false to skip.
    rowFilter: function (rowByCol) {
      const dRaw = rowByCol('assignment_date');
      const d = toDate_(dRaw);
      if (!d) return false; // no valid date → skip
      if (d.getTime() < new Date(START_DATE + 'T00:00:00').getTime()) return false;
      const app = String(rowByCol('app') || '').trim().toLowerCase();
      if (app === EXCLUDE_APP) return false;
      return true;
    },
  },
  {
    name: 'data_logs',
    sheetId:  '1lsoF3dezcBpf2EF175nDJZGVLxEcYKPFlS_xk-AvykM',
    gid:      0,
    dbTable:  'data_logs',
    dbCols:   ['matchid','code','partid','full_name','review_started','review_ended',
               'actual_time_taken','total_break_time','total_time_taken'],
    // Map DB column name → source sheet header when they differ.
    // Source uses `hr_code`; DB uses `code`. Normalizer alone can't bridge
    // that (hrcode ≠ code), so we alias explicitly.
    colAliases: { code: 'hr_code' },
    dateCol:  'review_started',
    propKey:  'sync_datalogs_lastdate',
  },
];

// ============================================================
// Public entry points
// ============================================================
function syncAll() {
  SOURCES.forEach(function (cfg) {
    try { syncOne_(cfg); }
    catch (e) { Logger.log(cfg.name + ' FAILED: ' + e.message); }
  });
}

// Wipes checkpoints so the next syncAll re-pushes everything.
function resetSyncCheckpoints() {
  const p = PropertiesService.getScriptProperties();
  SOURCES.forEach(function (c) { p.deleteProperty(c.propKey); });
  Logger.log('Checkpoints cleared — next syncAll will full-load.');
}

// ============================================================
// Per-source sync
// ============================================================
function syncOne_(cfg) {
  const started = Date.now();
  const ss = SpreadsheetApp.openById(cfg.sheetId);
  const sh = getSheetByGid_(ss, cfg.gid);
  if (!sh) throw new Error('Tab gid ' + cfg.gid + ' not found in sheet ' + cfg.sheetId);

  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) { Logger.log(cfg.name + ': empty tab'); return; }
  const header = vals.shift().map(function (h) { return String(h || '').trim(); });

  // Header → column-index lookup. Match exact, then fall back to
  // a normalized key (lowercase, alphanumerics only). So the source
  // column "assignment date" matches the DB column "assignment_date",
  // "SLA" matches "sla", "Match Type" matches "match_type", etc.
  const idxExact = {}, idxNorm = {};
  header.forEach(function (h, i) {
    idxExact[h] = i;
    idxNorm[normKey_(h)] = i;
  });
  const aliases = cfg.colAliases || {};
  function col(name) {
    // 1) explicit alias from config (DB col → source col)
    if (aliases[name]) {
      const a = aliases[name];
      if (a in idxExact) return idxExact[a];
      const an = normKey_(a);
      if (an in idxNorm) return idxNorm[an];
    }
    // 2) exact header match
    if (name in idxExact) return idxExact[name];
    // 3) normalized (case + punctuation insensitive)
    const n = normKey_(name);
    if (n in idxNorm) return idxNorm[n];
    return -1;
  }

  const dateIdx = col(cfg.dateCol);
  if (dateIdx < 0) {
    throw new Error(cfg.name + ': date column "' + cfg.dateCol +
                    '" not in header: ' + header.join(', '));
  }

  const props = PropertiesService.getScriptProperties();
  const lastSyncStr = props.getProperty(cfg.propKey) || '1970-01-01T00:00:00.000Z';
  const lastSyncMs = new Date(lastSyncStr).getTime() || 0;

  // Row-value accessor for filter fn — looks up by DB col name.
  const rowByCol = function (row) {
    return function (dbColName) {
      const j = col(dbColName);
      return (j >= 0) ? row[j] : '';
    };
  };

  // Filter rows: newer than checkpoint + optional per-source rowFilter.
  // SORT ASCENDING by date so partial progress is stable.
  const toPush = [];
  for (let i = 0; i < vals.length; i++) {
    const row = vals[i];
    const dt  = toDate_(row[dateIdx]);
    if (dt && dt.getTime() <= lastSyncMs) continue;
    if (cfg.rowFilter && !cfg.rowFilter(rowByCol(row))) continue;
    toPush.push({ row: row, ts: dt ? dt.getTime() : 0 });
  }
  if (!toPush.length) { Logger.log(cfg.name + ': nothing new'); return; }
  toPush.sort(function (a, b) { return a.ts - b.ts; });

  // Time budget: Apps Script kills execution at ~6 min. Bail early at
  // 5 min so the checkpoint we just wrote survives.
  const DEADLINE_MS = started + 5 * 60 * 1000;

  const colList = cfg.dbCols.join(',');
  const qMarks  = cfg.dbCols.map(function () { return '?'; }).join(',');
  // INSERT OR IGNORE — if PK already exists in DB, skip the row entirely
  // (existing row unchanged). Prevents re-writes on repeat sync.
  const sqlStr  = 'INSERT OR IGNORE INTO ' + cfg.dbTable + ' (' + colList + ') VALUES (' + qMarks + ')';

  let pushed = 0;
  for (let i = 0; i < toPush.length; i += 500) {
    if (Date.now() > DEADLINE_MS) {
      Logger.log(cfg.name + ': time budget hit — pushed ' + pushed +
                 ', resuming next run from ' + (props.getProperty(cfg.propKey) || 'checkpoint'));
      return;
    }

    const slice = toPush.slice(i, i + 500);
    const runTs = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    const stmts = slice.map(function (item) {
      const args = cfg.dbCols.map(function (c) {
        const j = col(c);
        let v = (j >= 0) ? item.row[j] : '';
        if (c === 'last_modified' && (j < 0 || v === '' || v == null)) v = runTs;
        // Route by column semantics:
        //   date-shaped columns → cellToStr_ (with year guard)
        //   everything else     → plainStr_ (no date parsing — never
        //                         convert a Date object into a code)
        const isDateCol =
          /(_date|_started|_ended)$/.test(c) || c === 'last_modified';
        const val = isDateCol ? cellToStr_(v) : plainStr_(v);
        return { type: 'text', value: val };
      });
      return { type: 'execute', stmt: { sql: sqlStr, args: args } };
    }).concat([{ type: 'close' }]);

    const res = UrlFetchApp.fetch(TURSO_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + TURSO_TOKEN },
      payload: JSON.stringify({ requests: stmts }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code >= 300) {
      throw new Error('HTTP ' + code + ' — ' + res.getContentText().slice(0, 500));
    }

    // Save checkpoint at THIS batch's max date so a timeout on the next
    // batch doesn't lose progress.
    const batchMaxTs = slice[slice.length - 1].ts;
    if (batchMaxTs > 0) {
      props.setProperty(cfg.propKey, new Date(batchMaxTs).toISOString());
    }
    pushed += slice.length;
  }

  Logger.log(cfg.name + ': pushed ' + pushed + ' in ' +
             ((Date.now() - started) / 1000).toFixed(1) + 's');
}

// ============================================================
// Utils
// ============================================================
function getSheetByGid_(ss, gid) {
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}
function normKey_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function toDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
// For non-date columns (code, task, reviewer_name, etc.).
// If Sheets returned a Date object (auto-parsed a bad cell), drop it —
// there's no valid string content in that Date to preserve.
function plainStr_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return '';
  return String(v).trim();
}

function cellToStr_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    if (y < 1900 || y > 2100) return '';   // out-of-range → discard
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
  }
  const s = String(v).trim();
  if (!s) return '';
  // Only normalize obvious ISO-looking dates. Anything else stays as text —
  // avoids `new Date()` parsing e.g. "12/29/39" as year 39/639.
  if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) {
    const d = new Date(s.replace(' ', 'T'));
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      if (y >= 1900 && y <= 2100) {
        return Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
      }
    }
  }
  return s;
}
