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

// ponytail: loopback by default: the demo login lets anyone be admin. Set HOST=0.0.0.0 only for the demo deploy.
serve({ fetch: root.fetch, port: Number(process.env.PORT ?? 3000), hostname: process.env.HOST ?? '127.0.0.1' }, (i) => console.log(`API on ${i.address}:${i.port}`))
startPoller()
