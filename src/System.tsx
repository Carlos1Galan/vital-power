import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'

type Readings = InferResponseType<typeof api.admin.readings.$get>
type Orgs = InferResponseType<typeof api.admin.organizations.$get>
type Gaps = InferResponseType<typeof api.admin['coverage-gaps']['$get']>

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-PR') : '—')

// Admin System tab (owned by A). B mounts it as a tab in Admin.tsx.
export default function System() {
  const [readings, setReadings] = useState<Readings | null>(null)
  const [orgs, setOrgs] = useState<Orgs['organizations']>([])
  const [gaps, setGaps] = useState<Gaps['patients']>([])
  const [fromId, setFromId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [r, o, g] = await Promise.all([api.admin.readings.$get(), api.admin.organizations.$get(), api.admin['coverage-gaps'].$get()])
    setReadings(await r.json())
    setOrgs((await o.json()).organizations)
    setGaps((await g.json()).patients)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const act = async (fn: () => Promise<Response>) => {
    setBusy(true)
    setError('')
    try {
      const res = await fn()
      if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? `Error ${res.status}`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const replay = readings?.mode === 'replay'
  const pending = orgs.filter((o) => o.status === 'pending')

  return (
    <section className="system">
      <header>
        <strong className={replay ? 'badge replay' : 'badge live'}>{replay ? 'REPLAY' : 'LIVE'}</strong>{' '}
        Última lectura: {time(readings?.lastReadingAt ?? null)}{' '}
        {readings?.stale && <strong className="badge stale">DATOS VIEJOS</strong>}
      </header>

      <h2>Lecturas de LUMA</h2>
      <p>
        <button disabled={busy} onClick={() => act(() => api.admin.poll.$post())}>
          {replay ? 'Siguiente lectura del replay' : 'Forzar lectura ahora'}
        </button>{' '}
        {replay ? (
          <button disabled={busy} onClick={() => act(() => api.admin.mode.$put({ json: { mode: 'live' } }))}>Volver a LIVE</button>
        ) : (
          <>
            <input inputMode="numeric" placeholder="Lectura inicial (id)" value={fromId} onChange={(e) => setFromId(e.target.value)} />{' '}
            <button disabled={busy} onClick={() => act(() => api.admin.mode.$put({ json: { mode: 'replay', fromReadingId: fromId ? Number(fromId) : undefined } }))}>
              Iniciar replay
            </button>
          </>
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      <table>
        <thead>
          <tr><th>Id</th><th>Hora</th><th>Fuente</th><th>Endpoint</th><th>HTTP</th><th>Estado</th></tr>
        </thead>
        <tbody>
          {readings?.readings.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{time(r.fetched_at)}</td>
              <td>{r.source}</td>
              <td>{r.endpoint}</td>
              <td>{r.http_status || 'sin respuesta'}</td>
              <td>{r.ok ? 'ok' : `falló: ${r.error}`}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Organizaciones por revisar ({pending.length})</h2>
      {pending.length === 0 && <p>No hay organizaciones pendientes.</p>}
      <ul>
        {pending.map((o) => (
          <li key={o.id}>
            <strong>{o.name}</strong> ({o.orgType}) · {o.contactEmail} · {o.municipalities.join(', ')}
            {o.message && <p>{o.message}</p>}
            <button disabled={busy} onClick={() => act(() => api.admin.organizations[':id'].review.$post({ param: { id: String(o.id) }, json: { decision: 'approve' } }))}>Aprobar</button>{' '}
            <button disabled={busy} onClick={() => act(() => api.admin.organizations[':id'].review.$post({ param: { id: String(o.id) }, json: { decision: 'reject' } }))}>Rechazar</button>
          </li>
        ))}
      </ul>

      <h2>Brechas de cobertura: {gaps.length} pacientes sin organización aprobada</h2>
      <ul>
        {gaps.map((p) => (
          <li key={p.id}>{p.name} · {p.municipality}{p.zone ? ` · ${p.zone}` : ''}</li>
        ))}
      </ul>
    </section>
  )
}
