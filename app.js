async function query(sql, args = []) {
  const r = await fetch('/api/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, args }),
  });
  return r.json();
}
async function load() {
  const q = document.getElementById('q').value.trim();
  const sql = `
    SELECT match_id, assignment_date, code, reviewer_name, team, task, half, side
    FROM assignments
    WHERE (?1 = '' OR reviewer_name LIKE ?1 OR match_id LIKE ?1 OR task LIKE ?1)
    ORDER BY assignment_date DESC
    LIMIT 500
  `;
  const t0 = performance.now();
  const { cols, rows, error } = await query(sql, [q ? '%' + q + '%' : '']);
  if (error) { document.getElementById('meta').textContent = 'ERR ' + JSON.stringify(error); return; }
  const dt = Math.round(performance.now() - t0);
  document.getElementById('meta').textContent = ` · ${rows.length} rows · ${dt} ms`;
  document.querySelector('#tbl thead').innerHTML =
    '<tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>';
  document.querySelector('#tbl tbody').innerHTML = rows.map(r =>
    '<tr>' + cols.map(c => '<td>' + (r[c] ?? '') + '</td>').join('') + '</tr>').join('');
}
document.getElementById('reload').onclick = load;
document.getElementById('q').oninput = () => { clearTimeout(window._t); window._t = setTimeout(load, 300); };
load();
