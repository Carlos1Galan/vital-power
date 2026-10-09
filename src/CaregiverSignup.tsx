import { useState } from 'react'
import { api } from './api.ts'
import { errorText } from './lib.ts'
import { useServerText, useT } from './i18n.ts'

// A patient registering themself ('self'), or someone who cares for a patient ('other'), creates a demo profile
// with a name only: no password, like every other persona here. They are signed in and taken straight into
// the registration for that choice.
export default function CaregiverSignup({ who }: { who: 'self' | 'other' }) {
  const t = useT()
  const s = useServerText()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const ready = name.trim().length >= 2

  const submit = async () => {
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      const res = await api.demo.caregivers.$post({ json: { name: name.trim() } })
      if (res.ok) return location.assign(`/app?start=${who}`) // the caregiver view opens the registration for that choice
      setError(s(await errorText(res)))
    } catch {
      setError(t('signup.error'))
    }
    setBusy(false)
  }

  return <form className="org-form signup-form" onSubmit={(ev) => { ev.preventDefault(); void submit() }}>
    {error && <p role="alert" className="connection-error">{error}</p>}
    <label>{t('signup.name')}<input required minLength={2} maxLength={80} value={name} onChange={(ev) => setName(ev.target.value)} placeholder={t('signup.placeholder')} autoComplete="off" /></label>
    <p className="org-submit">
      <button disabled={busy || !ready}>{busy ? t('signup.busy') : t(who === 'self' ? 'signup.submitSelf' : 'signup.submitOther')}</button>
      <span className="muted">{t('signup.note')}</span>
    </p>
  </form>
}
