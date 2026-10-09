import { useState } from 'react'
import CaregiverSignup from './CaregiverSignup.tsx'
import OrgForm from './OrgForm.tsx'
import { useT, type TextKey } from './i18n.ts'

type Kind = 'patient' | 'caregiver' | 'organization'
const KINDS: [Kind, TextKey, TextKey][] = [
  ['patient', 'register.patient', 'register.patientNote'],
  ['caregiver', 'register.caregiver', 'register.caregiverNote'],
  ['organization', 'register.organization', 'register.organizationNote'],
]
const fromUrl = (): Kind | null => {
  const value = new URLSearchParams(location.search).get('as')
  return value === 'patient' || value === 'caregiver' || value === 'organization' ? value : null
}

// One place to register (/register). The person says who they are, and the form below changes to match:
// a patient or a caregiver gets a profile and goes on to register the person; an organization applies for review.
export default function Register() {
  const t = useT()
  const [kind, setKind] = useState<Kind | null>(fromUrl)
  const choose = (next: Kind) => {
    setKind(next)
    history.replaceState(null, '', `/register?as=${next}`) // the choice survives a reload and can be linked to
  }

  return <section className="register-page">
    <h1>{t('register.title')}</h1>
    <p className="page-intro">{t('register.lead')}</p>
    <div className="register-choices" role="group" aria-label={t('register.title')}>
      {KINDS.map(([value, label, note]) => <button key={value} type="button" className="choice" aria-pressed={kind === value} onClick={() => choose(value)}>
        <strong>{t(label)}</strong>
        <span>{t(note)}</span>
      </button>)}
    </div>
    {kind && <div className="register-form" key={kind}>
      <h2>{t(kind === 'organization' ? 'landing.registerOrg' : kind === 'patient' ? 'register.patientTitle' : 'register.caregiverTitle')}</h2>
      <p className="page-intro">{t(kind === 'organization' ? 'landing.registerNote' : kind === 'patient' ? 'register.patientLead' : 'register.caregiverLead')}</p>
      {kind === 'organization' ? <OrgForm /> : <CaregiverSignup who={kind === 'patient' ? 'self' : 'other'} />}
    </div>}
  </section>
}
