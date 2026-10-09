import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { app } from './app.ts'
import { startPoller } from './luma.ts'

// app is scoped to /api; the root also serves the built frontend in prod (same origin, no CORS).
const root = new Hono().route('/', app)
if (process.env.NODE_ENV === 'production') {
  root.use('*', serveStatic({ root: './dist' }))
  root.get('*', serveStatic({ path: './dist/index.html' }))
}

serve({ fetch: root.fetch, port: Number(process.env.PORT ?? 3000) }, (i) => console.log(`API on :${i.port}`))
startPoller()
