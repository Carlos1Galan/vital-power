import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { db } from './db.ts'
import { feedStatus } from './events.ts'

export const COOKIE = 'vp_user'
export type CurrentUser = { id: number; name: string; role: 'caregiver' | 'coordinator' | 'admin'; orgId: number | null }
type Persona = CurrentUser & {
  orgName: string | null
  orgStatus: 'pending' | 'approved' | 'rejected' | null
  personaType: 'admin' | 'coordinator' | 'facility-staff' | 'self-patient' | 'caregiver'
  home: '/app' | '/org' | '/admin'
}

export function currentUser(c: Context): CurrentUser | null {
  const id = getCookie(c, COOKIE)
  if (!id || id.length > 9 || /\D/.test(id)) return null
  return db.prepare('SELECT id, name, role, org_id AS orgId FROM users WHERE id = ?').get(Number(id)) as CurrentUser | undefined ?? null
}

export const requireRole = (...roles: CurrentUser['role'][]): MiddlewareHandler => async (c, next) => {
  const user = currentUser(c)
  if (!user) return c.json({ ...feedStatus(), error: 'Sesión demo no iniciada' }, 401)
  if (!roles.includes(user.role)) return c.json({ ...feedStatus(), error: 'Sin permiso para esta acción' }, 403)
  await next()
}

export function personas() {
  return db.prepare(`SELECT u.id, u.name, u.role, u.org_id AS orgId, o.name AS orgName, o.status AS orgStatus,
      CASE WHEN u.role = 'admin' THEN 'admin'
        WHEN u.role = 'coordinator' THEN 'coordinator'
        WHEN u.org_id IS NOT NULL THEN 'facility-staff'
        WHEN EXISTS (SELECT 1 FROM patients p WHERE p.caregiver_id = u.id AND p.is_self = 1) THEN 'self-patient'
        ELSE 'caregiver' END AS personaType,
      CASE u.role WHEN 'caregiver' THEN '/app' WHEN 'coordinator' THEN '/org' ELSE '/admin' END AS home
    FROM users u LEFT JOIN organizations o ON o.id = u.org_id ORDER BY u.id`).all() as Persona[]
}

export const persona = (id: number) => personas().find((p) => p.id === id) ?? null
