import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.ts'
import type { Persona } from './App.tsx'

// Alerts for whoever is looking at the app: a coordinator hears about a patient to call now, a caregiver about a new
// check-in, the admin about an organization waiting for review. They come from polling the same routes the screens
// use, so the server's visibility rules decide what each person can be alerted about. No push server, no new table:
// alerts arrive while the app is open in a tab (also a background tab), not when the browser is closed.

type Alert = { id: string; tone: 'urgent' | 'info'; title: string; body: string; href?: string; action?: string; leaving?: boolean }
type Draft = Omit<Alert, 'id' | 'leaving'>
// takenByOther: another organization already has the case, so it is not this person's to call.
type Snapshot = Map<string, { name: string; tier?: number; reason?: string; replied?: boolean; takenByOther?: boolean }>

const POLL_MS = 10_000
const INFO_MS = 9_000 // an informative alert leaves by itself; an urgent one stays until someone closes it
const MAX_SHOWN = 3 // more than this covers the screen and overwhelms; urgent cards are kept first
const MAX_SYSTEM = 3 // system notifications per batch
const LEAVE_MS = 260
const STORE = 'vp_alerts'

const list = (names: string[]) => names.length > 3 ? `${names.slice(0, 3).join(', ')} y ${names.length - 3} más` : names.join(', ')
// Newest first, but an informative card never pushes an urgent one off the screen.
const trim = (all: Alert[]) => all.length <= MAX_SHOWN ? all : [...all.filter((a) => a.tone === 'urgent'), ...all.filter((a) => a.tone !== 'urgent')].slice(0, MAX_SHOWN)

// What each role watches. read() returns null when the request fails, so one bad poll never looks like "everything disappeared".
const WATCH: Record<Persona['role'], { read: (user: Persona) => Promise<Snapshot | null>; diff: (before: Snapshot | null, now: Snapshot) => Draft[] }> = {
  coordinator: {
    read: async (user) => {
      const res = await api['call-list'].$get()
      if (!res.ok) return null
      return new Map((await res.json()).events.map((e) => [String(e.eventId), { name: e.patientName, tier: e.tier, reason: e.reasons[0], replied: !!e.checkinReplyAt,
        takenByOther: e.claimedByOrgId !== null && e.claimedByOrgId !== user.orgId }]))
    },
    diff: (before, now) => {
      if (!before) { // first look as this persona: one summary instead of a pile of cards
        const urgent = [...now].filter(([, c]) => c.tier === 1 && !c.takenByOther)
        if (!urgent.length) return []
        const [id, first] = urgent[0]
        return [{ tone: 'urgent', title: urgent.length === 1 ? `Llamar ahora: ${first.name}` : `${urgent.length} personas para llamar ahora`,
          body: urgent.length === 1 ? first.reason ?? '' : list(urgent.map(([, c]) => c.name)), href: `/org#caso-${id}`, action: 'Ver caso' }]
      }
      const out: Draft[] = []
      for (const [id, c] of now) {
        const was = before.get(id)
        const open = { href: `/org#caso-${id}`, action: 'Ver caso' }
        const mustCall = c.tier === 1 && !c.takenByOther
        if (!was) out.push(mustCall ? { tone: 'urgent', title: `Llamar ahora: ${c.name}`, body: c.reason ?? '', ...open } : { tone: 'info', title: `Nuevo caso: ${c.name}`, body: c.reason ?? '', ...open })
        else {
          if (mustCall && was.tier !== 1) out.push({ tone: 'urgent', title: `Ahora es urgente: ${c.name}`, body: c.reason ?? '', ...open })
          if (c.replied && !was.replied) out.push({ tone: 'info', title: `${c.name} contestó el aviso`, body: 'Abra el caso para leer la respuesta.', ...open })
        }
      }
      return out
    },
  },
  caregiver: {
    read: async () => {
      const res = await api.checkins.pending.$get()
      if (!res.ok) return null
      return new Map((await res.json()).checkins.map((c) => [String(c.id), { name: c.patientName, reason: c.message }]))
    },
    diff: (before, now) => {
      const fresh = [...now].filter(([id]) => !before?.has(id)).map(([, c]) => c)
      if (!fresh.length) return []
      return [{ tone: 'urgent', title: fresh[0].reason ?? 'Tiene un aviso', body: `Aviso para ${list(fresh.map((c) => c.name))}. Conteste en esta pantalla.`, href: '/app#avisos', action: 'Contestar' }]
    },
  },
  admin: {
    read: async () => {
      const res = await api.admin.organizations.$get()
      if (!res.ok) return null
      return new Map((await res.json()).organizations.filter((o) => o.status === 'pending').map((o) => [String(o.id), { name: o.name }]))
    },
    diff: (before, now) => {
      const fresh = [...now].filter(([id]) => !before?.has(id)).map(([, o]) => o.name)
      if (!fresh.length) return []
      return [{ tone: 'info', title: fresh.length === 1 ? 'Una organización espera revisión' : `${fresh.length} organizaciones esperan revisión`, body: list(fresh), href: '/admin', action: 'Revisar' }]
    },
  },
}

// Two soft notes. Browsers only allow sound after the person has pressed something on the page; until then this stays silent.
function chime() {
  try {
    const ctx = new AudioContext()
    void ctx.resume()
    for (const [i, hz] of [880, 1175].entries()) {
      const at = ctx.currentTime + i * 0.16, osc = ctx.createOscillator(), gain = ctx.createGain()
      osc.frequency.value = hz
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.4)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.45)
    }
    setTimeout(() => void ctx.close(), 1500)
  } catch { /* no audio device or not allowed: the card on screen is the alert */ }
}

const canNotify = () => 'Notification' in window
const stored = () => { try { return localStorage.getItem(STORE) === 'on' } catch { return false } }

export default function Alerts({ user }: { user: Persona | null }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [enabled, setEnabled] = useState(stored) // the person asked for sound and system notifications
  const [unseen, setUnseen] = useState(0)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const serial = useRef(0)
  const held = useRef(new Set<string>()) // cards being read (pointer over them or focus inside) do not leave by themselves
  const systemNotes = useRef<Notification[]>([])

  const dismiss = useCallback((id: string) => {
    held.current.delete(id)
    setAlerts((all) => all.map((a) => a.id === id ? { ...a, leaving: true } : a))
    setTimeout(() => setAlerts((all) => all.filter((a) => a.id !== id)), LEAVE_MS)
  }, [])
  const expire = useCallback((id: string) => {
    if (held.current.has(id)) setTimeout(() => expire(id), 2000) // look again once the person has moved on
    else dismiss(id)
  }, [dismiss])

  const show = useCallback((drafts: Draft[]) => {
    if (!drafts.length) return
    const fresh = drafts.map((d) => ({ ...d, id: `a${++serial.current}` }))
    setAlerts((all) => trim([...fresh, ...all]))
    for (const a of fresh) if (a.tone === 'info') setTimeout(() => expire(a.id), INFO_MS)
    if (document.hidden) setUnseen((n) => n + fresh.length)
    if (!enabledRef.current) return
    if (fresh.some((a) => a.tone === 'urgent')) chime()
    if (!canNotify() || Notification.permission !== 'granted') return
    // The card is enough for an informative alert when the page is in front; urgent ones always reach the system.
    for (const a of fresh.filter((x) => x.tone === 'urgent' || document.hidden).slice(0, MAX_SYSTEM)) {
      try {
        const note = new Notification(a.title, { body: a.body, icon: '/android-chrome-192x192.png', tag: a.id })
        note.onclick = () => { window.focus(); if (a.href) location.assign(a.href); note.close() }
        systemNotes.current.push(note)
      } catch { /* some browsers only allow notifications from a service worker: the card still shows */ }
    }
  }, [expire])

  // Watch what this persona may see. Switching persona starts over, so each role gets its own first summary.
  const userRef = useRef(user)
  userRef.current = user
  const userId = user?.id
  useEffect(() => {
    const who = userRef.current
    if (!who) return
    let active = true, busy = false, before: Snapshot | null = null
    setAlerts([])
    setUnseen(0)
    const tick = async () => {
      if (busy) return // a slow answer must not be overtaken by the next poll
      busy = true
      const now = await WATCH[who.role].read(who).catch(() => null)
      busy = false
      if (!active || !now) return
      show(WATCH[who.role].diff(before, now))
      before = now
    }
    void tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
      for (const note of systemNotes.current) note.close() // another persona must not act on these
      systemNotes.current = []
    }
  }, [userId, show])

  // A count in the tab title while the page is in the background.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '')
    document.title = unseen ? `(${unseen}) ${base}` : base
    const seen = () => { if (!document.hidden) setUnseen(0) }
    document.addEventListener('visibilitychange', seen)
    return () => { document.removeEventListener('visibilitychange', seen); document.title = base }
  }, [unseen])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    try { localStorage.setItem(STORE, next ? 'on' : 'off') } catch { /* private mode: lasts for this page only */ }
    if (!next) return
    enabledRef.current = true
    let blocked = !canNotify()
    if (canNotify() && Notification.permission !== 'granted') blocked = (await Notification.requestPermission().catch(() => 'denied')) !== 'granted'
    chime()
    show([{ tone: 'info', title: 'Avisos activados', body: blocked ? 'El navegador no permite notificaciones del sistema. Verá y oirá los avisos dentro de esta página.' : 'Le avisaremos con sonido y con una notificación cuando haya algo urgente.' }])
  }

  const follow = (a: Alert) => {
    // Same address as now (the case was opened by an earlier alert and closed by hand): no navigation happens, so say it again.
    if (a.href === location.pathname + location.hash) dispatchEvent(new HashChangeEvent('hashchange'))
    dismiss(a.id)
  }

  return <>
    <button className={enabled ? 'alerts-toggle on' : 'alerts-toggle'} aria-pressed={enabled} onClick={toggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 16a1 1 0 0 0 .9 1.5h13.6a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Zm-2.2 16a2.3 2.3 0 0 0 4.4 0Z" fill="currentColor" /></svg>
      {enabled ? 'Avisos activos' : 'Activar avisos'}
    </button>
    {createPortal(<div className="alerts" aria-label="Avisos">
      {alerts.map((a) => <article key={a.id} className={`alert-card ${a.tone}${a.leaving ? ' leaving' : ''}`} role={a.tone === 'urgent' ? 'alert' : 'status'}
        onMouseEnter={() => held.current.add(a.id)} onMouseLeave={() => held.current.delete(a.id)} onFocus={() => held.current.add(a.id)} onBlur={() => held.current.delete(a.id)}>
        <span className="alert-icon" aria-hidden="true" />
        <div className="alert-text">
          <h3>{a.title}</h3>
          {a.body && <p>{a.body}</p>}
          {a.href && <a className="button" href={a.href} onClick={() => follow(a)}>{a.action}</a>}
        </div>
        <button className="alert-close" aria-label="Cerrar aviso" onClick={() => dismiss(a.id)}>×</button>
        {a.tone === 'info' && <span className="alert-timer" style={{ animationDuration: `${INFO_MS}ms` }} aria-hidden="true" />}
      </article>)}
    </div>, document.body)}
  </>
}
