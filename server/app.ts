import { Hono } from 'hono'
import { dataRoutes } from './routes-data.ts'
import { appRoutes } from './routes-app.ts'
import { whatsappRoutes } from './whatsapp.ts'

export const app = new Hono().basePath('/api').route('/', dataRoutes).route('/', appRoutes).route('/', whatsappRoutes)

export type AppType = typeof app
