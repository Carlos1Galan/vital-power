import { useT, useServerText, getLang, type TextKey } from './i18n.ts'
import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'

type Readings = InferResponseType<typeof api.admin.readings.$get>
type Orgs = InferResponseType<typeof api.admin.organizations.$get>
type Gaps = InferResponseType<typeof api.admin['coverage-gaps']['$get']>

const ORG_TYPE_KEY: Record<string, TextKey> = {
  'health-plan': 'orgForm.healthPlan', municipality: 'orgForm.municipality', clinic: 'orgForm.clinic', supplier: 'orgForm.supplier', other: 'orgForm.other',
}
const SOURCE_KEY: Record<string, TextKey> = { live: 'header.live', replay: 'header.replay' }
const ENDPOINT_KEY: Record<string, TextKey> = { regions: 'system.regions', towns: 'system.towns' }

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(getLang() === 'en' ? 'en-US' : 'es-PR') : '—')

// Admin System tab (owned by A). B mounts it as a tab in Admin.tsx.
export default function System() {
  const t = useT()
  const s = useServerText()
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
      if (!res.ok) {
        const { error } = (await res.json().catch(() => ({}))) as { error?: unknown }
        setError(typeof error === 'string' ? error : t('common.errorStatus', { status: res.status }))
      }
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
        <strong className={replay ? 'badge replay' : 'badge live'}>{replay ? t('system.replay') : t('system.live')}</strong>{' '}
        {t('header.lastReading')} {time(readings?.lastReadingAt ?? null)}{' '}
        {readings?.stale && <strong className="badge stale">{t('system.stale')}</strong>}
      </header>

      <h2>{t('system.readings')}</h2>
      <p>
        <button disabled={busy} onClick={() => act(() => api.admin.poll.$post())}>
          {replay ? t('system.nextReading') : t('system.readNow')}
        </button>{' '}
        {replay ? (
          <button disabled={busy} onClick={() => act(() => api.admin.mode.$put({ json: { mode: 'live' } }))}>{t('system.returnLive')}</button>
        ) : (
          <>
            <input inputMode="numeric" placeholder={t('system.initialReading')} value={fromId} onChange={(e) => setFromId(e.target.value)} />{' '}
            <button disabled={busy} onClick={() => (fromId && !/^[1-9]\d*$/.test(fromId) ? setError(t('system.invalidId')) : act(() => api.admin.mode.$put({ json: { mode: 'replay', fromReadingId: fromId ? Number(fromId) : undefined } })))}>
              {t('system.startReplay')}
            </button>
          </>
        )}
      </p>
      {error && <p role="alert">{s(error)}</p>}
      <table>
        <thead>
          <tr><th>{t('system.id')}</th><th>{t('system.time')}</th><th>{t('system.source')}</th><th>{t('system.endpoint')}</th><th>{t('system.http')}</th><th>{t('system.status')}</th></tr>
        </thead>
        <tbody>
          {readings?.readings.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{time(r.fetched_at)}</td>
              <td>{SOURCE_KEY[r.source] ? t(SOURCE_KEY[r.source]) : r.source}</td>
              <td>{ENDPOINT_KEY[r.endpoint] ? t(ENDPOINT_KEY[r.endpoint]) : r.endpoint}</td>
              <td>{r.http_status || t('system.noResponse')}</td>
              <td>{r.ok ? t('system.ok') : t('system.failed', { error: s(r.error) })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>{t('system.pendingCount', { count: pending.length })}</h2>
      {pending.length === 0 && <p>{t('system.noPending')}</p>}
      <ul>
        {pending.map((o) => (
          <li key={o.id}>
            <strong>{s(o.name)}</strong> ({ORG_TYPE_KEY[o.orgType] ? t(ORG_TYPE_KEY[o.orgType]) : o.orgType}) · {o.contactEmail} · {o.municipalities.join(', ')}
            {o.message && <p>{o.message}</p>}
            <button disabled={busy} onClick={() => act(() => api.admin.organizations[':id'].review.$post({ param: { id: String(o.id) }, json: { decision: 'approve' } }))}>{t('system.approve')}</button>{' '}
            <button disabled={busy} onClick={() => act(() => api.admin.organizations[':id'].review.$post({ param: { id: String(o.id) }, json: { decision: 'reject' } }))}>{t('system.reject')}</button>
          </li>
        ))}
      </ul>

      <h2>{t('system.gaps', { count: gaps.length })}</h2>
      <ul>
        {gaps.map((p) => (
          <li key={p.id}>{s(p.name)} · {p.municipality}{p.zone ? ` · ${p.zone}` : ''}</li>
        ))}
      </ul>
    </section>
  )
}
