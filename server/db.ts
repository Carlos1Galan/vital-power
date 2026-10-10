import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync } from 'node:fs'
import postgres from 'postgres'

const sql = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

// Test files always get their own in-memory Postgres (PGlite), under `node --test` (NODE_TEST_CONTEXT) or run directly,
// so a test's DELETEs can never reach DATABASE_URL. TEST_DATABASE_URL (a throwaway database only) runs them on a real server.
const isTest = !!(process.env.NODE_TEST_CONTEXT || process.argv[1]?.endsWith('.test.ts'))
const url = isTest ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL
const dir = isTest ? undefined : process.env.PGLITE_DIR ?? 'data/pglite'
export const engine = url ? 'postgres' : dir ? `pglite:${dir}` : 'pglite:memory'

type Row = Record<string, unknown>
type Conn = {
  query(text: string, params: unknown[]): Promise<{ rows: Row[]; count: number }>
  exec(text: string): Promise<void>
  tx<T>(fn: (c: Conn) => Promise<T>): Promise<T>
  end(): Promise<void>
}

// Supabase (or any Postgres). Its transaction pooler (:6543) has no prepared statements; bigint (count) comes back as a number.
function server(connection: string): Conn {
  const s = postgres(connection, { prepare: false, idle_timeout: 20, types: { int8: { to: 20, from: [20], serialize: String, parse: Number } } })
  const wrap = (q: postgres.Sql | postgres.TransactionSql): Conn => ({
    query: async (text, params) => {
      const r = await q.unsafe(text, params as postgres.ParameterOrJSON<never>[])
      return { rows: Array.from(r), count: r.count }
    },
    exec: async (text) => { await q.unsafe(text) },
    tx: (fn) => s.begin((t) => fn(wrap(t))) as never,
    end: () => s.end(),
  })
  return wrap(s)
}

// PGlite: Postgres compiled to WASM, in-process. In memory for tests; a folder for local dev without DATABASE_URL.
async function local(dataDir?: string): Promise<Conn> {
  const { PGlite } = await import('@electric-sql/pglite')
  if (dataDir) mkdirSync(dataDir, { recursive: true })
  const pg = await PGlite.create(dataDir, { parsers: { 20: Number } })
  type Q = Pick<typeof pg, 'query' | 'exec'>
  const wrap = (q: Q): Conn => ({
    query: async (text, params) => {
      const r = await q.query<Row>(text, params)
      return { rows: r.rows, count: r.affectedRows ?? 0 }
    },
    exec: async (text) => { await q.exec(text) },
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    end: () => pg.close(),
  })
  return wrap(pg)
}

// node:sqlite-style placeholders (? in order, or :name from one object) become Postgres $n, and a camelCase alias
// (AS patientName) is quoted so Postgres keeps its case as SQLite did. String literals, -- comments and :: casts pass
// through untouched. A missing value binds NULL.
export function toPg(text: string, args: unknown[]): [string, unknown[]] {
  const named = args.length === 1 && args[0] !== null && typeof args[0] === 'object' ? args[0] as Row : null
  const params: unknown[] = []
  const slot = new Map<string, number>()
  const out = text.replace(/'(?:[^']|'')*'|--[^\n]*|::|\?|:([A-Za-z_]\w*)|\bAS ([a-z]\w*[A-Z]\w*)\b/g, (m, name?: string, alias?: string) => {
    if (m === '?') return `$${params.push(args[params.length] ?? null)}`
    if (alias) return `AS "${alias}"`
    if (!name) return m
    if (!named) throw new Error(`:${name} needs an object of named values`)
    if (!slot.has(name)) slot.set(name, params.push(named[name] ?? null))
    return `$${slot.get(name)}`
  })
  return [out, params]
}

const root = url ? server(url) : await local(dir)
const current = new AsyncLocalStorage<Conn>()
const conn = () => current.getStore() ?? root

// Same shape as node:sqlite's prepare().get/all/run, async. Nothing is prepared server-side (see server() above).
export const db = {
  prepare(text: string) {
    const run = (args: unknown[]) => conn().query(...toPg(text, args))
    return {
      get: async (...args: unknown[]) => (await run(args)).rows[0],
      all: async (...args: unknown[]) => (await run(args)).rows,
      run: async (...args: unknown[]) => ({ changes: (await run(args)).count }),
    }
  },
  exec: (text: string) => conn().exec(text),
  // Everything fn awaits through db runs in one transaction; a nested tx joins the outer one.
  tx: <T>(fn: () => Promise<T>): Promise<T> => current.getStore() ? fn() : root.tx((t) => current.run(t, fn)),
  end: () => root.end(),
}

// ponytail: the schema runs on every start (idempotent). Move it to the migration step once several instances start at once (Vercel).
await root.exec(sql('schema.sql'))
if (!await db.prepare('SELECT 1 FROM users LIMIT 1').get()) await db.tx(() => db.exec(sql('seed.sql')))

export const setting = async (key: string) =>
  (await db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string }).value

export const setSetting = (key: string, value: string) =>
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value, key)
