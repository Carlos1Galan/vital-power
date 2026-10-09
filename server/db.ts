import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'

const sql = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

// Test files always get their own in-memory DB, under `node --test` (NODE_TEST_CONTEXT) or run directly,
// so a test's DELETEs can never reach the recorded readings in data/vitalpower.db.
const isTest = process.env.NODE_TEST_CONTEXT || process.argv[1]?.endsWith('.test.ts')
const file = isTest ? ':memory:' : process.env.DB_PATH ?? 'data/vitalpower.db'
if (file !== ':memory:') mkdirSync('data', { recursive: true })

export const db = new DatabaseSync(file)
db.exec(sql('schema.sql'))
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.exec(`BEGIN; ${sql('seed.sql')}; COMMIT;`)

export const setting = (key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value

export const setSetting = (key: string, value: string) =>
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key)
