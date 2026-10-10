import { selectText, useT, useServerText, getLang, type TextKey } from './i18n.ts'
import { useEffect, useRef, useState } from 'react'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import { errorText, MUNICIPALITIES, NEED_KEY } from './lib.ts'
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
const VOICE_ERROR: Record<string, TextKey> = {
  network: 'intake.voiceNetwork',
  'not-allowed': 'intake.voicePermission',
  'service-not-allowed': 'intake.voicePermission',
  'audio-capture': 'intake.noMicrophone',
  'no-speech': 'intake.noSpeech',
}
const emptyNeed = (): NeedRow => ({ kind: '', batteryHours: '' })

// start: the person already said who the registration is for (at sign-up), so step 1 is skipped.
export default function Intake({ hasSelf, start, onCancel, onSaved }: { hasSelf: boolean; start?: 'self' | 'other'; onCancel: () => void; onSaved: () => Promise<void> }) {
  const t = useT()
  const s = useServerText()
  const [step, setStep] = useState(start ? 2 : 1)
  const [isSelf, setIsSelf] = useState(start === 'self' && !hasSelf)
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
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracyM: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState('')
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
          setZoneError(t('intake.zoneError'))
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
      current.lang = getLang() === 'en' ? 'en-US' : 'es-PR'
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
      current.onerror = (event) => { setListening(false); setHearing(''); setVoiceError(t(VOICE_ERROR[event.error] ?? 'intake.voiceError')) }
      current.onend = () => { setListening(false); setHearing('') }
      current.start()
      setListening(true)
    } catch { setListening(false); setVoiceError(t('intake.voiceError')) }
  }
  // Exact location is opt-in: the browser asks for permission only after the person presses the button.
  const locate = () => {
    setLocationError('')
    if (!navigator.geolocation) return setLocationError(t('intake.locationError'))
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => { setLocation({ lat: coords.latitude, lng: coords.longitude, accuracyM: Math.round(coords.accuracy) }); setLocating(false) },
      (err) => { setLocationError(t(err.code === err.PERMISSION_DENIED ? 'intake.locationDenied' : 'intake.locationError')); setLocating(false) },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
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
    setLocation(null)
    setLocationError('')
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
      setError(t('intake.readError'))
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
        displayName: name.trim(), phone: phone.trim(), municipality, zone: zone || null, needs: completeNeeds, location,
      } } })
      if (!res.ok) setError(await errorText(res))
      else await onSaved()
    } catch { setError(t('intake.saveError')) }
    finally { setBusy(false) }
  }

  return <section className="card intake">
    <p className="muted" aria-live="polite">{t('intake.step', { step })}</p>
    <h1 className="question">{step === 1 ? t('intake.who') : step === 2 ? t('intake.tellUs') : t('intake.review')}</h1>
    {error && <p role="alert" className="connection-error">{s(error)}</p>}
    {step === 1 && <div className="quick-replies">
      {!hasSelf && <button onClick={() => { setIsSelf(true); setStep(2) }}>{t('intake.forMe')}</button>}
      <button onClick={() => { setIsSelf(false); setStep(2) }}>{t('intake.forOther')}</button>
    </div>}
    {step === 2 && <div className="intake-fields">
      <label>{t(isSelf ? 'intake.storySelf' : 'intake.story')}
        <textarea rows={6} maxLength={4000} disabled={busy} value={transcript} onChange={(ev) => setTranscript(ev.target.value)} placeholder={t(isSelf ? 'intake.storySelfExample' : 'intake.storyExample')} />
      </label>
      {SpeechRecognition && <button className="quiet" disabled={busy} onClick={speak}>{listening ? t('intake.stop') : t('intake.speak')}</button>}
      <p className="muted" aria-live="polite">{listening ? t('intake.listening', { hearing }) : ''}</p>
      {voiceError && <p role="alert" className="connection-error">{s(voiceError)}</p>}
      <button disabled={busy || transcript.trim().length < 3} onClick={extract}>{busy ? t('intake.reading') : t('intake.continue')}</button>
      <button className="quiet intake-link" disabled={busy} onClick={() => {
        stop()
        if (automatic || reviewedTranscript === null) clearForm()
        setError('')
        setReviewedTranscript(transcript)
        setStep(3)
      }}>{t('intake.manual')}</button>
    </div>}
    {step === 3 && <form className="intake-fields" onSubmit={(ev) => { ev.preventDefault(); void save() }}>
      {automatic && <p className="muted">{t('intake.automatic')}</p>}
      <label>{t('intake.name')}<input required maxLength={80} value={name} onChange={(ev) => setName(ev.target.value)} /></label>
      <label>{t('intake.phone')}<input maxLength={30} inputMode="tel" value={phone} onChange={(ev) => setPhone(ev.target.value)} /></label>
      <label htmlFor="intake-municipality">{t('intake.municipality')}<Select<SelectOption, false>
        {...selectText(t)}
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
      }} placeholder={t('intake.chooseMunicipality')} isSearchable styles={selectStyles} /></label>
      <label htmlFor="intake-zone">{t('intake.zone')}<Select<SelectOption, false>
        {...selectText(t)}
        inputId="intake-zone"
        classNamePrefix="vp-select"
        options={zones.map((z) => ({ value: z, label: z }))}
        value={zones.includes(zone) && zone ? { value: zone, label: zone } : null}
        isDisabled={zonesBusy}
        isLoading={zonesBusy}
        onChange={(option) => setZone(option?.value ?? '')}
        placeholder={t('intake.unknownZone')}
        isClearable
        isSearchable
        styles={selectStyles}
      /></label>
      {zonesBusy ? <p className="muted" aria-live="polite">{t('intake.loadingZones')}</p> : municipality && !zones.length && <p className="muted">{t('intake.noZones')}</p>}
      {zoneError && <p role="alert" className="connection-error">{s(zoneError)}</p>}
      {location
        ? <p className="muted">{t('intake.locationSaved', { meters: location.accuracyM })} <button type="button" className="quiet" onClick={() => setLocation(null)}>{t('intake.remove')}</button></p>
        : <button type="button" className="quiet" disabled={locating} onClick={locate}>{locating ? t('intake.locating') : t('intake.shareLocation')}</button>}
      {locationError && <p role="alert" className="connection-error">{locationError}</p>}
      <h2 className="question">{t('intake.needs')}</h2>
      {needs.map((n, i) => <div className="need-row" key={i}>
        <label htmlFor={`intake-need-${i}`}>{t('intake.needNumber', { number: i + 1 })}<Select<SelectOption, false>
        {...selectText(t)}
          inputId={`intake-need-${i}`}
          classNamePrefix="vp-select"
          required
          options={Object.entries(NEED_KEY).map(([kind, label]) => ({ value: kind, label: t(label) }))}
          value={n.kind ? { value: n.kind, label: t(NEED_KEY[n.kind]) } : null}
          onChange={(option) => setNeeds(needs.map((row, index) => index === i ? { ...row, kind: (option?.value ?? '') as Kind | '' } : row))}
          placeholder={t('intake.chooseNeed')}
          isSearchable
          styles={selectStyles}
        /></label>
        <label>{t('intake.battery')}<input type="number" min={0} max={240} step={0.5} value={n.batteryHours} onChange={(ev) => setNeeds(needs.map((row, index) => index === i ? { ...row, batteryHours: ev.target.value } : row))} /></label>
        <button type="button" className="quiet" disabled={needs.length === 1} onClick={() => setNeeds(needs.filter((_, index) => index !== i))}>{t('intake.remove')}</button>
      </div>)}
      <button type="button" className="quiet" disabled={needs.length >= 6} onClick={() => setNeeds([...needs, emptyNeed()])}>{t('intake.add')}</button>
      <label className="check"><input type="checkbox" required checked={consent} onChange={(ev) => setConsent(ev.target.checked)} />{t('intake.consent')}</label>
      <button disabled={busy || zonesBusy || !consent || !valid}>{busy ? t('intake.saving') : t('intake.save')}</button>
    </form>}
    <div className="quick-replies">
      {step > 1 && <button className="quiet" disabled={busy} onClick={() => { stop(); setStep(step - 1) }}>{t('intake.back')}</button>}
      <button className="quiet" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
    </div>
  </section>
}
