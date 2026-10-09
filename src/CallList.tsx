import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import { ago, errorText, needText } from './lib.ts'

type CallEvent = InferResponseType<typeof api['call-list']['$get']>['events'][number]
type Detail = InferResponseType<typeof api.events[':id']['$get'], 200>

const TIER_LABEL = { 1: 'Llamar ahora', 2: 'Llamar pronto', 3: 'Por confirmar' } as const

export default function CallList({ user }: { user: Persona }) {
  const [events, setEvents] = useState<CallEvent[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api['call-list'].$get()
      if (!res.ok) return setError(await errorText(res))
      setEvents((await res.json()).events)
    } catch {
      setError('No se pudo cargar la lista. ¿Está corriendo el servidor?')
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  // Runs one action, shows its error if any, then reloads so every row reflects the database.
  const act = async (request: () => Promise<Response>) => {
    setBusy(true)
    setError('')
    let ok = false
    try {
      const res = await request()
      ok = res.ok
      if (!ok) setError(await errorText(res))
    } catch {
      setError('No se pudo completar la acción.')
    }
    await load()
    setBusy(false)
    return ok
  }

  if (!events) return error ? <p role="alert" className="connection-error">{error}</p> : <p>Cargando la lista…</p>

  return <>
    {error && <p role="alert" className="connection-error">{error}</p>}
    {!events.length && <p className="card empty">No hay apagones que afecten a pacientes registrados en este momento.</p>}
    <ol className="call-list">
      {events.map((e, i) => {
        const mine = e.claimedByOrgId !== null && e.claimedByOrgId === user.orgId
        return <li key={e.eventId} className={`call tier-${e.tier}`} style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}>
          <div className="call-rank"><strong>{i + 1}</strong><span>{TIER_LABEL[e.tier]}</span></div>
          <div className="call-body">
            <h2>{e.patientName}</h2>
            <p className="call-place">{e.municipality} · {e.zone} · apagón detectado {ago(e.openedAt)}</p>
            <ul className="call-reasons">{e.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <p className="call-needs">{e.needs.map(needText).join(' · ')}</p>
            <p className="call-checkin">{e.checkinReplyAt ? `Contestó el aviso ${ago(e.checkinReplyAt)}` : e.checkinSentAt ? `Aviso enviado ${ago(e.checkinSentAt)}, sin respuesta` : 'Sin aviso enviado'}</p>
          </div>
          <div className="call-actions">
            {e.claimedBy
              ? <p className={mine ? 'claimed mine' : 'claimed'}>{mine ? 'Caso de su organización' : `Atendido por ${e.claimedBy}`}</p>
              : user.role === 'coordinator' && <button disabled={busy} onClick={() => act(() => api.events[':id'].claim.$post({ param: { id: String(e.eventId) } }))}>Tomar caso</button>}
            <button className="quiet" aria-expanded={openId === e.eventId} onClick={() => setOpenId(openId === e.eventId ? null : e.eventId)}>
              {openId === e.eventId ? 'Cerrar' : 'Ver caso'}
            </button>
          </div>
          {openId === e.eventId && <EventDetail key={`${e.eventId}-${e.status}-${e.checkinReplyAt}-${e.claimedByOrgId}`} id={e.eventId} user={user} busy={busy} act={act} />}
        </li>
      })}
    </ol>
  </>
}

function EventDetail({ id, user, busy, act }: { id: number; user: Persona; busy: boolean; act: (request: () => Promise<Response>) => Promise<boolean> }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [reached, setReached] = useState(true)
  const [outcome, setOutcome] = useState('')
  const [nextAction, setNextAction] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.events[':id'].$get({ param: { id: String(id) } })
      if (res.ok) setDetail(await res.json())
      else setError(await errorText(res))
    } catch {
      setError('No se pudo cargar el caso.')
    }
  }, [id])
  useEffect(() => { void load() }, [load])

  // The automatic reading is stored a few seconds after the reply; look again while it is still on its way.
  const awaitingReading = !!detail?.checkin?.replyAt && !detail.checkin.aiParsed && Date.now() - Date.parse(detail.checkin.replyAt) < 60_000
  useEffect(() => {
    if (!awaitingReading) return
    const timer = setTimeout(load, 3000)
    return () => clearTimeout(timer)
  }, [awaitingReading, detail, load])

  if (error) return <p role="alert" className="call-detail connection-error">{error}</p>
  if (!detail) return <p className="call-detail">Cargando el caso…</p>
  const { event, checkin, outcomes } = detail
  const canConfirm = user.role === 'coordinator' && checkin?.replyText && (event.status === 'possible' || event.status === 'confirmed')
  const confirm = (hasPower: boolean) => act(() => api.checkins[':id'].confirm.$post({ param: { id: String(checkin!.id) }, json: { hasPower } }))

  return <div className="call-detail">
    <section>
      <h3>Respuesta al aviso</h3>
      {checkin ? <>
        <p className="question">{checkin.message}</p>
        {checkin.replyText
          ? <blockquote>{checkin.replyText}<footer>Texto original · {ago(checkin.replyAt!)}</footer></blockquote>
          : <p className="muted">Todavía no han contestado.</p>}
        {checkin.aiParsed ? <div className="automatic-reading">
          <p>Lectura automática: {({ no: 'dice que NO tiene luz', yes: 'dice que SÍ tiene luz', unclear: 'no queda claro si tiene luz' })[checkin.aiParsed.hasPower]}{checkin.aiParsed.batteryHours !== null && ` · batería: ${checkin.aiParsed.batteryHours} h`}</p>
          <p>{checkin.aiParsed.summary}</p>
          <p className="muted">Es una lectura automática. Confirme usted con el texto original.</p>
        </div> : checkin.replyText && <p className="muted">Lectura automática no disponible. Lea la respuesta original.</p>}
        {checkin.confirmedAt && <p className="muted">Confirmado por un coordinador {ago(checkin.confirmedAt)}.</p>}
        {canConfirm && <p className="confirm-actions">
          <button disabled={busy} onClick={() => confirm(false)}>Confirmar: no tiene luz</button>
          <button className="quiet" disabled={busy} onClick={() => confirm(true)}>Sí tiene luz</button>
        </p>}
      </> : <p className="muted">Este caso no tiene aviso.</p>}
    </section>

    <section>
      <h3>Llamada</h3>
      <p>Teléfono: <strong>{event.phone ?? 'no registrado'}</strong></p>
      {outcomes.map((o) => <p key={o.id} className="outcome">
        <strong>{o.reached ? 'Contactado' : 'No contestó'}</strong> · {o.outcome}{o.nextAction ? ` · Próximo paso: ${o.nextAction}` : ''}
        <span className="muted"> ({o.coordinator}, {ago(o.createdAt)})</span>
      </p>)}
      {event.mine
        ? <form className="outcome-form" onSubmit={async (ev) => {
            ev.preventDefault()
            const saved = await act(() => api.events[':id'].outcome.$post({ param: { id: String(id) }, json: { reached, outcome, nextAction } }))
            if (!saved) return // keep what the coordinator typed
            setOutcome('')
            setNextAction('')
            await load()
          }}>
            <label className="check"><input type="checkbox" checked={reached} onChange={(ev) => setReached(ev.target.checked)} /> Logré hablar con la persona</label>
            <label>¿Qué pasó en la llamada?<input required maxLength={500} value={outcome} onChange={(ev) => setOutcome(ev.target.value)} /></label>
            <label>Próximo paso (opcional)<input maxLength={500} value={nextAction} onChange={(ev) => setNextAction(ev.target.value)} /></label>
            <button disabled={busy || !outcome.trim()}>Guardar resultado</button>
          </form>
        : <p className="muted">{event.claimedBy ? `Solo ${event.claimedBy} puede registrar el resultado.` : 'Tome el caso para registrar el resultado de la llamada.'}</p>}
    </section>
    <BriefingSection event={event} initial={detail.briefing} reload={load} />
  </div>
}

function BriefingSection({ event, initial, reload }: { event: Detail['event']; initial: Detail['briefing']; reload: () => Promise<void> }) {
  const [briefing, setBriefing] = useState(initial)
  const [text, setText] = useState(initial?.approvedText ?? initial?.draftText ?? '')
  const [busy, setBusy] = useState<'draft' | 'approve' | null>(null)
  const [error, setError] = useState('')

  // Follow the server only when the stored briefing itself changed; a background refresh must not overwrite unsaved edits.
  const stored = initial ? `${initial.id}:${initial.approvedAt}` : ''
  useEffect(() => {
    setBriefing(initial)
    setText(initial?.approvedText ?? initial?.draftText ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stored briefing, not on the object identity
  }, [stored])

  const draft = async () => {
    setBusy('draft')
    setError('')
    try {
      const res = await api.events[':id'].briefing.$post({ param: { id: String(event.id) } })
      if (!res.ok) setError(await errorText(res))
      else {
        const data: InferResponseType<typeof api.events[':id']['briefing']['$post'], 201> = await res.json()
        setBriefing({ id: data.id, draftText: data.draftText, approvedText: null, approvedAt: null })
        setText(data.draftText)
      }
    } catch { setError('No se pudo redactar el resumen. Intente de nuevo.') }
    finally { setBusy(null) }
  }
  const approve = async () => {
    if (!briefing) return
    setBusy('approve')
    setError('')
    try {
      const res = await api.briefings[':id'].approve.$post({ param: { id: String(briefing.id) }, json: { text } })
      if (!res.ok) setError(await errorText(res))
      else await reload()
    } catch { setError('No se pudo aprobar el resumen. Intente de nuevo.') }
    finally { setBusy(null) }
  }

  return <section className="outcome-form briefing">
    <h3>Resumen para la llamada</h3>
    {error && <p role="alert" className="connection-error">{error}</p>}
    {event.mine ? <>
      {briefing && <>
        <label>Resumen<textarea rows={10} maxLength={4000} value={text} disabled={busy !== null} onChange={(ev) => setText(ev.target.value)} /></label>
        <p className="muted">Borrador automático. Revíselo y corríjalo antes de aprobar.</p>
        <button disabled={busy !== null || !text.trim() || text.length > 4000} onClick={approve}>{busy === 'approve' ? 'Aprobando…' : 'Aprobar resumen'}</button>
        <p className="muted" aria-live="polite">{briefing.approvedAt ? `Aprobado ${ago(briefing.approvedAt)}.` : ''}</p>
      </>}
      <button className={briefing ? 'quiet' : undefined} disabled={busy !== null} onClick={draft}>{busy === 'draft' ? 'Redactando…' : briefing ? 'Redactar de nuevo' : 'Redactar resumen'}</button>
    </> : <>
      <p className="muted">{event.claimedBy ? `Solo ${event.claimedBy} puede redactar el resumen.` : 'Tome el caso para redactar el resumen de la llamada.'}</p>
      {briefing?.approvedAt && <p className="briefing-text">{briefing.approvedText}</p>}
    </>}
  </section>
}
