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

// ============================================================
// New sources — Players & B-C Review tabs. Fill in the two gids
// after opening each tab in the sheet: the URL ends with ?gid=NNN.
// Sheet id below is the one you gave:
//   https://docs.google.com/spreadsheets/d/1FZugqc8ytCr6teAJO7e8qglW988c2U3_eQ1cAQmSIes/
// ============================================================
const EXTRA_SHEET_ID = '1FZugqc8ytCr6teAJO7e8qglW988c2U3_eQ1cAQmSIes';
const PLAYERS_GID    = 0;  // <— TODO: set to actual Players tab gid
const BC_GID         = 0;  // <— TODO: set to actual "B - C Review" tab gid

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
  {
    name: 'players',
    sheetId:  EXTRA_SHEET_ID,
    gid:      PLAYERS_GID,
    dbTable:  'players',
    dbCols:   ['match_id','code','task','half','side','reviewer_name','team',
               'competition','home_team','away_team','assignment_date','app'],
    colAliases: {
      code: 'code',
      side: 'Side',
      assignment_date: 'review_date',
    },
    constants: { task: 'Players New Players', half: 'Both', app: 'tornado' },
    // Fill reviewer_name/team/match info from existing DB rows keyed by code / match_id.
    enrichFromDb: ['reviewer_name','team','competition','home_team','away_team'],
    dateCol:  'assignment_date',
    propKey:  'sync_players_lastdate',
    rowFilter: function (rowByCol) {
      const d = toDate_(rowByCol('assignment_date'));
      if (!d) return false;
      if (d.getTime() < new Date(START_DATE + 'T00:00:00').getTime()) return false;
      return true;
    },
  },
  {
    name: 'bc_review',
    sheetId:  EXTRA_SHEET_ID,
    gid:      BC_GID,
    dbTable:  'bc_review',
    dbCols:   ['match_id','code','task','half','side','reviewer_name','team',
               'competition','home_team','away_team','assignment_date','app'],
    colAliases: {
      match_id: 'Match ID',
      code: 'Reviewer Code',
      reviewer_name: 'Reviewer Name',
      assignment_date: 'Review Date',
      half: 'part id',
    },
    constants: { task: 'B - C Review', side: 'Both', app: 'tornado' },
    valueTransforms: {
      half: function (v) {
        const s = String(v == null ? '' : v).trim();
        if (s === '1') return '1st';
        if (s === '2') return '2nd';
        return s;
      },
    },
    enrichFromDb: ['team','competition','home_team','away_team'],
    dateCol:  'assignment_date',
    propKey:  'sync_bc_lastdate',
    rowFilter: function (rowByCol) {
      const d = toDate_(rowByCol('assignment_date'));
      if (!d) return false;
      if (d.getTime() < new Date(START_DATE + 'T00:00:00').getTime()) return false;
      return true;
    },
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

  // Preload enrichment lookups if needed. One-shot Turso queries.
  if (cfg.enrichFromDb && cfg.enrichFromDb.length) {
    cfg._codeMap  = fetchCodeLookup_();      // code → {reviewer_name, team}
    cfg._matchMap = fetchMatchLookup_();     // match_id → {competition, home_team, away_team}
  }

  // Determine cutoff from Turso directly (not just local PropertiesService).
  // MAX(date column) in DB = "everything up to & including this date is
  // already synced". We push only rows STRICTLY after that.
  const props = PropertiesService.getScriptProperties();
  const localCkpt = props.getProperty(cfg.propKey);
  const dbMax = fetchDbMax_(cfg.dbTable, cfg.dateCol, cfg.dbMaxWhere);
  const cutoffStr = (dbMax && (!localCkpt || dbMax > localCkpt)) ? dbMax : (localCkpt || '1970-01-01T00:00:00.000Z');
  const lastSyncMs = new Date(cutoffStr).getTime() || 0;
  Logger.log(cfg.name + ': cutoff = ' + cutoffStr + '  (DB max=' + dbMax + ', local=' + localCkpt + ')');

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
    // Strict `<` — rows with same date as checkpoint may be re-pushed,
    // but INSERT OR IGNORE dedupes by PK. Without this, all rows sharing
    // the checkpoint date (common when date cells are date-only) get lost.
    if (dt && dt.getTime() < lastSyncMs) continue;
    if (cfg.rowFilter && !cfg.rowFilter(rowByCol(row))) continue;
    const accessor = rowByCol(row);
    toPush.push({
      row: row,
      ts: dt ? dt.getTime() : 0,
      _code: accessor('code'),
      _matchId: accessor('match_id'),
    });
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

  let pushed = 0, pushedInserted = 0, pushedIgnored = 0;
  for (let i = 0; i < toPush.length; i += 500) {
    if (Date.now() > DEADLINE_MS) {
      Logger.log(cfg.name + ': time budget hit — pushed ' + pushed +
                 ', resuming next run from ' + (props.getProperty(cfg.propKey) || 'checkpoint'));
      return;
    }

    const slice = toPush.slice(i, i + 500);
    const runTs = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss");
    const constants = cfg.constants || {};
    const transforms = cfg.valueTransforms || {};
    const stmts = slice.map(function (item) {
      const args = cfg.dbCols.map(function (c) {
        const j = col(c);
        let v = (j >= 0) ? item.row[j] : '';

        // 1) Sheet value first
        // 2) Per-column value transform (e.g. part id → 1st/2nd)
        if (transforms[c]) v = transforms[c](v);
        // 3) Auto-fill last_modified
        if (c === 'last_modified' && (j < 0 || v === '' || v == null)) v = runTs;
        // 4) Constants when the sheet has no value
        if ((v === '' || v == null) && constants[c] != null) v = constants[c];
        // 5) Enrich from DB (reviewer_name/team/competition/etc.)
        if ((v === '' || v == null) && cfg.enrichFromDb && cfg.enrichFromDb.indexOf(c) !== -1) {
          v = enrichLookup_(cfg, item, c);
        }

        const isDateCol = /(_date|_started|_ended)$/.test(c) || c === 'last_modified';
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

    // Count actual inserts vs ignores from Turso's response.
    let inserted = 0;
    try {
      const j = JSON.parse(res.getContentText());
      (j.results || []).forEach(function (r) {
        const n = r?.response?.result?.affected_row_count;
        if (typeof n === 'number') inserted += n;
      });
    } catch (_) {}
    const ignored = slice.length - inserted;

    // Advance checkpoint to this batch's max ts. If EVERY row in the batch
    // was ignored (all PKs already in DB), push checkpoint +1s so the next
    // run skips these same-ts rows and moves forward.
    const batchMaxTs = slice[slice.length - 1].ts;
    if (batchMaxTs > 0) {
      const advanceMs = (inserted === 0 && slice.length > 0) ? batchMaxTs + 1000 : batchMaxTs;
      props.setProperty(cfg.propKey, new Date(advanceMs).toISOString());
    }
    pushed += slice.length;
    pushedInserted += inserted;
    pushedIgnored  += ignored;
  }

  Logger.log(cfg.name + ': attempted ' + pushed + ' (inserted=' + pushedInserted +
             ', ignored=' + pushedIgnored + ') in ' +
             ((Date.now() - started) / 1000).toFixed(1) + 's');
}

// ============================================================
// Utils
// ============================================================
// Query Turso for MAX(dateCol) in the target table. Return '' if error/empty.
// Used as "everything up to here is already in DB" cutoff. Optional WHERE
// scopes the max to a subset (e.g. task = 'Players New Players').
function fetchDbMax_(table, dateCol, whereClause) {
  try {
    const sql = 'SELECT MAX(' + dateCol + ') AS mx FROM ' + table +
                (whereClause ? ' WHERE ' + whereClause : '');
    const body = {
      requests: [
        { type: 'execute', stmt: { sql: sql } },
        { type: 'close' },
      ],
    };
    const res = UrlFetchApp.fetch(TURSO_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + TURSO_TOKEN },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 300) return '';
    const j = JSON.parse(res.getContentText());
    const cell = j.results?.[0]?.response?.result?.rows?.[0]?.[0];
    if (!cell || cell.type === 'null') return '';
    return String(cell.value || '');
  } catch (e) {
    Logger.log('fetchDbMax_ failed: ' + e.message);
    return '';
  }
}

// Pull a lookup table from Turso via HTTP API.
function fetchLookup_(sql, keyCol) {
  const body = {
    requests: [
      { type: 'execute', stmt: { sql: sql } },
      { type: 'close' },
    ],
  };
  const res = UrlFetchApp.fetch(TURSO_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + TURSO_TOKEN },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) return {};
  const j = JSON.parse(res.getContentText());
  const result = j?.results?.[0]?.response?.result;
  if (!result) return {};
  const cols = result.cols.map(function (c) { return c.name; });
  const rows = result.rows || [];
  const keyIdx = cols.indexOf(keyCol);
  const out = {};
  rows.forEach(function (row) {
    const key = String(row[keyIdx]?.value || '');
    if (!key) return;
    if (out[key]) return;   // first-write-wins
    const obj = {};
    cols.forEach(function (c, i) { obj[c] = row[i]?.value ?? null; });
    out[key] = obj;
  });
  return out;
}

// Most-frequent reviewer_name + team per code.
function fetchCodeLookup_() {
  return fetchLookup_(
    "SELECT code, " +
    "  (SELECT reviewer_name FROM assignments WHERE code = a.code " +
    "     AND reviewer_name IS NOT NULL AND reviewer_name <> '' " +
    "     GROUP BY reviewer_name ORDER BY COUNT(*) DESC LIMIT 1) AS reviewer_name, " +
    "  (SELECT team FROM assignments WHERE code = a.code " +
    "     AND team IS NOT NULL AND team <> '' " +
    "     GROUP BY team ORDER BY COUNT(*) DESC LIMIT 1) AS team " +
    "FROM assignments a WHERE code IS NOT NULL AND code <> '' GROUP BY code",
    'code'
  );
}

// Competition + team names per match_id (one row per match).
function fetchMatchLookup_() {
  return fetchLookup_(
    "SELECT match_id, " +
    "  MAX(competition) AS competition, " +
    "  MAX(home_team) AS home_team, " +
    "  MAX(away_team) AS away_team " +
    "FROM assignments WHERE match_id IS NOT NULL AND match_id <> '' GROUP BY match_id",
    'match_id'
  );
}

// Row-value enricher — pull a missing column from the code or match lookup.
function enrichLookup_(cfg, item, dbCol) {
  const rowByCol = function (dbColName) {
    // Inline copy of the accessor from syncOne_ — safe subset.
    return '';   // stub; real access done in syncOne_ scope below
  };
  // We need real access — use item.row + closure. Because enrichLookup_ is
  // called inside the args map where `col` is in scope, we can accept keys
  // via a small map passed on item itself.
  // Prefer the code map for reviewer_name/team, match map for competition/home/away.
  const codeMap  = cfg._codeMap  || {};
  const matchMap = cfg._matchMap || {};
  const code    = item._code    || '';
  const matchId = item._matchId || '';
  if (dbCol === 'reviewer_name' || dbCol === 'team') {
    const r = codeMap[String(code || '').trim()];
    if (r && r[dbCol]) return r[dbCol];
  }
  if (dbCol === 'competition' || dbCol === 'home_team' || dbCol === 'away_team') {
    const r = matchMap[String(matchId || '').trim()];
    if (r && r[dbCol]) return r[dbCol];
  }
  return '';
}

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
