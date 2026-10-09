import type { Persona } from './App.tsx'
import CallList from './CallList.tsx'

// Organization view (/org): a responder's coordinators and their call list. The server scopes it to the organization's municipalities.
export default function Org({ user }: { user: Persona }) {
  if (user.orgStatus === 'pending') return <section className="card notice">
    <h1>Su organización está pendiente de aprobación</h1>
    <p>{user.orgName} podrá ver la lista de llamadas cuando un administrador apruebe el registro.</p>
  </section>

  return <section>
    <h1>Lista de llamadas</h1>
    <p className="org-line">{user.orgName}</p>
    <CallList user={user} />
  </section>
}
