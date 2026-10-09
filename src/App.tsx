/// <reference types="vite/client" />
import { useCallback, useEffect, useRef, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import Header from './Header.tsx'
import Landing from './Landing.tsx'
import Caregiver from './Caregiver.tsx'
import Admin from './Admin.tsx'

export type Persona = InferResponseType<typeof api.demo.personas.$get>['personas'][number]

export function defaultPersonaFor(path: string, personas: Persona[]) {
  if (path === '/app') return personas.find((p) => p.personaType === 'caregiver') ?? personas.find((p) => p.home === '/app')
  if (path === '/admin') return personas.find((p) => p.role === 'coordinator' && p.orgStatus === 'approved') ?? personas.find((p) => p.home === '/admin')
  return undefined
}

const login = async (userId: number) => {
  const res = await api.demo.login.$post({ json: { userId } })
  if (!res.ok) throw new Error('login')
  const body = await res.json()
  if (!('user' in body)) throw new Error('login')
  return body.user
}

export default function App() {
  const [personas, setPersonas] = useState<Persona[]>([])
  const [user, setUser] = useState<Persona | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [retryId, setRetryId] = useState<number | null>(null)
  const pending = useRef(false)
  const path = location.pathname

  const load = useCallback(async () => {
    if (pending.current) return
    pending.current = true
    setReady(false)
    setError(false)
    setRetryId(null)
    try {
      const [p, m] = await Promise.all([api.demo.personas.$get(), api.demo.me.$get()])
      if (!p.ok || !m.ok) throw new Error('load')
      const list = (await p.json()).personas
      let current = (await m.json()).user
      setPersonas(list)
      const allowed = path === '/app' ? ['caregiver'] : path === '/admin' ? ['coordinator', 'admin'] : []
      if (allowed.length && (!current || !allowed.includes(current.role))) {
        const fallback = defaultPersonaFor(path, list)
        if (!fallback) throw new Error('persona')
        current = await login(fallback.id)
      }
      setUser(current)
      setReady(true)
    } catch {
      setError(true)
    } finally {
      pending.current = false
    }
  }, [path])

  useEffect(() => { void load() }, [load])

  const switchTo = async (userId: number) => {
    if (pending.current) return
    pending.current = true
    setError(false)
    setRetryId(userId)
    try {
      const persona = await login(userId)
      if (persona.home !== location.pathname) location.assign(persona.home)
      else {
        setUser(persona)
        setReady(true)
      }
      setRetryId(null)
    } catch {
      setError(true)
    } finally {
      pending.current = false
    }
  }

  return <>
    <Header personas={personas} user={user} onSwitch={switchTo} />
    <main>
      {error && <div role="alert" className="connection-error">
        <p>No se pudo conectar con el API. ¿Está corriendo <code>npm run api</code>?</p>
        <button onClick={() => retryId === null ? load() : switchTo(retryId)}>Reintentar</button>
      </div>}
      {!ready ? (!error && <p>Cargando…</p>) : path === '/app' && user ? <Caregiver key={user.id} user={user} />
        : path === '/admin' && user ? <Admin key={user.id} user={user} /> : <Landing />}
    </main>
  </>
}
