import { useT, useServerText, getLang, useLang } from './i18n.ts'
import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import { ALERTS_CHANGED } from './Alerts.tsx'
import { ago, errorText, needText } from './lib.ts'

type CallEvent = InferResponseType<typeof api['call-list']['$get']>['events'][number]
type Detail = InferResponseType<typeof api.events[':id']['$get'], 200>

const TIER_KEY = { 1: 'calls.tier1', 2: 'calls.tier2', 3: 'calls.tier3' } as const

export default function CallList({ user }: { user: Persona }) {
  const t = useT()
  const s = useServerText()
  const [events, setEvents] = useState<CallEvent[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)

  // An alert links to /org#caso-12: open that case.
  useEffect(() => {
    const fromHash = () => { const id = /^#caso-(\d+)$/.exec(location.hash)?.[1]; if (id) setOpenId(Number(id)) }
    fromHash()
    addEventListener('hashchange', fromHash)
    return () => removeEventListener('hashchange', fromHash)
  }, [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await api['call-list'].$get()
      if (!res.ok) return setError(await errorText(res))
      setEvents((await res.json()).events)
    } catch {
      setError(t('calls.loadError'))
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
      setError(t('calls.actionError'))
    }
    await load()
    dispatchEvent(new Event(ALERTS_CHANGED)) // a case taken or confirmed can make its alert untrue
    setBusy(false)
    return ok
  }

  if (!events) return error ? <p role="alert" className="connection-error">{s(error)}</p> : <p>{t('calls.loading')}</p>

  return <>
    {error && <p role="alert" className="connection-error">{s(error)}</p>}
    {!events.length && <p className="card empty">{t('calls.empty')}</p>}
    <ol className="call-list">
      {events.map((e, i) => {
        const mine = e.claimedByOrgId !== null && e.claimedByOrgId === user.orgId
        return <li key={e.eventId} id={`caso-${e.eventId}`} className={`call tier-${e.tier}`} style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}>
          <div className="call-rank"><strong>{i + 1}</strong><span>{e.tier === 3 && e.status === 'confirmed' ? t('calls.confirmed') : t(TIER_KEY[e.tier])}</span></div>
          <div className="call-body">
            <h2>{s(e.patientName)}</h2>
            <p className="call-place">{t('calls.place', { municipality: e.municipality, zone: e.zone ?? '', time: ago(e.openedAt, t) })}</p>
            <ul className="call-reasons">{e.reasons.map((r) => <li key={r}>{s(r)}</li>)}</ul>
            <p className="call-needs">{e.needs.map((n) => needText(n, t)).join(' · ')}</p>
            <p className="call-checkin">{e.checkinReplyAt ? t('calls.replied', { time: ago(e.checkinReplyAt, t) }) : e.checkinSentAt ? t('calls.sent', { time: ago(e.checkinSentAt, t) }) : t('calls.noCheckin')}</p>
          </div>
          <div className="call-actions">
            {e.claimedBy
              ? <p className={mine ? 'claimed mine' : 'claimed'}>{mine ? t('calls.ownCase') : t('case.takenBy', { org: s(e.claimedBy) })}</p>
              : user.role === 'coordinator' && <button disabled={busy} onClick={() => act(() => api.events[':id'].claim.$post({ param: { id: String(e.eventId) } }))}>{t('calls.claim')}</button>}
            <button className="quiet" aria-expanded={openId === e.eventId} onClick={() => setOpenId(openId === e.eventId ? null : e.eventId)}>
              {openId === e.eventId ? t('common.close') : t('common.viewCase')}
            </button>
          </div>
          {openId === e.eventId && <EventDetail key={`${e.eventId}-${e.status}-${e.checkinReplyAt}-${e.claimedByOrgId}`} id={e.eventId} user={user} busy={busy} act={act} />}
        </li>
      })}
    </ol>
  </>
}

function EventDetail({ id, user, busy, act }: { id: number; user: Persona; busy: boolean; act: (request: () => Promise<Response>) => Promise<boolean> }) {
  const t = useT()
  const s = useServerText()
  const lang = useLang()
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
      setError(t('case.loadError'))
    }
  }, [id])
  useEffect(() => { void load() }, [load])

  // The automatic reading is stored a few seconds after the reply; look again while it is still on its way.
  const awaitingReading = !!detail?.checkin?.replyAt && !detail.checkin.aiParsed && Date.now() - Date.parse(detail.checkin.replyAt) < 60_000
  // New WhatsApp messages arrive on their own: look again while the case is open.
  useEffect(() => {
    if (!detail?.whatsapp) return
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [detail?.whatsapp, load])
  useEffect(() => {
    if (!awaitingReading) return
    const timer = setTimeout(load, 3000)
    return () => clearTimeout(timer)
  }, [awaitingReading, detail, load])

  if (error) return <p role="alert" className="call-detail connection-error">{s(error)}</p>
  if (!detail) return <p className="call-detail">{t('case.loading')}</p>
  const { event, checkin, outcomes } = detail
  const canConfirm = user.role === 'coordinator' && checkin?.replyText && (event.status === 'possible' || event.status === 'confirmed')
  const confirm = (hasPower: boolean) => act(() => api.checkins[':id'].confirm.$post({ param: { id: String(checkin!.id) }, json: { hasPower } }))

  return <div className="call-detail">
    <section>
      <h3>{t('case.reply')}</h3>
      {checkin ? <>
        <p className="question">{s(checkin.message)}</p>
        {checkin.replyText
          ? <blockquote>{checkin.replyText}<footer>{t('case.original', { time: ago(checkin.replyAt!, t) })}</footer></blockquote>
          : <p className="muted">{t('case.noReply')}</p>}
        {checkin.aiParsed ? <div className="automatic-reading">
          <p>{t('case.reading', { power: ({ no: t('case.noPower'), yes: t('case.hasPower'), unclear: t('case.unclearPower') })[checkin.aiParsed.hasPower], battery: checkin.aiParsed.batteryHours !== null ? t('case.battery', { hours: checkin.aiParsed.batteryHours }) : '' })}</p>
          <p>{lang === 'en' ? checkin.aiParsed.summaryEn ?? checkin.aiParsed.summary : checkin.aiParsed.summary}</p>
          <p className="muted">{t('case.readingNote')}</p>
        </div> : checkin.replyText && <p className="muted">{t('case.noReading')}</p>}
        {checkin.confirmedAt && <p className="muted">{t('case.confirmedAt', { time: ago(checkin.confirmedAt, t) })}</p>}
        {canConfirm && <p className="confirm-actions">
          <button disabled={busy} onClick={() => confirm(false)}>{t('case.confirmNoPower')}</button>
          <button className="quiet" disabled={busy} onClick={() => confirm(true)}>{t('case.confirmPower')}</button>
        </p>}
      </> : <p className="muted">{t('case.noCheckin')}</p>}
    </section>

    <section>
      <h3>{t('case.call')}</h3>
      <p>{t('case.phone')} <strong>{event.phone ?? t('case.noPhone')}</strong></p>
      {event.lat !== null && event.lng !== null && <p>{t('case.location')} <a href={`https://www.google.com/maps/search/?api=1&query=${event.lat},${event.lng}`} target="_blank" rel="noreferrer">
        {event.lat.toFixed(5)}, {event.lng.toFixed(5)}</a> <span className="muted">{t('case.locationAccuracy', { meters: Math.round(event.locationAccuracyM ?? 0) })}</span></p>}
      {outcomes.map((o) => <p key={o.id} className="outcome">
        <strong>{o.reached ? t('case.reached') : t('case.notReached')}</strong> · {o.outcome}{o.nextAction ? t('case.nextStep', { action: o.nextAction }) : ''}
        <span className="muted"> ({s(o.coordinator)}, {ago(o.createdAt, t)})</span>
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
            <label className="check"><input type="checkbox" checked={reached} onChange={(ev) => setReached(ev.target.checked)} /> {t('case.spoke')}</label>
            <label>{t('case.outcome')}<input required maxLength={500} value={outcome} onChange={(ev) => setOutcome(ev.target.value)} /></label>
            <label>{t('case.nextAction')}<input maxLength={500} value={nextAction} onChange={(ev) => setNextAction(ev.target.value)} /></label>
            <button disabled={busy || !outcome.trim()}>{t('case.save')}</button>
          </form>
        : <p className="muted">{event.claimedBy ? t('case.onlyOrg', { org: s(event.claimedBy) }) : t('case.claimFirst')}</p>}
    </section>
    {detail.whatsapp && <Chat id={id} mine={event.mine} messages={detail.messages} busy={busy} act={act} reload={load} />}
    <BriefingSection event={event} initial={detail.briefing} reload={load} />
  </div>
}

// WhatsApp with the patient or caregiver. Only the organization that took the case writes; every word is the coordinator's.
function Chat({ id, mine, messages, busy, act, reload }: { id: number; mine: boolean; messages: Detail['messages']; busy: boolean
  act: (request: () => Promise<Response>) => Promise<boolean>; reload: () => Promise<void> }) {
  const t = useT()
  const s = useServerText()
  const [text, setText] = useState('')
  return <section>
    <h3>{t('chat.title')}</h3>
    {messages.length ? <ol className="chat-log">{messages.map((m) => <li key={m.id} className={m.dir}>
      <p>{m.body}</p>
      <small className="muted">{m.dir === 'in' ? t('chat.them') : m.sentBy ? s(m.sentBy) : t('chat.auto')} · {ago(m.createdAt, t)}</small>
      {m.error && <small role="alert" className="chat-error">{t('chat.failed', { error: m.error })}</small>}
    </li>)}</ol> : <p className="muted">{t('chat.empty')}</p>}
    {mine
      ? <form className="outcome-form" onSubmit={async (ev) => {
          ev.preventDefault()
          const sent = await act(() => api.events[':id'].messages.$post({ param: { id: String(id) }, json: { text } }))
          if (sent) setText('') // keep what the coordinator typed if it did not go out
          await reload()
        }}>
          <label>{t('chat.write')}<textarea required maxLength={1000} rows={2} value={text} onChange={(ev) => setText(ev.target.value)} /></label>
          <button disabled={busy || !text.trim()}>{t('chat.send')}</button>
        </form>
      : <p className="muted">{t('chat.claimFirst')}</p>}
  </section>
}

function BriefingSection({ event, initial, reload }: { event: Detail['event']; initial: Detail['briefing']; reload: () => Promise<void> }) {
  const t = useT()
  const s = useServerText()
  const [briefing, setBriefing] = useState(initial)
  const [text, setText] = useState(initial?.approvedText ?? initial?.draftText ?? '')
  const [busy, setBusy] = useState<'draft' | 'approve' | null>(null)
  const [error, setError] = useState('')
  const [byHand, setByHand] = useState(false) // the coordinator writes it; also the way out when the automatic draft fails

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
      const res = await api.events[':id'].briefing.$post({ param: { id: String(event.id) }, json: { lang: getLang() } })
      if (!res.ok) { setError(await errorText(res)); setByHand(true) }
      else {
        const data: InferResponseType<typeof api.events[':id']['briefing']['$post'], 201> = await res.json()
        setBriefing({ id: data.id, draftText: data.draftText, approvedText: null, approvedAt: null })
        setText(data.draftText)
      }
    } catch { setError(t('briefing.draftError')); setByHand(true) }
    finally { setBusy(null) }
  }
  const approve = async () => {
    setBusy('approve')
    setError('')
    try {
      let id = briefing?.id
      if (id === undefined) { // written by hand: store it first, then approve it like any other
        const made = await api.events[':id'].briefing.$post({ param: { id: String(event.id) }, json: { text } })
        if (!made.ok) return setError(await errorText(made))
        id = ((await made.json()) as InferResponseType<typeof api.events[':id']['briefing']['$post'], 201>).id
      }
      const res = await api.briefings[':id'].approve.$post({ param: { id: String(id) }, json: { text } })
      if (!res.ok) setError(await errorText(res))
      else { setByHand(false); await reload() }
    } catch { setError(t('briefing.approveError')) }
    finally { setBusy(null) }
  }

  return <section className="outcome-form briefing">
    <h3>{t('briefing.title')}</h3>
    {error && <p role="alert" className="connection-error">{s(error)}</p>}
    {event.mine ? <>
      {(briefing || byHand) && <>
        <label>{t('briefing.summary')}<textarea rows={10} maxLength={4000} value={text} disabled={busy !== null} onChange={(ev) => setText(ev.target.value)} /></label>
        <p className="muted">{briefing ? t('briefing.review') : t('briefing.manualNote')}</p>
        <button disabled={busy !== null || !text.trim() || text.length > 4000} onClick={approve}>{busy === 'approve' ? t('briefing.approving') : t('briefing.approve')}</button>
        <p className="muted" aria-live="polite">{briefing?.approvedAt ? t('briefing.approvedAt', { time: ago(briefing.approvedAt, t) }) : ''}</p>
      </>}
      <button className={briefing ? 'quiet' : undefined} disabled={busy !== null} onClick={draft}>{busy === 'draft' ? t('briefing.drafting') : briefing ? t('briefing.redraft') : t('briefing.draft')}</button>
      {!briefing && !byHand && <button className="quiet" disabled={busy !== null} onClick={() => setByHand(true)}>{t('briefing.manual')}</button>}
    </> : <>
      <p className="muted">{event.claimedBy ? t('briefing.onlyOrg', { org: s(event.claimedBy) }) : t('briefing.claimFirst')}</p>
      {briefing?.approvedAt && <p className="briefing-text">{briefing.approvedText}</p>}
    </>}
  </section>
}
