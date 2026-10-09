import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import Select from 'react-select'
import { selectStyles, type SelectOption } from './selectStyles.ts'

const AREAS = [['/app', 'Pacientes y cuidadores'], ['/org', 'Organizaciones'], ['/admin', 'Administración']] as const
const THEME_REVEAL_MS = 650
const MARQUEE_PX_PER_SECOND = 28 // slow enough to read while it moves
const MARQUEE_MOVING_SHARE = 0.64 // persona-slide in index.css moves for 32% of the cycle each way and rests in between
const personaLabel = (p: Persona) => `${p.name}${p.orgName ? ` · ${p.orgName}` : ''}${p.orgStatus === 'pending' ? ' (pendiente)' : ''}`
type Status = InferResponseType<typeof api.public.status.$get>
const groups: [Persona['personaType'], string][] = [
  ['caregiver', 'Cuidador/a'], ['facility-staff', 'Personal de hogar'], ['self-patient', 'Paciente'],
  ['coordinator', 'Coordinación'], ['admin', 'Administración'],
]

export default function Header({ personas, user, onSwitch }: { personas: Persona[]; user: Persona | null; onSwitch: (userId: number) => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState(false)
  // How far the current persona's name overflows its box; above zero it slides back and forth so all of it can be read.
  const nameBox = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  const current = user ? personaLabel(user) : 'Elegir persona…'
  useLayoutEffect(() => {
    const box = nameBox.current
    if (!box) return
    const measure = () => setOverflow(Math.max(0, box.scrollWidth - box.clientWidth))
    measure()
    void document.fonts?.ready.then(measure) // a late font changes the text width without resizing the box
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [current])

  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')

  // The new theme opens as a circle from the button. A colour fade would pass text and background through
  // the same grey halfway; a reveal keeps every pixel fully in one theme. No View Transitions support or
  // reduced motion: the switch is instant.
  const toggleTheme = (ev: MouseEvent<HTMLButtonElement>) => {
    const root = document.documentElement
    const apply = () => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark' // read at apply time, so two quick presses toggle twice
      root.dataset.theme = next
      try { localStorage.setItem('vp_theme', next) } catch { /* private mode: the choice lasts for this page only */ }
      flushSync(() => setTheme(next)) // the snapshot of the new page must already show the new label
    }
    if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return apply()
    const box = ev.currentTarget.getBoundingClientRect()
    const x = box.left + box.width / 2, y = box.top + box.height / 2
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
    // Hover and focus colour transitions would otherwise run inside the revealed page and blur its contrast.
    root.classList.add('theme-switching')
    const transition = document.startViewTransition(apply)
    const done = () => root.classList.remove('theme-switching')
    transition.finished.then(done, done)
    transition.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: THEME_REVEAL_MS, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
      )
    }).catch(() => { /* transition skipped (tab hidden, another one started): the theme is already applied */ })
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const res = await api.public.status.$get()
        if (!res.ok) throw new Error('status')
        const body = await res.json()
        if (active) {
          setStatus(body)
          setError(false)
        }
      } catch {
        if (active) setError(true)
      }
    }
    void load()
    const timer = setInterval(load, 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  return <header className="site-header">
    <div className="header-navigation">
      <a className="brand" href="/" aria-label="VitalPower Relay, inicio">
        <img className="on-light" src="/vitalpower-logo-horizontal.svg" alt="" width={176} height={60} />
        <img className="on-dark" src="/vitalpower-logo-horizontal-light.svg" alt="" width={176} height={60} />
      </a>
      <nav aria-label="Áreas">
        {AREAS.map(([href, label]) => <a key={href} href={href} aria-current={location.pathname === href ? 'page' : undefined}>{label}</a>)}
      </nav>
    </div>
    <div className="feed-status" aria-live="polite">
      {error ? <span className="warning">No se pudo actualizar la información</span> : status ? <>
        <span className={`badge ${status.mode === 'replay' ? 'replay' : 'live'}`}>{status.mode === 'replay' ? 'Replay' : 'En vivo'}</span>
        <span className="reading-time">{status.lastReadingAt ? <>Última lectura: <time dateTime={status.lastReadingAt}>{new Date(status.lastReadingAt).toLocaleTimeString('es-PR', { hour: 'numeric', minute: '2-digit' })}</time></> : 'Sin lecturas'}</span>
        {status.stale && <span className="badge stale">Datos desactualizados</span>}
      </> : <span>Cargando…</span>}
    </div>
    <span className="demo-label">DEMO · sin autenticación real</span>
    <label className="persona-switcher">
      Ver como
      <Select<SelectOption, false>
        aria-label="Ver como"
        className="persona-select"
        classNamePrefix="vp-select"
        options={groups.map(([type, label]) => ({
          label,
          options: personas.filter((p) => p.personaType === type).map((p) => ({
            value: String(p.id),
            label: `${p.name}${p.orgName ? ` · ${p.orgName}` : ''}${p.orgStatus === 'pending' ? ' (pendiente)' : ''}`,
          })),
        })).filter((group) => group.options.length)}
        value={user ? { value: String(user.id), label: `${user.name}${user.orgName ? ` · ${user.orgName}` : ''}${user.orgStatus === 'pending' ? ' (pendiente)' : ''}` } : null}
        onChange={(option) => { if (option) onSwitch(Number(option.value)) }}
        placeholder="Elegir persona…"
        isSearchable
        styles={selectStyles}
      />
    </label>
    <button className="theme-toggle" aria-pressed={theme === 'dark'} onClick={toggleTheme}>{theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</button>
  </header>
}
