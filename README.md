# Reviewer ART Tracker (Apps Script Web App)

Shows how much time each reviewer spent on every match, per assignment row.

## Files

- `Code.gs` — server-side Apps Script
- `Index.html` — client UI (search, filter, sort, CSV export)

## Data sources (three separate Google Sheets)

| Purpose | Spreadsheet | Tab | ID |
|---------|-------------|-----|----|
| Code lives here + expected times | **ART Web App \| Source** (bound) | `Productivity Config` | *(bound)* |
| Assignments | **A Review Archive 2026** | `Importrange` | `1LrQa1PBQEykOrCt7CaYBT-BrJvfJaU7pRTdyQgzqUE0` |
| Reviewer time logs | **ART _ Web App - Data** | `Data` | `1lsoF3dezcBpf2EF175nDJZGVLxEcYKPFlS_xk-AvykM` |

## Setup

1. Open the bound spreadsheet (**ART Web App | Source**) → Extensions → Apps Script.
2. Create files:
   - `Code.gs` — paste contents of `Code.gs`
   - `Index.html` — File → New → HTML file named `Index`, paste contents of `Index.html`
3. Verify the `CFG` block at the top of `Code.gs` — IDs above should match.
4. Deploy → **New deployment** → Web app:
   - Execute as: **Me**
   - Access: whoever you want (Anyone in Hudl / specific users)
5. First run prompts scopes: SpreadsheetApp, external spreadsheet, cache.
6. Any code change → **Deploy → Manage deployments → pencil → Version = New version → Deploy** (otherwise the old URL keeps serving stale code).

## Productivity Config tab format

Two columns expected:

| Task | Expected minutes |
|------|------------------|
| A-Review | 90 |
| Player ID | 30 |
| Hypercare | 45 |
| … | … |

Header row is auto-detected (skipped if second col is non-numeric). Task names must match Importrange `task` column exactly (case-sensitive).

## Output columns

`match_id`, `priority`, `competition`, `home_team`, `away_team`, `task`, `half`, `side`, `code`, `reviewer_name`, `team`, `assignment_date`, `review_date`, `actual_time`, `break_time`, `total_time`, `assigned_tasks`, `expected_time`, `diff_time`, `notes`.

- `review_date` = earliest `review_started` from the Data logs that were counted (i.e., anchor of the first half worked, ignoring rows dropped by the 24 h rule). Blank if reviewer never logged work.

## Views

Three tabs share the same server payload:

- **Rows** — default. Full assignment table, filterable by Team / Task / Reviewer / Diff / free-text. Range: **Week** only (defaults to current week).
- **Analysis** — aggregates over the chosen range. Range: **Month / Quarter / Half-year** (defaults to current month). Shows:
  - Fastest reviewer (min avg actual per match, requires ≥3 matches)
  - Total distinct matches, total actual time, over/under counts
  - Per task: match count, row count, actual sum, expected sum, avg actual per match
  - Per reviewer: same + over/under counts
  - Per month · task and per quarter · task breakdowns
- **No Logs** — assignments in the current range where the Data sheet has no rows for that `(match, code)`. Same Week picker as Rows.

Switching to Analysis auto-swaps the date picker from Week → Month; switching back auto-restores Week.

All date filters are **server-side** (based on `assignment_date`). Each fetched range is cached for 6 hours.

## Expected time scaling

`Productivity Config` contains the **full-match** expected minutes per task. Each assignment row's expected is scaled down according to what portion of the match it covers:

| Side | Half | Scale | Interpretation |
|------|------|-------|----------------|
| Both (or blank) | Both (or blank) | `/1` | whole match |
| Home / Away | Both (or blank) | `/2` | one side, both halves |
| Both (or blank) | 1st / 2nd | `/2` | both sides, one half |
| Home / Away | 1st / 2nd | `/4` | one side, one half |

When multiple tasks are assigned to the same `(match, reviewer)`, each task's scaled expected is summed. `diff_time = actual_time − scaled_expected_sum`.

## Logic notes

- **Priority**: ported from the sheet formula
  `MAP(C, D, E, LAMBDA(c, d, e, IFS(... Both / Home-Away / Home / Away / comp)))`
- **Half selection**:
  - `Half=1st` → partid 1
  - `Half=2nd` → partid 2
  - `Half=Both` (any Side — Both / Home / Away / blank) → **all** partids present for that `(match, code)` (1st, 2nd, plus 3rd/4th/5th if the reviewer worked them)
- **Start date**: `CFG.START_DATE` (default `2026-01-03`) — Importrange rows with `assignment date` before this are skipped. Set to empty string to disable.
- **24-hour rule**: per half, anchor = first `review_started`; only rows within 24 h of anchor count. Later rows → skipped from time sum, and their day-offset is added to `notes` as `Additional logs found after (X days, Y days).`
- **Multiple tasks / same match / same reviewer**: one row per assignment. `assigned_tasks` = comma-joined list of all tasks that reviewer has on that match. `actual_time` shows total match time (DB does not split time by task, so all rows for the group share it — matches the request). `expected_time` = **sum** of expected minutes across all assigned tasks. `diff_time = actual_time − expected_time` (negative = faster than expected, positive = over).
- **Empty `code`** rows in `Importrange` (unassigned) are skipped.
- **Server cache**: results cached for 10 minutes. Click **Reload data** to force refresh.

## Performance

First uncached load pays for two cross-spreadsheet reads:

- Importrange (~28k rows × 18 cols)
- Data (~81k rows × 9 cols)

Both are `SpreadsheetApp.openById(...).getValues()` calls — the slow part is the fetch, not the JavaScript. Expect **10–25 seconds** on a cold cache. Subsequent hits are served from `CacheService` and return in well under a second (default TTL: 6 hours).

The header meta bar prints per-phase timings so you can see exactly where the time goes:

`server 14.2s (imp read 5100ms, imp parse 800ms, data read 7200ms, data index 900ms, build 200ms)`

### Keep it fast — install a time trigger

`warmCurrentWeekCache_()` runs the full pipeline for the current week and stores the result in **two** places:

1. `CacheService` (10 MB quota, LRU-evicts under memory pressure)
2. A hidden `_matview` tab in the bound spreadsheet (persistent, survives cache eviction, deploys, and script restarts)

Cold-path fallback order for a current-week request:
`_matview cell` → `CacheService` → full pipeline.

The matview alone puts current-week loads at **~1 second** even without the trigger — as long as the trigger has written the matview at least once. Install the trigger to keep it fresh:

1. Apps Script editor → left rail → **Triggers** (clock icon)
2. **+ Add Trigger**
3. Choose function: `warmCurrentWeekCache_`
4. Event source: **Time-driven → Minutes timer → Every 5 minutes** (or hourly — TTL is 6 h)
5. Save. First run will re-prompt scopes.

The **Reload data** button in the UI always forces a fresh fetch (bypasses matview + cache).

## Troubleshooting

- *"Missing tab: Importrange"* → tab renamed or wrong spreadsheet ID. The error lists the actual tab names present — update `CFG.IMPORTRANGE_TAB` / `CFG.IMPORT_SHEET_ID`.
- Blank `expected_time` / `diff_time` → task name in Importrange not found in Productivity Config. Add it or fix casing.
- Row shows 0 time but has assignment → no logs in Data sheet for that `(matchid, code)`, or reviewer worked halves not selected by the rule.
- Slow first load — expected on cold cache; install the trigger above to keep the current week warm.
