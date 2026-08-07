// Cloudflare Worker — routes /api/query to Turso, serves static assets otherwise.
// Only SELECT / WITH queries accepted. Auth token stays server-side.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- CSV / bulk-write endpoint (admin-token gated) --------------------
    // Accepts { statements: [{sql, args}, ...] } — used by the Import page
    // to run batched INSERT statements. Requires X-Admin-Token header
    // matching env.ADMIN_TOKEN.
    if (url.pathname === '/api/import' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!env.ADMIN_TOKEN) return new Response('ADMIN_TOKEN not configured on worker', { status: 500 });
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });
      const { statements } = await request.json();
      if (!Array.isArray(statements) || !statements.length) {
        return Response.json({ error: 'no statements' }, { status: 400 });
      }
      const body = {
        requests: statements.map(s => ({
          type: 'execute',
          stmt: {
            sql: s.sql,
            args: (s.args || []).map(v => ({ type: 'text', value: v == null ? '' : String(v) })),
          },
        })).concat([{ type: 'close' }]),
      };
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.TURSO_TOKEN,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok || j.results?.some(x => x.type === 'error')) {
        return Response.json({ error: j }, { status: 500 });
      }
      return Response.json({ ok: true, pushed: statements.length });
    }

    // ---- Comments endpoint — INSERT OR REPLACE into one of the 5 comment tables.
    if (url.pathname === '/api/comment' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!env.ADMIN_TOKEN) return new Response('ADMIN_TOKEN not configured', { status: 500 });
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });
      const { table, row_key, row_data, author, comment, status } = await request.json();
      const ALLOWED = new Set([
        'comments_nologs','comments_partial',
        'comments_players_nologs','comments_bc_nologs','comments_players_partial',
      ]);
      if (!ALLOWED.has(table)) return Response.json({ error: 'bad table' }, { status: 400 });
      if (!row_key) return Response.json({ error: 'row_key required' }, { status: 400 });
      const now = new Date().toISOString();
      // Upsert w/ preserved created_at when updating existing row
      const sql = `INSERT INTO ${table} (row_key,row_data,author,comment,status,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(row_key) DO UPDATE SET
                     row_data = excluded.row_data,
                     author   = excluded.author,
                     comment  = excluded.comment,
                     status   = excluded.status,
                     updated_at = excluded.updated_at`;
      const args = [row_key, JSON.stringify(row_data || {}), author || '', comment || '', status || '', now, now]
                     .map(v => ({ type: 'text', value: String(v == null ? '' : v) }));
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TURSO_TOKEN },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }] }),
      });
      const j = await r.json();
      if (!r.ok || j.results?.some(x => x.type === 'error')) {
        return Response.json({ error: j }, { status: 500 });
      }
      return Response.json({ ok: true, updated_at: now });
    }

    // ---- Public note endpoint — updates comment + author only, no status.
    // No admin token required. Preserves existing status on update.
    if (url.pathname === '/api/comment/note' && request.method === 'POST') {
      const { table, row_key, row_data, author, comment } = await request.json();
      const ALLOWED = new Set([
        'comments_nologs','comments_partial',
        'comments_players_nologs','comments_bc_nologs','comments_players_partial',
      ]);
      if (!ALLOWED.has(table)) return Response.json({ error: 'bad table' }, { status: 400 });
      if (!row_key) return Response.json({ error: 'row_key required' }, { status: 400 });
      if (!author || !comment) return Response.json({ error: 'author + comment required' }, { status: 400 });
      const now = new Date().toISOString();
      // Upsert: on conflict update only comment/author/row_data/updated_at — leave status alone
      const sql = `INSERT INTO ${table} (row_key,row_data,author,comment,status,created_at,updated_at)
                   VALUES (?,?,?,?,'',?,?)
                   ON CONFLICT(row_key) DO UPDATE SET
                     row_data = excluded.row_data,
                     author   = excluded.author,
                     comment  = excluded.comment,
                     updated_at = excluded.updated_at`;
      const args = [row_key, JSON.stringify(row_data || {}), author, comment, now, now]
                     .map(v => ({ type: 'text', value: String(v == null ? '' : v) }));
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TURSO_TOKEN },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }, { type: 'close' }] }),
      });
      const j = await r.json();
      if (!r.ok || j.results?.some(x => x.type === 'error')) return Response.json({ error: j }, { status: 500 });
      return Response.json({ ok: true, updated_at: now });
    }

    // ---- Comment delete
    if (url.pathname === '/api/comment/delete' && request.method === 'POST') {
      const token = request.headers.get('X-Admin-Token');
      if (!token || token !== env.ADMIN_TOKEN) return new Response('unauthorized', { status: 401 });
      const { table, row_key } = await request.json();
      const ALLOWED = new Set([
        'comments_nologs','comments_partial',
        'comments_players_nologs','comments_bc_nologs','comments_players_partial',
      ]);
      if (!ALLOWED.has(table) || !row_key) return Response.json({ error: 'bad request' }, { status: 400 });
      const sql = `DELETE FROM ${table} WHERE row_key = ?`;
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TURSO_TOKEN },
        body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: [{ type: 'text', value: row_key }] } }, { type: 'close' }] }),
      });
      const j = await r.json();
      if (!r.ok || j.results?.some(x => x.type === 'error')) return Response.json({ error: j }, { status: 500 });
      return Response.json({ ok: true });
    }

    if (url.pathname === '/api/query' && request.method === 'POST') {
      const { sql, args = [] } = await request.json();
      if (!/^\s*(select|with)/i.test(sql)) {
        return new Response('read-only', { status: 400 });
      }
      const body = {
        requests: [
          { type: 'execute', stmt: {
              sql,
              args: args.map(v => ({ type: 'text', value: v == null ? '' : String(v) })),
          }},
          { type: 'close' },
        ],
      };
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.TURSO_TOKEN,
        },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      const exec = j.results?.[0]?.response?.result;
      if (!exec) return Response.json({ error: j }, { status: 500 });
      const cols = exec.cols.map(c => c.name);
      const rows = exec.rows.map(row =>
        Object.fromEntries(row.map((cell, i) => [cols[i], cell.value ?? null]))
      );
      return Response.json({ cols, rows });
    }
    return env.ASSETS.fetch(request);
  },
};
