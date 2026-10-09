import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { db } from './db.ts'
import { app } from './app.ts'
import { requireRole } from './auth.ts'

const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, cookie: res.headers.get('set-cookie'), json: (await res.json()) as any }
}
const feedKeys = (j: object) => assert.deepEqual(['lastReadingAt', 'mode', 'stale'].filter((k) => k in j), ['lastReadingAt', 'mode', 'stale'])
const login = async (userId: number) => {
  const r = await call('POST', '/demo/login', { userId })
  assert.equal(r.status, 200)
  assert.ok(r.cookie)
  return r.cookie.split(';')[0]
}

test('demo personas list the seven seeded personas with types, organizations and homes', async () => {
  const { status, json } = await call('GET', '/demo/personas')
  assert.equal(status, 200)
  feedKeys(json)
  assert.deepEqual(json.personas.map((p: any) => p.id), [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(json.personas.map((p: any) => p.personaType), ['admin', 'coordinator', 'coordinator', 'coordinator', 'caregiver', 'facility-staff', 'self-patient'])
  assert.equal(json.personas[3].orgStatus, 'pending')
  for (const p of json.personas) {
    assert.equal(p.home, { caregiver: '/app', coordinator: '/org', admin: '/admin' }[p.role as 'caregiver' | 'coordinator' | 'admin'])
    assert.equal(typeof p.name, 'string')
    assert.equal(p.orgName === null, p.orgId === null)
    assert.equal(p.orgStatus === null, p.orgId === null)
  }
})

test('login stores only the user id and me reads the cookie', async () => {
  const r = await call('POST', '/demo/login', { userId: 5 })
  assert.equal(r.status, 200)
  feedKeys(r.json)
  assert.equal(r.json.user.id, 5)
  assert.ok(r.cookie)
  assert.equal(r.cookie.split(';')[0], 'vp_user=5')
  assert.match(r.cookie, /HttpOnly/i)
  assert.match(r.cookie, /SameSite=Lax/i)
  assert.match(r.cookie, /Max-Age=604800/i)
  assert.match(r.cookie, /Path=\//i)
  assert.doesNotMatch(r.cookie, /Secure/i)
  const me = await call('GET', '/demo/me', undefined, r.cookie.split(';')[0])
  assert.equal(me.status, 200)
  assert.equal(me.json.user.id, 5)
  feedKeys(me.json)
  const anonymous = await call('GET', '/demo/me')
  assert.equal(anonymous.status, 200)
  assert.equal(anonymous.json.user, null)
  feedKeys(anonymous.json)
})

test('login rejects unknown users and invalid input with string errors', async () => {
  const unknown = await call('POST', '/demo/login', { userId: 99999 })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error, 'Persona no encontrada')
  feedKeys(unknown.json)
  for (const body of [{ userId: 'x' }, { userId: -1 }, {}, '{']) {
    const r = await call('POST', '/demo/login', body)
    assert.equal(r.status, 400)
    assert.equal(typeof r.json.error, 'string')
    feedKeys(r.json)
  }
})

test('logout expires the demo cookie', async () => {
  const cookie = await login(5)
  const r = await call('POST', '/demo/logout', undefined, cookie)
  assert.equal(r.status, 200)
  assert.equal(r.json.user, null)
  feedKeys(r.json)
  assert.ok(r.cookie)
  assert.match(r.cookie, /^vp_user=;/)
  assert.match(r.cookie, /Max-Age=0/i)
  assert.equal((await call('GET', '/demo/me')).json.user, null)
})

test('garbage, oversized and unknown cookies do not identify a persona', async () => {
  for (const cookie of ['vp_user=abc', 'vp_user=1 OR 1=1', 'vp_user=99999', 'vp_user=0000000001', 'vp_user=-1', 'vp_user=1.0', 'vp_user=1%0A']) {
    const r = await call('GET', '/demo/me', undefined, cookie)
    assert.equal(r.status, 200)
    assert.equal(r.json.user, null)
    feedKeys(r.json)
  }
})

test('requireRole checks current roles and returns feed status on denial', async () => {
  const guarded = new Hono().get('/x', requireRole('admin'), (c) => c.json({ ok: true }))
  for (const [cookie, status, error] of [
    ['', 401, 'Sesión demo no iniciada'],
    [await login(5), 403, 'Sin permiso para esta acción'],
    [await login(1), 200, undefined],
  ] as const) {
    const res = await guarded.request('/x', { headers: { Cookie: cookie } })
    assert.equal(res.status, status)
    const json = await res.json() as any
    if (status === 200) assert.equal(json.ok, true)
    else {
      feedKeys(json)
      assert.equal(json.error, error)
    }
  }
  const shared = new Hono().get('/x', requireRole('admin', 'coordinator'), (c) => c.json({ ok: true }))
  assert.equal((await shared.request('/x', { headers: { Cookie: await login(2) } })).status, 200)
})

test('deleting a persona invalidates its existing cookie immediately', async () => {
  const id = Number(db.prepare("INSERT INTO users (name, role) VALUES ('Persona temporal', 'admin')").run().lastInsertRowid)
  try {
    const cookie = await login(id)
    const guarded = new Hono().get('/x', requireRole('admin'), (c) => c.json({ ok: true }))
    assert.equal((await guarded.request('/x', { headers: { Cookie: cookie } })).status, 200)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    const me = await call('GET', '/demo/me', undefined, cookie)
    assert.equal(me.status, 200)
    assert.equal(me.json.user, null)
    const res = await guarded.request('/x', { headers: { Cookie: cookie } })
    assert.equal(res.status, 401)
    const json = await res.json() as any
    feedKeys(json)
    assert.equal(typeof json.error, 'string')
  } finally {
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }
})
