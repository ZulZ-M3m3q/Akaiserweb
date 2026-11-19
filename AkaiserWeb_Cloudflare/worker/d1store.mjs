// Cloudflare D1 (SQLite) as the key-value store the API expects.
// Same interface as the Netlify Blobs store: get(key,{type:'json'}), setJSON(key,value,{onlyIfNew}), delete(key).
// D1 is strongly consistent and INSERT OR IGNORE is atomic, so "username taken" / "code taken" checks are safe.
let ready = null;

export function d1Store(db) {
  const init = () => (ready ||= db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)').catch((e) => { ready = null; throw e; }));
  return {
    async get(k) {
      await init();
      const row = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
      return row ? JSON.parse(row.v) : null;
    },
    async setJSON(k, v, o) {
      await init();
      const json = JSON.stringify(v);
      if (o && o.onlyIfNew) {
        const r = await db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').bind(k, json).run();
        return { modified: (r.meta?.changes ?? 0) > 0 };
      }
      await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, json).run();
      return { modified: true };
    },
    async delete(k) {
      await init();
      await db.prepare('DELETE FROM kv WHERE k = ?').bind(k).run();
    },
  };
}

// Daily housekeeping: drop expired rate-limit counters, sessions and link codes.
export async function cleanup(db) {
  await d1Store(db).get('_'); // makes sure the table exists
  const t = Date.now();
  await db.batch([
    db.prepare("DELETE FROM kv WHERE k LIKE 'r:%' AND json_extract(v,'$.reset') < ?").bind(t),
    db.prepare("DELETE FROM kv WHERE k LIKE 's:%' AND json_extract(v,'$.expires') < ?").bind(t),
    db.prepare("DELETE FROM kv WHERE k LIKE 'c:%' AND json_extract(v,'$.exp') < ?").bind(t),
  ]);
}
