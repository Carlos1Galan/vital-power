import { useEffect, useRef, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import { errorText, MUNICIPALITIES, NEED_LABEL } from './lib.ts'
import Select from 'react-select'
import { selectStyles, type SelectOption } from './selectStyles.ts'

type Extraction = InferResponseType<typeof api.intake.extract.$post, 200>
type Zones = InferResponseType<typeof api.zones[':municipality']['$get'], 200>['zones']
type Kind = Extraction['profile']['needs'][number]['kind']
type Municipality = NonNullable<Extraction['profile']['municipality']>
type NeedRow = { kind: Kind | ''; batteryHours: string }
interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
const SpeechRecognition = (window as Window & {
  SpeechRecognition?: new () => Recognition
  webkitSpeechRecognition?: new () => Recognition
}).SpeechRecognition ?? (window as Window & { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition
// Plain reasons for the dictation errors a person can act on. "network" is what Brave reports: it blocks the speech service Chrome uses.
const VOICE_ERROR: Record<string, string> = {
  network: 'El dictado no funciona en este navegador. Abra la página en Chrome o Edge, o escriba aquí.',
  'not-allowed': 'El navegador no tiene permiso para usar el micrófono. Puede escribir.',
  'service-not-allowed': 'El navegador no tiene permiso para usar el micrófono. Puede escribir.',
  'audio-capture': 'No encontramos un micrófono. Puede escribir.',
  'no-speech': 'No escuchamos nada. Acérquese al micrófono e intente de nuevo.',
}
const emptyNeed = (): NeedRow => ({ kind: '', batteryHours: '' })

export default function Intake({ hasSelf, onCancel, onSaved }: { hasSelf: boolean; onCancel: () => void; onSaved: () => Promise<void> }) {
  const [step, setStep] = useState(1)
  const [isSelf, setIsSelf] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [reviewedTranscript, setReviewedTranscript] = useState<string | null>(null)
  const [intakeId, setIntakeId] = useState<Extraction['intakeId']>()
  const [automatic, setAutomatic] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [municipality, setMunicipality] = useState<Municipality | ''>('')
  const [zone, setZone] = useState('')
  const [zones, setZones] = useState<Zones>([])
  const [needs, setNeeds] = useState<NeedRow[]>([emptyNeed()])
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [zonesBusy, setZonesBusy] = useState(false)
  const [error, setError] = useState('')
  const [zoneError, setZoneError] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const [listening, setListening] = useState(false)
  const [hearing, setHearing] = useState('') // words heard so far in the current phrase, shown live
  const recognition = useRef<Recognition | null>(null)
  const initialZones = useRef<{ municipality: Municipality; zones: Zones } | null>(null)

  useEffect(() => () => {
    const current = recognition.current
    if (current) {
      current.onresult = null
      current.onerror = null
      current.onend = null
      current.stop()
    }
  }, [])

  useEffect(() => {
    let active = true
    setZoneError('')
    if (!municipality) {
      setZones([])
      setZone('')
      setZonesBusy(false)
      return
    }
    const accept = (list: Zones) => {
      setZones(list)
      setZone((current) => list.includes(current) ? current : '')
    }
    if (initialZones.current?.municipality === municipality) {
      accept(initialZones.current.zones)
      setZonesBusy(false)
      return
    }
    setZonesBusy(true)
    void (async () => {
      try {
        const res = await api.zones[':municipality'].$get({ param: { municipality } })
        if (!res.ok) throw new Error(await errorText(res))
        const data: InferResponseType<typeof api.zones[':municipality']['$get'], 200> = await res.json()
        if (active) accept(data.zones)
      } catch {
        if (active) {
          accept([])
          setZoneError('No se pudieron cargar las zonas. Puede guardar sin zona.')
        }
      } finally { if (active) setZonesBusy(false) }
    })()
    return () => { active = false }
  }, [municipality])

  const stop = () => { recognition.current?.stop(); setListening(false) }
  const speak = () => {
    if (listening) return stop()
    if (!SpeechRecognition) return
    setVoiceError('')
    try {
      const previous = recognition.current
      if (previous) {
        previous.onresult = null
        previous.onerror = null
        previous.onend = null
        previous.stop()
      }
      const current = new SpeechRecognition()
      recognition.current = current
      current.lang = 'es-PR'
      current.interimResults = true
      current.continuous = true
      current.onresult = (event) => {
        let final = '', interim = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) final += ` ${event.results[i][0].transcript}`
          else interim += event.results[i][0].transcript
        }
        setHearing(interim)
        if (final) setTranscript((text) => `${text}${final}`.trim().slice(0, 4000))
      }
      current.onerror = (event) => { setListening(false); setHearing(''); setVoiceError(VOICE_ERROR[event.error] ?? 'No se pudo usar el micrófono. Puede escribir.') }
      current.onend = () => { setListening(false); setHearing('') }
      current.start()
      setListening(true)
    } catch { setListening(false); setVoiceError('No se pudo usar el micrófono. Puede escribir.') }
  }
  const clearForm = () => {
    initialZones.current = null
    setIntakeId(undefined)
    setAutomatic(false)
    setName('')
    setPhone('')
    setMunicipality('')
    setZone('')
    setZones([])
    setZoneError('')
    setNeeds([emptyNeed()])
    setConsent(false)
  }
  const extract = async () => {
    stop()
    if (reviewedTranscript === transcript) return setStep(3)
    setBusy(true)
    setError('')
    try {
      const res = await api.intake.extract.$post({ json: { transcript } })
      if (!res.ok) throw new Error(await errorText(res))
      const data: Extraction = await res.json()
      const p = data.profile
      initialZones.current = p.municipality ? { municipality: p.municipality, zones: data.zones } : null
      setIntakeId(data.intakeId)
      setAutomatic(true)
      setName(p.displayName ?? '')
      setPhone(p.phone ?? '')
      setMunicipality(p.municipality ?? '')
      setZones(data.zones)
      setZone(p.zone && data.zones.includes(p.zone) ? p.zone : '')
      setNeeds(p.needs.length ? p.needs.map((n) => ({ kind: n.kind, batteryHours: n.batteryHours === null ? '' : String(n.batteryHours) })) : [emptyNeed()])
    } catch {
      clearForm()
      setError('No pudimos leerlo automáticamente. Llene los datos a mano.')
    } finally {
      setConsent(false)
      setReviewedTranscript(transcript)
      setStep(3)
      setBusy(false)
    }
  }
  const valid = name.trim().length > 0 && name.length <= 80 && phone.length <= 30 && municipality !== '' && needs.length <= 6 && needs.every((n) =>
    n.kind !== '' && (n.batteryHours === '' || (Number.isFinite(Number(n.batteryHours)) && Number(n.batteryHours) >= 0 && Number(n.batteryHours) <= 240 && Number(n.batteryHours) % 0.5 === 0)))
  const save = async () => {
    if (!valid || !consent || !municipality) return
    const completeNeeds = needs.flatMap((n) => n.kind ? [{ kind: n.kind, batteryHours: n.batteryHours === '' ? null : Number(n.batteryHours) }] : [])
    setBusy(true)
    setError('')
    try {
      const res = await api.patients.$post({ json: { intakeId, isSelf, consent: true, profile: {
        displayName: name.trim(), phone: phone.trim(), municipality, zone: zone || null, needs: completeNeeds,
      } } })
      if (!res.ok) setError(await errorText(res))
      else await onSaved()
    } catch { setError('No se pudo guardar el registro. Intente de nuevo.') }
    finally { setBusy(false) }
  }

  return <section className="card intake">
    <p className="muted" aria-live="polite">Paso {step} de 3</p>
    <h1 className="question">{step === 1 ? '¿Para quién es este registro?' : step === 2 ? 'Cuéntenos' : 'Revise antes de guardar'}</h1>
    {error && <p role="alert" className="connection-error">{error}</p>}
    {step === 1 && <div className="quick-replies">
      {!hasSelf && <button onClick={() => { setIsSelf(true); setStep(2) }}>Para mí</button>}
      <button onClick={() => { setIsSelf(false); setStep(2) }}>Para otra persona</button>
    </div>}
    {step === 2 && <div className="intake-fields">
      <label>Diga o escriba quién es, dónde vive y qué equipo o medicamento depende de la luz.
        <textarea rows={6} maxLength={4000} disabled={busy} value={transcript} onChange={(ev) => setTranscript(ev.target.value)} placeholder="Ejemplo: mi papá, Don Ramón, vive en Caguas, usa un concentrador de oxígeno con batería para dos horas y tiene insulina en la nevera." />
      </label>
      {SpeechRecognition && <button className="quiet" disabled={busy} onClick={speak}>{listening ? 'Detener' : 'Hablar'}</button>}
      <p className="muted" aria-live="polite">{listening ? `Escuchando… ${hearing}` : ''}</p>
      {voiceError && <p role="alert" className="connection-error">{voiceError}</p>}
      <button disabled={busy || transcript.trim().length < 3} onClick={extract}>{busy ? 'Leyendo lo que nos contó…' : 'Continuar'}</button>
      <button className="quiet intake-link" disabled={busy} onClick={() => {
        stop()
        if (automatic || reviewedTranscript === null) clearForm()
        setError('')
        setReviewedTranscript(transcript)
        setStep(3)
      }}>Prefiero llenar los datos a mano</button>
    </div>}
    {step === 3 && <form className="intake-fields" onSubmit={(ev) => { ev.preventDefault(); void save() }}>
      {automatic && <p className="muted">Esto lo llenamos automáticamente con lo que nos contó. Corrija lo que esté mal.</p>}
      <label>Nombre o cómo le llamamos<input required maxLength={80} value={name} onChange={(ev) => setName(ev.target.value)} /></label>
      <label>Teléfono<input maxLength={30} inputMode="tel" value={phone} onChange={(ev) => setPhone(ev.target.value)} /></label>
      <label htmlFor="intake-municipality">Municipio<Select<SelectOption, false>
        inputId="intake-municipality"
        classNamePrefix="vp-select"
        required
        options={MUNICIPALITIES.map((m) => ({ value: m, label: m }))}
        value={municipality ? { value: municipality, label: municipality } : null}
        onChange={(option) => {
          initialZones.current = null
          setZones([])
          setZonesBusy(!!option)
          setMunicipality((option?.value ?? '') as Municipality | '')
      }} placeholder="Elija un municipio" isSearchable styles={selectStyles} /></label>
      <label htmlFor="intake-zone">Zona o barrio<Select<SelectOption, false>
        inputId="intake-zone"
        classNamePrefix="vp-select"
        options={zones.map((z) => ({ value: z, label: z }))}
        value={zones.includes(zone) && zone ? { value: zone, label: zone } : null}
        isDisabled={zonesBusy}
        isLoading={zonesBusy}
        onChange={(option) => setZone(option?.value ?? '')}
        placeholder="No aparece o no sé"
        isClearable
        isSearchable
        styles={selectStyles}
      /></label>
      {zonesBusy ? <p className="muted" aria-live="polite">Cargando zonas…</p> : municipality && !zones.length && <p className="muted">Todavía no tenemos zonas para este municipio. Puede guardar sin zona.</p>}
      {zoneError && <p role="alert" className="connection-error">{zoneError}</p>}
      <h2 className="question">Equipo o medicamento que depende de la luz</h2>
      {needs.map((n, i) => <div className="need-row" key={i}>
        <label htmlFor={`intake-need-${i}`}>Equipo o medicamento {i + 1}<Select<SelectOption, false>
          inputId={`intake-need-${i}`}
          classNamePrefix="vp-select"
          required
          options={Object.entries(NEED_LABEL).map(([kind, label]) => ({ value: kind, label }))}
          value={n.kind ? { value: n.kind, label: NEED_LABEL[n.kind] } : null}
          onChange={(option) => setNeeds(needs.map((row, index) => index === i ? { ...row, kind: (option?.value ?? '') as Kind | '' } : row))}
          placeholder="Elija uno"
          isSearchable
          styles={selectStyles}
        /></label>
        <label>Horas de batería (si tiene)<input type="number" min={0} max={240} step={0.5} value={n.batteryHours} onChange={(ev) => setNeeds(needs.map((row, index) => index === i ? { ...row, batteryHours: ev.target.value } : row))} /></label>
        <button type="button" className="quiet" disabled={needs.length === 1} onClick={() => setNeeds(needs.filter((_, index) => index !== i))}>Quitar</button>
      </div>)}
      <button type="button" className="quiet" disabled={needs.length >= 6} onClick={() => setNeeds([...needs, emptyNeed()])}>Añadir otro</button>
      <label className="check"><input type="checkbox" required checked={consent} onChange={(ev) => setConsent(ev.target.checked)} />Autorizo a que una organización de respuesta me llame si hay un apagón en mi zona. Estos datos son de demostración.</label>
      <button disabled={busy || zonesBusy || !consent || !valid}>{busy ? 'Guardando…' : 'Guardar registro'}</button>
    </form>}
    <div className="quick-replies">
      {step > 1 && <button className="quiet" disabled={busy} onClick={() => { stop(); setStep(step - 1) }}>Volver</button>}
      <button className="quiet" disabled={busy} onClick={onCancel}>Cancelar</button>
    </div>
  </section>
}
