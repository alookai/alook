export default {
  async fetch(_request, env) {
    await env.DB.exec('CREATE TABLE IF NOT EXISTS measured(id INTEGER PRIMARY KEY, value BLOB); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY); CREATE TRIGGER IF NOT EXISTS measured_audit AFTER INSERT ON measured BEGIN INSERT INTO audit(id) VALUES (NEW.id); END; DELETE FROM measured; DELETE FROM audit;')
    const session = env.DB.withSession('first-primary')
    const batch = await session.batch([
      session.prepare('INSERT INTO measured(id,value) VALUES (?,?)').bind(1, new Uint8Array([0, 255]).buffer),
      session.prepare('INSERT INTO measured(id,value) VALUES (?,?)').bind(2, null),
    ])
    const raw = await session.prepare('SELECT id AS same, id+10 AS same FROM measured ORDER BY id').raw()
    const first = await session.prepare('SELECT COUNT(*) AS n FROM audit').first('n')
    let failed = false
    try {
      await session.batch([session.prepare('INSERT INTO measured(id) VALUES (?)').bind(3), session.prepare('INSERT INTO measured(id) VALUES (?)').bind(1)])
    } catch { failed = true }
    const afterFailure = await session.prepare('SELECT id FROM measured ORDER BY id').raw()
    const audit = await session.prepare('SELECT id FROM audit ORDER BY id').all()
    return Response.json({ raw, first, failed, afterFailure, audit: audit.results, batchMeta: batch.map(row => row.meta), bookmark: session.getBookmark(), success: failed && first === 2 && afterFailure.length === 2 && raw[0][1] === 11 })
  },
}
