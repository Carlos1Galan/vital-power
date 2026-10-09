import { useT, useServerText } from './i18n.ts'
import { useState } from 'react'
import type { Persona } from './App.tsx'
import System from './System.tsx'
import CallList from './CallList.tsx'
import { api } from './api.ts'
import { errorText } from './lib.ts'

// Platform admin view (/admin): A's System screen plus every open case on the island.
// The admin only watches the cases: claiming, confirming and briefing belong to the organizations.
export default function Admin({ user }: { user: Persona }) {
  const t = useT()
  const s = useServerText()
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
      setError(t('admin.resetError'))
      setReset('idle')
    }
  }

  return <section>
    <h1>{t('admin.title')}</h1>
    <p className="org-line">{t('admin.description')}</p>
    <div className="tabs" aria-label={t('admin.views')}>
      <button aria-pressed={tab === 'system'} onClick={() => setTab('system')}>{t('admin.system')}</button>
      <button aria-pressed={tab === 'calls'} onClick={() => setTab('calls')}>{t('admin.allCases')}</button>
    </div>
    {tab === 'system' ? <System key={round} /> : <CallList key={round} user={user} />}

    <aside className="demo-reset">
      <h2>{t('admin.rehearsals')}</h2>
      <p className="muted">{t('admin.resetNote')}</p>
      {error && <p role="alert" className="connection-error">{s(error)}</p>}
      {reset === 'ask'
        ? <p className="confirm-actions"><button disabled={false} onClick={resetDemo}>{t('admin.confirmReset')}</button><button className="quiet" onClick={() => setReset('idle')}>{t('common.cancel')}</button></p>
        : <button className="quiet" disabled={reset === 'busy'} onClick={() => setReset('ask')}>{reset === 'busy' ? t('admin.resetting') : t('admin.reset')}</button>}
      <p className="muted" aria-live="polite">{reset === 'done' ? t('admin.resetDone') : ''}</p>
    </aside>
  </section>
}
