// Cloudflare Worker — Supabase backend
// SELECT queries → run_query RPC
// Writes (import, comments) → run_write RPC
// Both protected by service role key server-side; admin writes also require X-Admin-Token.

export default {
  async fetch(request, env) {
    try {
    const url = new URL(request.url);

    // ── Supabase helpers ──────────────────────────────────────────────────────
    const SB = (path, body) => fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
      },
      body: JSON.stringify(body),
    });

    // Replace bare ? with ?1, ?2 ... (comments SQL uses bare ?)
    function numberParams(sql) {
      let i = 0;
      return sql.replace(/\?(?!\d)/g, () => '?' + (++i));
    }

    // Table PKs for upsert
    const TABLE_PKS = {
      assignments:            ['match_id','code','task','half','side'],
      players:                ['match_id','side'],
      bc_review:              ['match_id','half'],
      quality_delivery_time:  ['matchid'],
      data_logs:              ['matchid','hr_code','partid','review_started','review_ended'],
    };

    // SQLite → PostgreSQL upsert patch
    function pgSql(sql) {
      const clean = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO').replace(/;\s*$/, '');
      const m = clean.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/i);
      if (m) {
        const table = m[1].toLowerCase();
        const pks   = TABLE_PKS[table];
        if (pks) {
          const cols    = m[2].split(',').map(c => c.trim());
          const nonPks  = cols.filter(c => !pks.includes(c));
          if (nonPks.length) {
            const sets = nonPks.map(c => `${c} = EXCLUDED.${c}`).join(', ');
            return `${clean} ON CONFLICT (${pks.join(',')}) DO UPDATE SET ${sets}`;
          }
        }
      }
      return clean + ' ON CONFLICT DO NOTHING';
    }

    async function sbQuery(sql, args = []) {
      const r = await SB('rpc/run_query', { query_text: sql, args: args.map(String) });
      if (!r.ok) return { error: await r.text() };
      const rows = await r.json();
      return { rows: Array.isArray(rows) ? rows : [] };
    }

    async function sbWrite(sql, args = []) {
      const r = await SB('rpc/run_write', { query_text: numberParams(sql), args: args.map(String) });
      if (!r.ok) return { error: await r.text() };
      return await r.json();
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── /api/import — bulk CSV insert (admin-gated) ───────────────────────────
    if (url.pathname === '/api/import' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!env.ADMIN_TOKEN) return new Response('ADMIN_TOKEN not configured', { status: 500 });
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });

      const { statements } = await request.json();
      if (!Array.isArray(statements) || !statements.length)
        return Response.json({ error: 'no statements' }, { status: 400 });

      let errors = 0;
      for (const s of statements) {
        const res = await sbWrite(pgSql(s.sql), s.args || []);
        if (res.error) errors++;
      }
      if (errors) return Response.json({ error: `${errors} of ${statements.length} statements failed` }, { status: 500 });
      return Response.json({ ok: true, pushed: statements.length });
    }

    // ── /api/comment — full upsert incl. status (admin-gated) ────────────────
    if (url.pathname === '/api/comment' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!env.ADMIN_TOKEN) return new Response('ADMIN_TOKEN not configured', { status: 500 });
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });

      const { table, row_key, row_data, author, comment, status } = await request.json();
      if (!COMMENT_TABLES.has(table)) return Response.json({ error: 'bad table' }, { status: 400 });
      if (!row_key) return Response.json({ error: 'row_key required' }, { status: 400 });

      const now = new Date().toISOString();
      const sql = `INSERT INTO ${table} (row_key,row_data,author,comment,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(row_key) DO UPDATE SET
                     row_data   = EXCLUDED.row_data,
                     author     = EXCLUDED.author,
                     comment    = EXCLUDED.comment,
                     status     = EXCLUDED.status,
                     updated_at = EXCLUDED.updated_at`;
      const args = [row_key, JSON.stringify(row_data || {}), author || '', comment || '', status || '', now, now];
      const res = await sbWrite(sql, args);
      if (res.error) return Response.json({ error: res.error }, { status: 500 });
      return Response.json({ ok: true, updated_at: now });
    }

    // ── /api/comment/note — public note upsert, no status change ─────────────
    if (url.pathname === '/api/comment/note' && request.method === 'POST') {
      const { table, row_key, row_data, author, comment } = await request.json();
      if (!COMMENT_TABLES.has(table)) return Response.json({ error: 'bad table' }, { status: 400 });
      if (!row_key) return Response.json({ error: 'row_key required' }, { status: 400 });
      if (!author || !comment) return Response.json({ error: 'author + comment required' }, { status: 400 });

      const now = new Date().toISOString();
      const sql = `INSERT INTO ${table} (row_key,row_data,author,comment,status,created_at,updated_at)
                   VALUES (?,?,?,?,'',?,?)
                   ON CONFLICT(row_key) DO UPDATE SET
                     row_data   = EXCLUDED.row_data,
                     author     = EXCLUDED.author,
                     comment    = EXCLUDED.comment,
                     updated_at = EXCLUDED.updated_at`;
      const args = [row_key, JSON.stringify(row_data || {}), author, comment, now, now];
      const res = await sbWrite(sql, args);
      if (res.error) return Response.json({ error: res.error }, { status: 500 });
      return Response.json({ ok: true, updated_at: now });
    }

    // ── /api/comment/delete ───────────────────────────────────────────────────
    if (url.pathname === '/api/comment/delete' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });

      const { table, row_key } = await request.json();
      if (!COMMENT_TABLES.has(table) || !row_key)
        return Response.json({ error: 'bad request' }, { status: 400 });

      const res = await sbWrite(`DELETE FROM ${table} WHERE row_key = ?`, [row_key]);
      if (res.error) return Response.json({ error: res.error }, { status: 500 });
      return Response.json({ ok: true });
    }

    // ── /api/query — read-only SELECT (public) ────────────────────────────────
    if (url.pathname === '/api/query' && request.method === 'POST') {
      const { sql, args = [] } = await request.json();
      if (!/^\s*(select|with)/i.test(sql))
        return new Response('read-only', { status: 400 });

      const { rows, error } = await sbQuery(sql, args);
      if (error) return Response.json({ error }, { status: 500 });
      const cols = rows.length ? Object.keys(rows[0]) : [];
      return Response.json({ cols, rows });
    }

    return env.ASSETS.fetch(request);
    } catch(e) {
      return Response.json({ crashed: true, error: e.message, stack: e.stack }, { status: 500 });
    }
  },
};

const COMMENT_TABLES = new Set([
  'comments_nologs', 'comments_partial',
  'comments_players_nologs', 'comments_bc_nologs', 'comments_players_partial',
  'comments_assignments', 'comments_players_assignments', 'comments_bc_assignments',
]);
