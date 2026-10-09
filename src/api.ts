import { hc } from 'hono/client'
import type { AppType } from '../server/app.ts'

// Typed client rooted at /api: api.public.status.$get(), api['call-list'].$get(), ...
export const api = hc<AppType>('/').api
