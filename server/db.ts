import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'

const sql = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

// Tests run under `node --test`, which sets NODE_TEST_CONTEXT: each test file gets its own in-memory DB.
const file = process.env.DB_PATH ?? (process.env.NODE_TEST_CONTEXT ? ':memory:' : 'data/vitalpower.db')
if (file !== ':memory:') mkdirSync('data', { recursive: true })

export const db = new DatabaseSync(file)
db.exec(sql('schema.sql'))
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) db.exec(sql('seed.sql'))

export const setting = (key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value

export const setSetting = (key: string, value: string) =>
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key)
