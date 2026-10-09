import { useT, useServerText } from './i18n.ts'
import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import { ago, errorText, needText } from './lib.ts'
import Intake from './Intake.tsx'

type Patient = InferResponseType<typeof api.patients.mine.$get, 200>['patients'][number]
type Checkin = InferResponseType<typeof api.checkins.pending.$get, 200>['checkins'][number]

const STATUS = {
  possible: ['warn', 'caregiver.possible'],
  confirmed: ['urgent', 'caregiver.confirmed'],
  none: ['ok', 'caregiver.none'],
} as const

export default function Caregiver({ user }: { user: Persona }) {
  const t = useT()
  const s = useServerText()
  const [patients, setPatients] = useState<Patient[] | null>(null)
  const [checkins, setCheckins] = useState<Checkin[]>([])
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [intake, setIntake] = useState(false)
  const [saved, setSaved] = useState(false)

  const isPatient = user.personaType === 'self-patient'

  const load = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api.patients.mine.$get(), api.checkins.pending.$get()])
      if (!p.ok) return setError(await errorText(p))
      if (!c.ok) return setError(await errorText(c))
      setPatients((await p.json()).patients)
      setCheckins((await c.json()).checkins)
      setError('')
    } catch {
      setError(t('caregiver.loadError'))
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(load, 15_000)
    return () => clearInterval(timer)
  }, [load])

  const reply = async (id: number, text: string) => {
    setError('')
    try {
      const res = await api.checkins[':id'].reply.$post({ param: { id: String(id) }, json: { text } })
      if (res.ok) setSent(true)
      else setError(await errorText(res))
    } catch {
      setError(t('caregiver.replyError'))
    }
    await load()
  }

  if (intake) return <Intake hasSelf={patients?.some((p) => p.isSelf) ?? false} onCancel={() => setIntake(false)} onSaved={async () => {
    setIntake(false)
    setSaved(true)
    await load()
  }} />

  return <section>
    <h1>{t('caregiver.greeting', { name: s(user.name) })}</h1>
    {error && <p role="alert" className="connection-error">{s(error)}</p>}

    <h2 id="avisos">{t('caregiver.alerts')}</h2>
    {checkins.map((c) => <CheckinCard key={c.id} checkin={c} onReply={reply} />)}
    {!checkins.length && <p className="card empty" aria-live="polite">{sent ? t('caregiver.thanks') : t('caregiver.noAlerts')}</p>}

    <h2>{isPatient ? t('caregiver.myRecord') : t('caregiver.myPatients')}</h2>
    {/* A patient who registered themself has nothing more to register here; caregivers and facility staff add people. */}
    {!(isPatient && patients?.some((p) => p.isSelf)) && <p><button disabled={!patients} onClick={() => { setSaved(false); setIntake(true) }}>{isPatient ? t('caregiver.registerSelf') : t('caregiver.registerPerson')}</button></p>}
    <p aria-live="polite">{saved ? t('caregiver.saved') : ''}</p>
    {!patients ? !error && <p>{t('common.loading')}</p> : <ul className="patients">
      {patients.map((p) => {
        const [tone, label] = STATUS[p.outage ?? 'none']
        return <li key={p.id} className="card">
          <h3>{s(p.name)}</h3>
          <p className={`status ${tone}`}>{t(label)}</p>
          <p className="muted">{p.municipality}{p.zone ? ` · ${p.zone}` : ''}</p>
          <p>{p.needs.map((n) => needText(n, t)).join(' · ')}</p>
          {p.claimedBy && <p className="case-taken">{t('caregiver.takenBy', { org: s(p.claimedBy) })}</p>}
          {p.lastCall && <p className="case-call">
            <strong>{t(p.lastCall.reached ? 'caregiver.called' : 'caregiver.attemptedCall', { time: ago(p.lastCall.createdAt, t) })}</strong> {p.lastCall.outcome}
            {p.lastCall.nextAction ? t('caregiver.nextStep', { action: p.lastCall.nextAction }) : ''}
          </p>}
        </li>
      })}
    </ul>}
  </section>
}

// The demo's "patient phone": one question, two big answers, or their own words.
function CheckinCard({ checkin, onReply }: { checkin: Checkin; onReply: (id: number, text: string) => Promise<void> }) {
  const t = useT()
  const s = useServerText()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (value: string) => {
    setBusy(true)
    await onReply(checkin.id, value)
    setBusy(false)
  }

  return <article className="card checkin">
    <p className="muted">{t('caregiver.sentFor', { name: s(checkin.patientName), time: ago(checkin.sentAt, t) })}</p>
    <p className="question">{s(checkin.message)}</p>
    <p className="quick-replies">
      <button disabled={busy} onClick={() => send(t('caregiver.noPower'))}>{t('caregiver.noPower')}</button>
      <button className="quiet" disabled={busy} onClick={() => send(t('caregiver.hasPower'))}>{t('caregiver.hasPower')}</button>
    </p>
    <form onSubmit={(ev) => { ev.preventDefault(); void send(text) }}>
      <label>{t('caregiver.writeReply')}
        <textarea rows={2} maxLength={1000} value={text} onChange={(ev) => setText(ev.target.value)} placeholder={t('caregiver.replyExample')} />
      </label>
      <button className="quiet" disabled={busy || !text.trim()}>{t('caregiver.sendReply')}</button>
    </form>
  </article>
}
