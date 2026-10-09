import { Hono } from 'hono'
import { dataRoutes } from './routes-data.ts'
import { appRoutes } from './routes-app.ts'

export const app = new Hono().basePath('/api').route('/', dataRoutes).route('/', appRoutes)

export type AppType = typeof app
