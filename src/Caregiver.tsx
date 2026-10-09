import type { Persona } from './App.tsx'

export default function Caregiver({ user }: { user: Persona }) {
  return <section>
    <span className="viewing-as">Viendo como: {user.name}</span>
    <h1>Área de cuidadores</h1>
    <p className="page-intro">Aquí registrará a sus pacientes y contestará los avisos cuando haya un apagón en su zona.</p>
    <p className="card empty">Registro de pacientes y avisos: próximamente.</p>
  </section>
}
