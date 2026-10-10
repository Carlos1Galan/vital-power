// One-time copy of the SQLite demo database into Postgres: DATABASE_URL (Supabase) when set, else local data/pglite.
//   npm run db:migrate-sqlite -- [path/to/vitalpower.db] [--replace]
// Every table moves with its ids, in one transaction: on any error nothing is written. The source is opened read-only.
// The target must hold no LUMA readings yet, so recorded readings are never overwritten by accident; --replace allows it.
import { DatabaseSync } from 'node:sqlite'
import { db, engine } from './db.ts'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? 'data/vitalpower.db'
const replace = args.includes('--replace')

// Parents before children. organizations.reviewed_by points at users, which point back at organizations: it is set last.
const TABLES = ['organizations', 'users', 'org_municipalities', 'patients', 'patient_needs', 'intakes', 'zones',
  'luma_readings', 'outage_events', 'checkins', 'briefings', 'call_outcomes', 'messages', 'settings']
const BATCH = 500

const src = new DatabaseSync(file, { readOnly: true })
const has = (t: string) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)
const sourceCount = (t: string) => has(t) ? (src.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n : 0
const targetCount = async (t: string) => (await db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

try {
  console.log(`${file} → ${engine === 'postgres' ? 'Postgres at DATABASE_URL' : engine}`)
  if (!replace && await targetCount('luma_readings') > 0) {
    console.error('The target already holds LUMA readings. Nothing was copied. Run again with --replace to overwrite it.')
    process.exitCode = 1
  } else {
    await db.tx(async () => {
      await db.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`)
      const reviewers: { id: number; reviewed_by: number }[] = []
      for (const t of TABLES) {
        if (!has(t)) continue // a database from before this table existed
        const rows = src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]
        if (t === 'organizations') for (const r of rows) if (r.reviewed_by !== null) {
          reviewers.push({ id: r.id as number, reviewed_by: r.reviewed_by as number })
          r.reviewed_by = null
        }
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH), cols = Object.keys(chunk[0])
          const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
          await db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES ${values}`).run(...chunk.flatMap((r) => cols.map((c) => r[c])))
        }
      }
      for (const r of reviewers) await db.prepare('UPDATE organizations SET reviewed_by = ? WHERE id = ?').run(r.reviewed_by, r.id)
      await db.exec('SELECT sync_ids()') // new rows get ids after the copied ones
    })
    const report = await Promise.all(TABLES.map(async (t) => ({ table: t, sqlite: sourceCount(t), postgres: await targetCount(t) })))
    console.table(report)
    const off = report.filter((r) => r.sqlite !== r.postgres)
    if (off.length) {
      console.error(`Row counts differ in: ${off.map((r) => r.table).join(', ')}`)
      process.exitCode = 1
    } else console.log('Done: every table has the same row count.')
  }
} finally {
  src.close()
  await db.end()
}
