import { useState } from 'react'
import type { InferRequestType } from 'hono/client'
import { api } from './api.ts'
import { errorText, MUNICIPALITIES } from './lib.ts'

type Body = InferRequestType<typeof api.public.organizations.$post>['json']
const ORG_TYPES: [Body['orgType'], string][] = [
  ['health-plan', 'Health plan'], ['municipality', 'Municipal emergency office'], ['clinic', 'Clinic or health center'],
  ['supplier', 'Medical equipment or oxygen supplier'], ['other', 'Other'],
]
// LUMA spells municipalities in capitals; show them the way people read them.
const pretty = (m: string) => m.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())

// Responder registration for the Landing page (English). The organization stays pending until an admin approves it.
export default function OrgForm() {
  const [name, setName] = useState('')
  const [orgType, setOrgType] = useState<Body['orgType'] | ''>('')
  const [contactEmail, setContactEmail] = useState('')
  const [chosen, setChosen] = useState<Body['municipalities']>([])
  const [filter, setFilter] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const shown = MUNICIPALITIES.filter((m) => m.includes(filter.trim().toUpperCase()))
  const toggle = (m: Body['municipalities'][number]) => setChosen(chosen.includes(m) ? chosen.filter((x) => x !== m) : [...chosen, m])
  const ready = name.trim().length >= 2 && orgType !== '' && contactEmail.includes('@') && chosen.length > 0

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      const res = await api.public.organizations.$post({ json: { name: name.trim(), orgType, contactEmail: contactEmail.trim(), municipalities: chosen, message: message.trim() } })
      if (res.ok) setDone(name.trim())
      else setError(res.status === 400 ? 'Please check the form: the email or one of the fields is not valid.' : await errorText(res))
    } catch {
      setError('We could not send the registration. Please try again in a moment.')
    }
    setBusy(false)
  }

  if (done) return <div className="card notice org-done" role="status">
    <h3>Thank you. {done} is registered and awaiting review.</h3>
    <p>A platform administrator approves each organization before it can see a call list. You will hear from us at {contactEmail.trim()}.</p>
  </div>

  return <form className="org-form" onSubmit={(ev) => { ev.preventDefault(); void submit() }}>
    {error && <p role="alert" className="connection-error">{error}</p>}
    <div className="org-fields">
      <label>Organization name<input required minLength={2} maxLength={120} value={name} onChange={(ev) => setName(ev.target.value)} /></label>
      <label>Type of organization<select required value={orgType} onChange={(ev) => setOrgType(ev.target.value as Body['orgType'] | '')}>
        <option value="">Choose one</option>{ORG_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Contact email<input required type="email" maxLength={200} value={contactEmail} onChange={(ev) => setContactEmail(ev.target.value)} /></label>
    </div>

    <fieldset>
      <legend>Municipalities you can respond in <span className="muted">({chosen.length} selected)</span></legend>
      <label className="org-filter">Find a municipality<input type="search" value={filter} onChange={(ev) => setFilter(ev.target.value)} placeholder="Type a name, for example Caguas" /></label>
      <div className="municipalities">
        {shown.map((m) => <label key={m} className="check"><input type="checkbox" checked={chosen.includes(m)} onChange={() => toggle(m)} />{pretty(m)}</label>)}
        {!shown.length && <p className="muted">No municipality matches "{filter}".</p>}
      </div>
    </fieldset>

    <label>Anything we should know? (optional)
      <textarea rows={3} maxLength={2000} value={message} onChange={(ev) => setMessage(ev.target.value)} placeholder="For example: we have two generators and a team on call at night." />
    </label>
    <p className="org-submit">
      <button disabled={busy || !ready}>{busy ? 'Sending…' : 'Register organization'}</button>
      {!ready && <span className="muted">Fill in the name, type, email and at least one municipality.</span>}
    </p>
  </form>
}
