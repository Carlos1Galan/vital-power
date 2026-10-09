import type { Persona } from './App.tsx'

export default function Caregiver({ user }: { user: Persona }) {
  return <section>
    <h1>Hola, {user.name}</h1>
    <p className="page-intro">Aquí va a registrar a sus pacientes y a contestar los avisos cuando se vaya la luz en su zona.</p>
    <p className="card empty">Todavía no hay nada que contestar. El registro de pacientes llega pronto.</p>
  </section>
}
