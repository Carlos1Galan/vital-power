import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import { getCookie } from 'hono/cookie'
import { db } from './db.ts'
import { feedStatus } from './events.ts'

// Demo login, no real authentication: the cookie holds only the user id. Synthetic data only.
export const COOKIE = 'vp_uid'

export type User = { id: number; name: string; role: 'caregiver' | 'coordinator' | 'admin'; orgId: number | null; facilityId: number | null }

// Loaded from the database on every request, so a changed persona takes effect immediately.
const USER = `SELECT u.id, u.name, u.role, u.org_id AS orgId, CASE WHEN o.kind = 'facility' THEN o.id END AS facilityId
  FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id = ?`

export function currentUser(c: Context): User | null {
  const id = Number(getCookie(c, COOKIE))
  return Number.isInteger(id) && id > 0 ? ((db.prepare(USER).get(id) as User | undefined) ?? null) : null
}

// 401 without a persona, 403 with the wrong one. Handlers read the user from c.var.user.
export const requireRole = (...roles: User['role'][]) =>
  createMiddleware<{ Variables: { user: User } }>(async (c, next) => {
    const user = currentUser(c)
    if (!user) return c.json({ ...feedStatus(), error: 'Elija una persona en "Ver como"' }, 401)
    if (!roles.includes(user.role)) return c.json({ ...feedStatus(), error: 'Esta persona no tiene acceso' }, 403)
    c.set('user', user)
    await next()
  })
