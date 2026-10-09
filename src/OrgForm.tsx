import { useT, useServerText, type TextKey } from './i18n.ts'
import { useState } from 'react'
import type { InferRequestType } from 'hono/client'
import { api } from './api.ts'
import { errorText, MUNICIPALITIES } from './lib.ts'

type Body = InferRequestType<typeof api.public.organizations.$post>['json']
const ORG_TYPES: [Body['orgType'], TextKey][] = [
  ['health-plan', 'orgForm.healthPlan'], ['municipality', 'orgForm.municipality'], ['clinic', 'orgForm.clinic'],
  ['supplier', 'orgForm.supplier'], ['other', 'orgForm.other'],
]
// LUMA spells municipalities in capitals; show them the way people read them.
const pretty = (m: string) => m.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())

// Responder registration for the Landing page (English). The organization stays pending until an admin approves it.
export default function OrgForm() {
  const t = useT()
  const s = useServerText()
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
      else setError(res.status === 400 ? t('orgForm.invalid') : await errorText(res))
    } catch {
      setError(t('orgForm.sendError'))
    }
    setBusy(false)
  }

  if (done) return <div className="card notice org-done" role="status">
    <h3>{t('orgForm.thanks', { name: done })}</h3>
    <p>{t('orgForm.approvalNote', { email: contactEmail.trim() })}</p>
  </div>

  return <form className="org-form" onSubmit={(ev) => { ev.preventDefault(); void submit() }}>
    {error && <p role="alert" className="connection-error">{s(error)}</p>}
    <div className="org-fields">
      <label>{t('orgForm.name')}<input required minLength={2} maxLength={120} value={name} onChange={(ev) => setName(ev.target.value)} /></label>
      <label>{t('orgForm.type')}<select required value={orgType} onChange={(ev) => setOrgType(ev.target.value as Body['orgType'] | '')}>
        <option value="">{t('orgForm.choose')}</option>{ORG_TYPES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select></label>
      <label>{t('orgForm.email')}<input required type="email" maxLength={200} value={contactEmail} onChange={(ev) => setContactEmail(ev.target.value)} /></label>
    </div>

    <fieldset>
      <legend>{t('orgForm.municipalities')} <span className="muted">{t('orgForm.selected', { count: chosen.length })}</span></legend>
      <label className="org-filter">{t('orgForm.find')}<input type="search" value={filter} onChange={(ev) => setFilter(ev.target.value)} placeholder={t('orgForm.findExample')} /></label>
      <div className="municipalities">
        {shown.map((m) => <label key={m} className="check"><input type="checkbox" checked={chosen.includes(m)} onChange={() => toggle(m)} />{pretty(m)}</label>)}
        {!shown.length && <p className="muted">{t('orgForm.noMatch', { filter })}</p>}
      </div>
    </fieldset>

    <label>{t('orgForm.message')}
      <textarea rows={3} maxLength={2000} value={message} onChange={(ev) => setMessage(ev.target.value)} placeholder={t('orgForm.messageExample')} />
    </label>
    <p className="org-submit">
      <button disabled={busy || !ready}>{busy ? t('orgForm.sending') : t('orgForm.register')}</button>
      {!ready && <span className="muted">{t('orgForm.required')}</span>}
    </p>
  </form>
}
