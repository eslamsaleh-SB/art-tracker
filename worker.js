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
