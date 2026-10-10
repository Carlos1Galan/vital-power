import { test } from 'node:test'
import assert from 'node:assert/strict'
import { engine, toPg } from './db.ts'

// Run directly (`node server/db.test.ts`, an IDE "run file") too: tests must never open DATABASE_URL (Supabase).
test('test files use an in-memory database', () => {
  assert.equal(engine, process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite:memory')
})

test('placeholders become $n; literals, comments and casts are left alone', () => {
  assert.deepEqual(toPg('SELECT ? , ?', [1, undefined]), ['SELECT $1 , $2', [1, null]])
  assert.deepEqual(toPg(`SELECT :a, :b::text, :a -- why? :c
    WHERE x = 'it''s :d ?'`, [{ a: 1, b: 'x' }]), [`SELECT $1, $2::text, $1 -- why? :c
    WHERE x = 'it''s :d ?'`, [1, 'x']])
  assert.throws(() => toPg('SELECT :a', [1]), /named values/)
  assert.deepEqual(toPg("SELECT a AS patientName, b AS n, 'x AS fooBar' AS label", []), [`SELECT a AS "patientName", b AS n, 'x AS fooBar' AS label`, []])
})
