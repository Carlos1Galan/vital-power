import { test } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'

// Run directly (`node server/db.test.ts`, an IDE "run file") too: tests must never open data/vitalpower.db.
test('test files use an in-memory database', () => {
  assert.equal(db.location(), null)
})
