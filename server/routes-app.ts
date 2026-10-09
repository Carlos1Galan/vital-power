import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { COOKIE, currentUser, persona, personas } from './auth.ts'
import { feedStatus } from './events.ts'

const withFeed = <T extends object>(data: T) => ({ ...feedStatus(), ...data })
const valid = zValidator('json', z.object({ userId: z.number().int().positive() }), (r, c) => {
  if (!r.success) return c.json(withFeed({ error: `Entrada inválida: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }), 400)
})

// Owned by B: demo login, intake, patients, check-ins, claim, events, briefings, outcomes.
export const appRoutes = new Hono()
  .onError((error, c) => {
    const bad = error instanceof HTTPException && error.status === 400 // malformed JSON body
    if (!bad) console.error(error)
    return c.json(withFeed({ error: bad ? 'Entrada inválida' : 'Error del API' }), bad ? 400 : 500)
  })
  .get('/demo/personas', (c) => c.json(withFeed({ personas: personas() })))
  .post('/demo/login', valid, (c) => {
    const user = persona(c.req.valid('json').userId)
    if (!user) return c.json(withFeed({ error: 'Persona no encontrada' }), 404)
    setCookie(c, COOKIE, String(user.id), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 7 })
    return c.json(withFeed({ user }))
  })
  .post('/demo/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json(withFeed({ user: null }))
  })
  .get('/demo/me', (c) => {
    const user = currentUser(c)
    return c.json(withFeed({ user: user ? persona(user.id) : null }))
  })
