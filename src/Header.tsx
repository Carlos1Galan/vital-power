import { selectText, useT, useServerText, useLang, setLang, type TextKey, type Translator, type ServerText } from './i18n.ts'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import type { InferResponseType } from 'hono/client'
import { api } from './api.ts'
import type { Persona } from './App.tsx'
import Alerts from './Alerts.tsx'
import Select, { components, type SingleValueProps } from 'react-select'
import { selectStyles, type SelectOption } from './selectStyles.ts'

const AREAS = [['/app', 'header.patients'], ['/org', 'header.organizations'], ['/admin', 'header.admin']] as const
const THEME_REVEAL_MS = 650
const MARQUEE_PX_PER_SECOND = 28 // slow enough to read while it moves
const MARQUEE_MOVING_SHARE = 0.64 // persona-slide in index.css moves for 32% of the cycle each way and rests in between
const personaLabel = (p: Persona, t: Translator, s: ServerText) => {
  const name = p.orgName ? t('header.personaOrg', { name: s(p.name), org: s(p.orgName) }) : s(p.name)
  return p.orgStatus === 'pending' ? t('header.personaPending', { name }) : name
}
// The chosen persona inside the searchable select. When the name is wider than the control it slides to its end
// and back so all of it can be read (twice, then again on hover or focus; see persona-slide in index.css).
function SlidingValue(props: SingleValueProps<SelectOption, false>) {
  const box = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)
  const label = props.data.label
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setOverflow(Math.max(0, el.scrollWidth - el.clientWidth))
    measure()
    void document.fonts?.ready.then(measure) // a late font changes the text width without resizing the box
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [label])
  const slide = { '--slide': `-${overflow}px`, '--slide-time': `${Math.max(5, (overflow / MARQUEE_PX_PER_SECOND) * 2 / MARQUEE_MOVING_SHARE)}s` } as CSSProperties
  return <components.SingleValue {...props}>
    <span className="persona-window" ref={box} title={label}>
      <span className={overflow ? 'persona-name sliding' : 'persona-name'} style={slide}>{label}</span>
    </span>
  </components.SingleValue>
}

type Status = InferResponseType<typeof api.public.status.$get>
const groups: [Persona['personaType'], TextKey][] = [
  ['caregiver', 'header.caregiver'], ['facility-staff', 'header.staff'], ['self-patient', 'header.patient'],
  ['coordinator', 'header.coordination'], ['admin', 'header.admin'],
]

export default function Header({ personas, user, onSwitch }: { personas: Persona[]; user: Persona | null; onSwitch: (userId: number) => void }) {
  const t = useT()
  const s = useServerText()
  const lang = useLang()
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState(false)
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
    const timer = setInterval(load, 5_000) // a switch to replay must show here almost at once
    return () => { active = false; clearInterval(timer) }
  }, [])

  return <header className="site-header">
    <div className="header-navigation">
      <a className="brand" href="/" aria-label={t('header.home')}>
        <img className="on-light" src="/vitalpower-logo-horizontal.svg" alt="" width={176} height={60} />
        <img className="on-dark" src="/vitalpower-logo-horizontal-light.svg" alt="" width={176} height={60} />
      </a>
      <nav aria-label={t('header.areas')}>
        {AREAS.map(([href, label]) => <a key={href} href={href} aria-current={location.pathname === href ? 'page' : undefined}>{t(label)}</a>)}
      </nav>
    </div>
    <div className="feed-status" aria-live="polite">
      {error ? <span className="warning">{t('header.refreshError')}</span> : status ? <>
        <span className={`badge ${status.mode === 'replay' ? 'replay' : 'live'}`}>{status.mode === 'replay' ? t('header.replay') : t('header.live')}</span>
        <span className="reading-time">{status.lastReadingAt ? <>{t('header.lastReading')} <time dateTime={status.lastReadingAt}>{new Date(status.lastReadingAt).toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-PR', { hour: 'numeric', minute: '2-digit' })}</time></> : t('header.noReadings')}</span>
        {status.stale && <span className="badge stale">{t('header.stale')}</span>}
      </> : <span>{t('common.loading')}</span>}
    </div>
    <span className="demo-label">{t('header.demo')}</span>
    <label className="persona-switcher">
      {t('header.viewAs')}
      <Select<SelectOption, false>
        {...selectText(t)}
        aria-label={t('header.viewAs')}
        className="persona-select"
        classNamePrefix="vp-select"
        options={groups.map(([type, label]) => ({
          label: t(label),
          options: personas.filter((p) => p.personaType === type).map((p) => ({
            value: String(p.id),
            label: personaLabel(p, t, s),
          })),
        })).filter((group) => group.options.length)}
        value={user ? { value: String(user.id), label: personaLabel(user, t, s) } : null}
        onChange={(option) => { if (option) onSwitch(Number(option.value)) }}
        placeholder={t('header.choosePersona')}
        isSearchable
        styles={selectStyles}
        components={{ SingleValue: SlidingValue }}
      />
    </label>
    <Alerts user={user} />
    <button className="theme-toggle" aria-pressed={theme === 'dark'} onClick={toggleTheme}>{theme === 'dark' ? t('header.light') : t('header.dark')}</button>
    <button className="lang-toggle" aria-label={t('lang.label')} onClick={() => setLang(lang === 'en' ? 'es' : 'en')}>{t('lang.switchTo')}</button>
  </header>
}
