import { useCallback, useEffect, useRef, useState } from 'react'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { api } from './api.ts'
import { MUNICIPALITIES } from '../server/municipalities.ts'

type Mine = InferResponseType<typeof api.patients.mine.$get, 200>
type Pending = InferResponseType<typeof api.checkins.pending.$get, 200>['checkins']
type Profile = InferRequestType<typeof api.patients.$post>['json']['profile']
type Kind = Profile['needs'][number]['kind']
type Draft = Omit<Profile, 'municipality'> & { municipality: Profile['municipality'] | null }

const NEED_LABEL: Record<Kind, string> = {
  oxygen: 'Concentrador de oxígeno', cpap: 'CPAP', ventilator: 'Ventilador', dialysis: 'Diálisis', insulin: 'Insulina (nevera)', other: 'Otro equipo',
}
const STATUS_LABEL = { possible: 'Posible apagón: conteste el mensaje', confirmed: 'Apagón confirmado' } as const
const EMPTY: Draft = { displayName: '', phone: null, municipality: null, zone: null, needs: [] }

// Shows the server's { error } string, or the status code.
const errorOf = async (res: Response) => {
  const { error } = (await res.json().catch(() => ({}))) as { error?: unknown }
  return typeof error === 'string' ? error : `Error ${res.status}`
}

// Caregiver area (/app): a person, facility staff or a self-registered patient. Everything is scoped by the server.
export default function Caregiver() {
  const [mine, setMine] = useState<Mine | null>(null)
  const [pending, setPending] = useState<Pending>([])
  const [denied, setDenied] = useState('')

  const load = useCallback(async () => {
    const [m, p] = await Promise.all([api.patients.mine.$get(), api.checkins.pending.$get()])
    if (!m.ok) return setDenied(await errorOf(m))
    setDenied('')
    setMine(await m.json())
    if (p.ok) setPending((await p.json()).checkins)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15_000) // the demo's patient phone: new check-ins show up on their own
    return () => clearInterval(t)
  }, [load])

  if (denied) return <p role="alert">{denied}. Use "Ver como" para entrar como una persona cuidadora.</p>
  if (!mine) return <p>Cargando…</p>

  return (
    <div className="area">
      <section>
        <h2>Mensajes pendientes ({pending.length})</h2>
        {pending.length === 0 && <p>No hay mensajes por contestar.</p>}
        {pending.map((c) => <Reply key={c.id} checkin={c} onDone={load} />)}
      </section>

      <section>
        <h2>{mine.isFacility ? 'Residentes del hogar' : 'Mis pacientes'}</h2>
        {mine.patients.length === 0 && <p>Todavía no hay pacientes registrados.</p>}
        <ul className="cards">
          {mine.patients.map((p) => (
            <li key={p.id} className={p.eventStatus ? 'card alert' : 'card'}>
              <strong>{p.displayName}</strong>{p.isSelf ? ' (usted)' : ''}
              <div>{p.municipality}{p.zone ? ` · ${p.zone}` : ' · zona sin identificar'}</div>
              <div>{p.needs.map((n) => NEED_LABEL[n.kind] + (n.batteryHours != null ? ` (batería ${n.batteryHours} h)` : '')).join(', ')}</div>
              <div className="status">{p.eventStatus ? STATUS_LABEL[p.eventStatus] : 'Sin alertas'}</div>
            </li>
          ))}
        </ul>
      </section>

      <Intake canSelf={!mine.hasSelf && !mine.isFacility} isFacility={mine.isFacility} onSaved={load} />
    </div>
  )
}

function Reply({ checkin, onDone }: { checkin: Pending[number]; onDone: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const send = async () => {
    setBusy(true)
    const res = await api.checkins[':id'].reply.$post({ param: { id: String(checkin.id) }, json: { text } })
    setBusy(false)
    if (!res.ok) return setError(await errorOf(res))
    onDone()
  }
  return (
    <form className="card alert" onSubmit={(e) => { e.preventDefault(); send() }}>
      <strong>{checkin.patientName}</strong>: {checkin.message}
      <textarea required rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Escriba su respuesta, por ejemplo: «No tenemos luz, la batería dura 2 horas»" />
      <button disabled={busy || !text.trim()}>{busy ? 'Enviando…' : 'Responder'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

// Who → tell (voice or text) → AI draft → review + consent → save. The AI draft is never saved as-is.
function Intake({ canSelf, isFacility, onSaved }: { canSelf: boolean; isFacility: boolean; onSaved: () => void }) {
  const [step, setStep] = useState<'who' | 'tell' | 'review'>('who')
  const [isSelf, setIsSelf] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [intakeId, setIntakeId] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [zones, setZones] = useState<string[]>([])
  const [consent, setConsent] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const start = (self: boolean) => { setIsSelf(self); setStep('tell') }
  const reset = () => { setStep('who'); setTranscript(''); setIntakeId(null); setDraft(EMPTY); setZones([]); setConsent(false); setNote('') }

  const extract = async () => {
    setBusy(true)
    const res = await api.intake.extract.$post({ json: { transcript } })
    setBusy(false)
    if (!res.ok) return setNote(await errorOf(res))
    const r = await res.json()
    setIntakeId(r.intakeId)
    setDraft(r.draft ? { ...r.draft, displayName: r.draft.displayName ?? '' } : EMPTY)
    setZones(r.zones)
    setNote(r.warning ?? 'Revise lo que entendió la IA y corrija lo que haga falta.')
    setStep('review')
  }

  const pickMunicipality = async (m: Profile['municipality']) => {
    setDraft({ ...draft, municipality: m, zone: null })
    const res = await api.zones.$get({ query: { municipality: m } })
    setZones(res.ok ? (await res.json()).zones : [])
  }

  const toggleNeed = (kind: Kind) =>
    setDraft({ ...draft, needs: draft.needs.some((n) => n.kind === kind) ? draft.needs.filter((n) => n.kind !== kind) : [...draft.needs, { kind, batteryHours: null }] })
  const setBattery = (kind: Kind, v: string) =>
    setDraft({ ...draft, needs: draft.needs.map((n) => (n.kind === kind ? { ...n, batteryHours: v === '' ? null : Number(v) } : n)) })

  const save = async () => {
    if (!draft.municipality) return setNote('Elija el municipio.')
    setBusy(true)
    const res = await api.patients.$post({ json: { intakeId, isSelf, consent: true, profile: { ...draft, municipality: draft.municipality } } })
    setBusy(false)
    if (!res.ok) return setNote(await errorOf(res))
    reset()
    onSaved()
  }

  return (
    <section>
      <h2>Nuevo registro</h2>
      {step === 'who' && (
        <>
          <p>¿Para quién es este registro?</p>
          {canSelf && <button onClick={() => start(true)}>Para mí</button>}{' '}
          <button onClick={() => start(false)}>{isFacility ? 'Para un residente del hogar' : 'Para otra persona'}</button>
        </>
      )}

      {step === 'tell' && (
        <>
          <p>Cuéntenos {isSelf ? 'sobre usted' : 'sobre la persona'}: nombre, municipio y urbanización o barrio, qué equipo usa y cuántas horas le dura la batería.</p>
          <Dictate onText={(t) => setTranscript((prev) => (prev ? `${prev} ${t}` : t))} />
          <textarea rows={4} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="Ejemplo: Mi mamá, Doña Carmen, vive en la Urbanización Villa Blanca en Caguas. Usa concentrador de oxígeno y la batería le dura 2 horas." />
          <button disabled={busy || transcript.trim().length < 5} onClick={extract}>{busy ? 'Leyendo…' : 'Continuar'}</button>{' '}
          <button className="link" onClick={() => { setNote(''); setStep('review') }}>Llenar a mano</button>{' '}
          <button className="link" onClick={reset}>Cancelar</button>
          {note && <p role="alert">{note}</p>}
        </>
      )}

      {step === 'review' && (
        <form className="review" onSubmit={(e) => { e.preventDefault(); save() }}>
          {note && <p className="note">{note}</p>}
          {transcript && <blockquote>Lo que nos dijo: «{transcript}»</blockquote>}
          <label>Nombre <input required minLength={2} value={draft.displayName ?? ''} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} /></label>
          <label>Teléfono <input value={draft.phone ?? ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value || null })} /></label>
          <label>Municipio{' '}
            <select required value={draft.municipality ?? ''} onChange={(e) => pickMunicipality(e.target.value as Profile['municipality'])}>
              <option value="" disabled>Elegir…</option>
              {MUNICIPALITIES.map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label>Zona de LUMA{' '}
            <select value={draft.zone ?? ''} onChange={(e) => setDraft({ ...draft, zone: e.target.value || null })}>
              <option value="">No sé / no aparece</option>
              {zones.map((z) => <option key={z}>{z}</option>)}
            </select>
          </label>
          <fieldset>
            <legend>Equipos y tratamientos</legend>
            {(Object.keys(NEED_LABEL) as Kind[]).map((k) => {
              const need = draft.needs.find((n) => n.kind === k)
              return (
                <div key={k}>
                  <label><input type="checkbox" checked={!!need} onChange={() => toggleNeed(k)} /> {NEED_LABEL[k]}</label>
                  {need && ['oxygen', 'cpap', 'ventilator'].includes(k) && (
                    <label> · batería (horas) <input type="number" min={0} max={240} step={0.5} value={need.batteryHours ?? ''} onChange={(e) => setBattery(k, e.target.value)} /></label>
                  )}
                </div>
              )
            })}
          </fieldset>
          <label className="consent">
            <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
            {isSelf ? 'Acepto' : 'La persona registrada (o su representante) acepta'} que VitalPower guarde estos datos y los comparta con organizaciones de respuesta aprobadas durante un apagón.
          </label>
          <button disabled={busy || !consent || draft.needs.length === 0}>{busy ? 'Guardando…' : 'Confirmar y guardar'}</button>{' '}
          <button type="button" className="link" onClick={reset}>Cancelar</button>
        </form>
      )}
    </section>
  )
}

// Web Speech (es-PR) where the browser has it; the textarea is always there as the fallback.
function Dictate({ onText }: { onText: (t: string) => void }) {
  const Recognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
  const rec = useRef<any>(null)
  const [listening, setListening] = useState(false)
  if (!Recognition) return null
  const toggle = () => {
    if (listening) return rec.current?.stop()
    const r = new Recognition()
    r.lang = 'es-PR'
    r.onresult = (e: any) => onText(Array.from(e.results as ArrayLike<any>).map((x) => x[0].transcript).join(' '))
    r.onend = () => setListening(false)
    rec.current = r
    r.start()
    setListening(true)
  }
  return <button type="button" className={listening ? 'mic on' : 'mic'} onClick={toggle}>{listening ? '■ Detener' : '🎤 Hablar'}</button>
}
