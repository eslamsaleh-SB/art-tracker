export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/query' && request.method === 'POST') {
      const { sql, args = [] } = await request.json();
      if (!/^\s*(select|with)/i.test(sql)) {
        return new Response('read-only', { status: 400 });
      }
      const body = {
        requests: [
          { type: 'execute', stmt: { sql, args: args.map(v => ({ type: 'text', value: String(v) })) } },
          { type: 'close' },
        ],
      };
      const r = await fetch(env.TURSO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.TURSO_TOKEN },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      const exec = j.results?.[0]?.response?.result;
      if (!exec) return Response.json({ error: j }, { status: 500 });
      const cols = exec.cols.map(c => c.name);
      const rows = exec.rows.map(row => Object.fromEntries(row.map((cell, i) => [cols[i], cell.value ?? null])));
      return Response.json({ cols, rows });
    }
    return env.ASSETS.fetch(request);
  }
};
