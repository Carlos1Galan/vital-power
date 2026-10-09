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

// requireRole() guards /call-list and /admin/*, but any visitor can pick any persona (demo login): synthetic data only.
// Loopback by default; set HOST=0.0.0.0 to show the demo on another device.
serve({ fetch: root.fetch, port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? '127.0.0.1' }, (i) => console.log(`API on ${i.address}:${i.port}`))
startPoller()
