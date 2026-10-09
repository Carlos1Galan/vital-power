import { useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import Caregiver from './Caregiver.tsx'
import System from './System.tsx'
import './index.css'

type Me = InferResponseType<typeof api.demo.me.$get>
type Persona = InferResponseType<typeof api.demo.personas.$get>['personas'][number]

const GROUPS: [Persona['personaType'], string][] = [
  ['caregiver-person', 'Cuidadores'],
  ['facility-staff', 'Hogar de envejecientes'],
  ['self-patient', 'Pacientes (auto-registro)'],
  ['coordinator', 'Coordinadores'],
  ['admin', 'Plataforma'],
]

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-PR') : '—')

// Every screen: feed status (last reading, LIVE/REPLAY, stale), the "Ver como" switcher and the DEMO label.
function Header() {
  const [me, setMe] = useState<Me | null>(null)
  const [personas, setPersonas] = useState<Persona[]>([])

  useEffect(() => {
    const load = async () => setMe(await (await api.demo.me.$get()).json())
    load()
    api.demo.personas.$get().then(async (r) => setPersonas((await r.json()).personas))
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [])

  // A full page load per switch: every area reloads as the new persona, nothing stale survives.
  const switchTo = async (userId: number) => {
    await api.demo.login.$post({ json: { userId } })
    const role = personas.find((p) => p.id === userId)?.role
    location.assign(role === 'caregiver' ? '/app' : '/admin')
  }

  const replay = me?.mode === 'replay'
  return (
    <header className="top">
      <a href="/" className="brand">VitalPower Relay</a>
      <span className={replay ? 'badge replay' : 'badge live'}>{replay ? 'REPLAY' : 'LIVE'}</span>
      <span>Última lectura de LUMA: {time(me?.lastReadingAt ?? null)}</span>
      {me?.stale && <span className="badge stale">DATOS VIEJOS</span>}
      <span className="spacer" />
      <label>
        Ver como{' '}
        <select value={me?.user?.id ?? ''} onChange={(e) => switchTo(Number(e.target.value))}>
          <option value="" disabled>Elegir persona…</option>
          {GROUPS.map(([type, label]) => (
            <optgroup key={type} label={label}>
              {personas.filter((p) => p.personaType === type).map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.orgName ? ` · ${p.orgName}` : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <span className="badge demo">DEMO · sin autenticación real</span>
    </header>
  )
}

// Pathname switch: / Landing (English), /app Caregiver, /admin Coordinator/Admin (Spanish).
export default function App() {
  const path = location.pathname
  return (
    <>
      <Header />
      <main>
        {path === '/app' ? <Caregiver /> : path === '/admin' ? <System /> : <h1>VitalPower Relay</h1>}
      </main>
    </>
  )
}
