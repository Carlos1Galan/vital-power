import { useT, useLang, type TextKey } from './i18n.ts'
import { useEffect, useState } from 'react'
import { api } from './api.ts'
import OrgForm from './OrgForm.tsx'

type Outage = { label: TextKey; without: number; regions: { name: string; without: number }[] }

// Counts up to the live figure once; jumps straight there when the visitor prefers reduced motion.
function useCountUp(target: number | null) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (target === null) return
    // A background tab gets no animation frames, so the figure would sit at 0 until someone looked.
    if (document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return setShown(target)
    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / 900)
      setShown(Math.round(target * (1 - (1 - t) ** 3)))
      if (t < 1) frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

export default function Landing() {
  const t = useT()
  const lang = useLang()
  const [outage, setOutage] = useState<Outage | null>(null)
  const shown = useCountUp(outage?.without ?? null)

  useEffect(() => {
    let active = true
    const load = () => api.public.status.$get().then((r) => r.json()).then((s) => {
      if (!active || !s.regions.length) return
      const regions = s.regions.map((r) => ({ name: r.name, without: r.totalClientsWithoutService })).sort((a, b) => b.without - a.without)
      setOutage({ label: s.mode === 'replay' ? 'landing.recorded' : s.stale ? 'landing.lastReading' : 'landing.now', without: regions.reduce((n, r) => n + r.without, 0), regions: regions.slice(0, 3) })
    }).catch(() => {}) // the hero stands without the live figure
    void load()
    const timer = setInterval(load, 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  return <article className="landing">
    <section className="hero">
      <div className="hero-text">
        <h1>{t('landing.title')}</h1>
        <p className="lead">{t('landing.lead')}</p>
        <p className="hero-actions">
          <a className="button" href="/org">{t('landing.callList')}</a>
          <a className="button quiet" href="/app">{t('landing.registerPatient')}</a>
          <a className="button quiet" href="#register">{t('landing.registerOrg')}</a>
        </p>
      </div>
      {outage && <aside className="live-panel" aria-label={t('landing.figures')}>
        <p className="live-label"><span className="dot" />{t(outage.label)}</p>
        <p className="live-number">{shown.toLocaleString(lang === 'en' ? 'en-US' : 'es-PR')}</p>
        <p className="live-caption">{t('landing.withoutPower')}</p>
        <ul>{outage.regions.map((r) => <li key={r.name}><span>{r.name}</span><span>{r.without.toLocaleString(lang === 'en' ? 'en-US' : 'es-PR')}</span></li>)}</ul>
        <p className="live-source">{t('landing.source')}</p>
      </aside>}
    </section>

    <section className="how">
      <h2>{t('landing.how')}</h2>
      <ol>
        <li><h3>{t('landing.watch')}</h3><p>{t('landing.watchNote')}</p></li>
        <li><h3>{t('landing.check')}</h3><p>{t('landing.checkNote')}</p></li>
        <li><h3>{t('landing.callFirst')}</h3><p>{t('landing.callFirstNote')}</p></li>
      </ol>
      <p className="fine-print">{t('landing.demo')}</p>
    </section>

    <section className="compare">
      <h2>{t('landing.different')}</h2>
      <p className="lead">{t('landing.empower')}</p>
      <p className="compare-line">{t('landing.howMany')} <em>{t('landing.whoFirst')}</em></p>
    </section>

    <section className="register" id="register">
      <h2>{t('landing.registerOrg')}</h2>
      <p className="lead">{t('landing.registerNote')}</p>
      <OrgForm />
    </section>

    <footer className="site-footer">
      <img className="on-light" src="/vitalpower-icon.svg" alt="" width={84} height={60} />
      <img className="on-dark" src="/vitalpower-icon-light.svg" alt="" width={84} height={60} />
      <p>{t('landing.footer')}</p>
    </footer>
  </article>
}
