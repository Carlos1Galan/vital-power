import { useT, useServerText } from './i18n.ts'
import type { Persona } from './App.tsx'
import CallList from './CallList.tsx'

// Organization view (/org): a responder's coordinators and their call list. The server scopes it to the organization's municipalities.
export default function Org({ user }: { user: Persona }) {
  const t = useT()
  const s = useServerText()
  if (user.orgStatus === 'pending') return <section className="card notice">
    <h1>{t('org.pending')}</h1>
    <p>{t('org.pendingNote', { org: s(user.orgName) })}</p>
  </section>

  return <section>
    <h1>{t('org.calls')}</h1>
    <p className="org-line">{s(user.orgName)}</p>
    <CallList user={user} />
  </section>
}
