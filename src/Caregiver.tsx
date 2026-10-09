import { useCallback, useEffect, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import { ago, errorText, needText } from './lib.ts'
import Intake from './Intake.tsx'

type Patient = InferResponseType<typeof api.patients.mine.$get, 200>['patients'][number]
type Checkin = InferResponseType<typeof api.checkins.pending.$get, 200>['checkins'][number]

const STATUS = {
  possible: ['warn', 'Posible apagón en su zona'],
  confirmed: ['urgent', 'Sin luz, confirmado'],
  none: ['ok', 'Sin apagón reportado'],
} as const

export default function Caregiver({ user }: { user: Persona }) {
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
      setError('No se pudo cargar la información. Intente de nuevo en un momento.')
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
      setError('No se pudo enviar la respuesta. Intente de nuevo.')
    }
    await load()
  }

  if (intake) return <Intake hasSelf={patients?.some((p) => p.isSelf) ?? false} onCancel={() => setIntake(false)} onSaved={async () => {
    setIntake(false)
    setSaved(true)
    await load()
  }} />

  return <section>
    <h1>Hola, {user.name}</h1>
    {error && <p role="alert" className="connection-error">{error}</p>}

    <h2>Avisos</h2>
    {checkins.map((c) => <CheckinCard key={c.id} checkin={c} onReply={reply} />)}
    {!checkins.length && <p className="card empty" aria-live="polite">{sent ? 'Gracias. Su respuesta llegó al equipo de coordinación.' : 'No tiene avisos pendientes.'}</p>}

    <h2>{isPatient ? 'Mi registro' : 'Mis pacientes'}</h2>
    {/* A patient who registered themself has nothing more to register here; caregivers and facility staff add people. */}
    {!(isPatient && patients?.some((p) => p.isSelf)) && <p><button disabled={!patients} onClick={() => { setSaved(false); setIntake(true) }}>{isPatient ? 'Registrarme' : 'Registrar a una persona'}</button></p>}
    <p aria-live="polite">{saved ? 'Registro guardado.' : ''}</p>
    {!patients ? !error && <p>Cargando…</p> : <ul className="patients">
      {patients.map((p) => {
        const [tone, label] = STATUS[p.outage ?? 'none']
        return <li key={p.id} className="card">
          <h3>{p.name}</h3>
          <p className={`status ${tone}`}>{label}</p>
          <p className="muted">{p.municipality}{p.zone ? ` · ${p.zone}` : ''}</p>
          <p>{p.needs.map(needText).join(' · ')}</p>
        </li>
      })}
    </ul>}
  </section>
}

// The demo's "patient phone": one question, two big answers, or their own words.
function CheckinCard({ checkin, onReply }: { checkin: Checkin; onReply: (id: number, text: string) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (value: string) => {
    setBusy(true)
    await onReply(checkin.id, value)
    setBusy(false)
  }

  return <article className="card checkin">
    <p className="muted">Para {checkin.patientName} · enviado {ago(checkin.sentAt)}</p>
    <p className="question">{checkin.message}</p>
    <p className="quick-replies">
      <button disabled={busy} onClick={() => send('No, no hay luz')}>No, no hay luz</button>
      <button className="quiet" disabled={busy} onClick={() => send('Sí, tenemos luz')}>Sí, tenemos luz</button>
    </p>
    <form onSubmit={(ev) => { ev.preventDefault(); void send(text) }}>
      <label>O escriba lo que está pasando
        <textarea rows={2} maxLength={1000} value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Ejemplo: se fue la luz a las 3 y el concentrador tiene batería para dos horas" />
      </label>
      <button className="quiet" disabled={busy || !text.trim()}>Enviar respuesta</button>
    </form>
  </article>
}
