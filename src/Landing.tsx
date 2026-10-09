import { useEffect, useState } from 'react'
import { api } from './api.ts'

type Outage = { label: string; without: number; regions: { name: string; without: number }[] }

// Counts up to the live figure once; jumps straight there when the visitor prefers reduced motion.
function useCountUp(target: number | null) {
  const [shown, setShown] = useState(0)
  useEffect(() => {
    if (target === null) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setShown(target)
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
  const [outage, setOutage] = useState<Outage | null>(null)
  const shown = useCountUp(outage?.without ?? null)

  useEffect(() => {
    let active = true
    api.public.status.$get().then((r) => r.json()).then((s) => {
      if (!active || !s.regions.length) return
      const regions = s.regions.map((r) => ({ name: r.name, without: r.totalClientsWithoutService })).sort((a, b) => b.without - a.without)
      setOutage({ label: s.mode === 'replay' ? 'Recorded outage (replay)' : s.stale ? 'Last reading from LUMA' : 'Right now in Puerto Rico', without: regions.reduce((n, r) => n + r.without, 0), regions: regions.slice(0, 3) })
    }).catch(() => {}) // the hero stands without the live figure
    return () => { active = false }
  }, [])

  // Organization registration form comes later.
  return <article className="landing" lang="en">
    <section className="hero">
      <div className="hero-text">
        <h1>Know who to call first when the power goes out.</h1>
        <p className="lead">VitalPower Relay helps care teams in Puerto Rico reach the people who depend on electricity for medical equipment, starting with whoever has the least time.</p>
        <p className="hero-actions">
          <a className="button" href="/admin">See the call list</a>
          <a className="button quiet" href="/app">Register a patient</a>
        </p>
      </div>
      {outage && <aside className="live-panel" aria-label="Live outage figures from LUMA">
        <p className="live-label"><span className="dot" />{outage.label}</p>
        <p className="live-number">{shown.toLocaleString('en-US')}</p>
        <p className="live-caption">homes and businesses without power</p>
        <ul>{outage.regions.map((r) => <li key={r.name}><span>{r.name}</span><span>{r.without.toLocaleString('en-US')}</span></li>)}</ul>
        <p className="live-source">Source: LUMA public outage feed</p>
      </aside>}
    </section>

    <section className="how">
      <h2>How it works</h2>
      <ol>
        <li><h3>We watch for outages</h3><p>Every three minutes we read LUMA's public outage reports and note which neighborhoods lost power.</p></li>
        <li><h3>We check on registered patients</h3><p>Patients and caregivers in those neighborhoods get one question: "¿Tiene luz en su casa?"</p></li>
        <li><h3>Coordinators call the most urgent first</h3><p>The call list is ranked by fixed rules, and every person on it comes with the reason they are there.</p></li>
      </ol>
      <p className="fine-print">This is a demo. All patient information is fictional.</p>
    </section>

    <footer className="site-footer">
      <img className="on-light" src="/vitalpower-icon.svg" alt="" width={84} height={60} />
      <img className="on-dark" src="/vitalpower-icon-light.svg" alt="" width={84} height={60} />
      <p>VitalPower Relay · Built for the Caribbean AI Summit hackathon, 2026.</p>
    </footer>
  </article>
}
