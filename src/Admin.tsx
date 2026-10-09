import { useState } from 'react'
import type { Persona } from './App.tsx'
import System from './System.tsx'
import CallList from './CallList.tsx'
import { api } from './api.ts'
import { errorText } from './lib.ts'

// Platform admin view (/admin): A's System screen plus every open case on the island.
// The admin only watches the cases: claiming, confirming and briefing belong to the organizations.
export default function Admin({ user }: { user: Persona }) {
  const [tab, setTab] = useState<'system' | 'calls'>('system')
  const [reset, setReset] = useState<'idle' | 'ask' | 'busy' | 'done'>('idle')
  const [error, setError] = useState('')
  const [round, setRound] = useState(0) // remounts the tab so it reloads after a reset

  const resetDemo = async () => {
    setReset('busy')
    setError('')
    try {
      const res = await api.demo.reset.$post()
      if (!res.ok) { setError(await errorText(res)); return setReset('idle') }
      setRound((n) => n + 1)
      setReset('done')
    } catch {
      setError('No se pudo reiniciar la demostración.')
      setReset('idle')
    }
  }

  return <section>
    <h1>Administración</h1>
    <p className="org-line">Lecturas de LUMA, organizaciones y todos los casos abiertos.</p>
    <div className="tabs" aria-label="Vistas de administración">
      <button aria-pressed={tab === 'system'} onClick={() => setTab('system')}>Sistema</button>
      <button aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>Todos los casos</button>
    </div>
    {tab === 'system' ? <System key={round} /> : <CallList key={round} user={user} />}

    <aside className="demo-reset">
      <h2>Ensayos</h2>
      <p className="muted">Deja la demostración como al principio: borra los pacientes y organizaciones registrados en los ensayos y los casos en curso, y vuelve al modo en vivo. Las lecturas grabadas de LUMA no se tocan.</p>
      {error && <p role="alert" className="connection-error">{error}</p>}
      {reset === 'ask'
        ? <p className="confirm-actions"><button disabled={false} onClick={resetDemo}>Sí, reiniciar ahora</button><button className="quiet" onClick={() => setReset('idle')}>Cancelar</button></p>
        : <button className="quiet" disabled={reset === 'busy'} onClick={() => setReset('ask')}>{reset === 'busy' ? 'Reiniciando…' : 'Reiniciar la demostración'}</button>}
      <p className="muted" aria-live="polite">{reset === 'done' ? 'Listo. La demostración está como al principio.' : ''}</p>
    </aside>
  </section>
}
