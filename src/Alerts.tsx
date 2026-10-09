import { useT, useServerText, type Translator, type ServerText } from './i18n.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.ts'
import type { Persona } from './App.tsx'

// Alerts for whoever is looking at the app: a coordinator hears about a patient to call now, a caregiver about a new
// check-in, the admin about an organization waiting for review. They come from polling the same routes the screens
// use, so the server's visibility rules decide what each person can be alerted about. No push server, no new table:
// alerts arrive while the app is open in a tab (also a background tab), not when the browser is closed.

// about: the snapshot entries an alert is about. Once none of them still applies (the check-in was answered, the case was
// taken or is no longer urgent) the card and its system notification are withdrawn, without anyone pressing the close button.
type Alert = { id: string; tone: 'urgent' | 'info'; title: string; body: string; href?: string; action?: string; about?: string[]; leaving?: boolean }
type Draft = Omit<Alert, 'id' | 'leaving'>
// takenByOther: another organization already has the case, so it is not this person's to call.
type Entry = { name: string; tier?: number; reason?: string; replied?: boolean; takenByOther?: boolean }
type Snapshot = Map<string, Entry>
// Other screens announce a change (a reply sent, a case taken) so the alerts look again at once instead of at the next poll.
export const ALERTS_CHANGED = 'vp:changed'

const POLL_MS = 10_000
const INFO_MS = 9_000 // an informative alert leaves by itself; an urgent one stays until someone closes it
const MAX_SHOWN = 3 // more than this covers the screen and overwhelms; urgent cards are kept first
const MAX_SYSTEM = 3 // system notifications per batch
const LEAVE_MS = 260
const STORE = 'vp_alerts'

const list = (names: string[], t: Translator, s: ServerText) => names.length > 3 ? t('alerts.moreNames', { names: names.slice(0, 3).map(s).join(', '), count: names.length - 3 }) : names.map(s).join(', ')
// Newest first, but an informative card never pushes an urgent one off the screen.
const trim = (all: Alert[]) => all.length <= MAX_SHOWN ? all : [...all.filter((a) => a.tone === 'urgent'), ...all.filter((a) => a.tone !== 'urgent')].slice(0, MAX_SHOWN)

// What each role watches. read() returns null when the request fails, so one bad poll never looks like "everything disappeared".
const WATCH: Record<Persona['role'], { read: (user: Persona) => Promise<Snapshot | null>; applies: (entry: Entry) => boolean; diff: (before: Snapshot | null, now: Snapshot, t: Translator, s: ServerText) => Draft[] }> = {
  coordinator: {
    read: async (user) => {
      const res = await api['call-list'].$get()
      if (!res.ok) return null
      return new Map((await res.json()).events.map((e) => [String(e.eventId), { name: e.patientName, tier: e.tier, reason: e.reasons[0], replied: !!e.checkinReplyAt,
        takenByOther: e.claimedByOrgId !== null && e.claimedByOrgId !== user.orgId }]))
    },
    applies: (c) => c.tier === 1 && !c.takenByOther, // still this organization's to call now
    diff: (before, now, t, s) => {
      if (!before) { // first look as this persona: one summary instead of a pile of cards
        const urgent = [...now].filter(([, c]) => c.tier === 1 && !c.takenByOther)
        if (!urgent.length) return []
        const [id, first] = urgent[0]
        return [{ tone: 'urgent', title: urgent.length === 1 ? t('alerts.callNow', { name: s(first.name) }) : t('alerts.callCount', { count: urgent.length }),
          body: urgent.length === 1 ? s(first.reason) : list(urgent.map(([, c]) => c.name), t, s), href: `/org#caso-${id}`, action: t('common.viewCase'), about: urgent.map(([key]) => key) }]
      }
      const out: Draft[] = []
      for (const [id, c] of now) {
        const was = before.get(id)
        const open = { href: `/org#caso-${id}`, action: t('common.viewCase') }
        const mustCall = c.tier === 1 && !c.takenByOther
        if (!was) out.push(mustCall ? { tone: 'urgent', title: t('alerts.callNow', { name: s(c.name) }), body: s(c.reason), ...open, about: [id] } : { tone: 'info', title: t('alerts.newCase', { name: s(c.name) }), body: s(c.reason), ...open })
        else {
          if (mustCall && was.tier !== 1) out.push({ tone: 'urgent', title: t('alerts.urgent', { name: s(c.name) }), body: s(c.reason), ...open, about: [id] })
          if (c.replied && !was.replied) out.push({ tone: 'info', title: t('alerts.replied', { name: s(c.name) }), body: t('alerts.openReply'), ...open })
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
    applies: () => true, // a check-in stays pending until it is answered, and then it leaves the snapshot
    diff: (before, now, t, s) => {
      const freshIds = [...now.keys()].filter((id) => !before?.has(id))
      const fresh = freshIds.map((id) => now.get(id)!)
      if (!fresh.length) return []
      return [{ tone: 'urgent', title: fresh[0].reason !== undefined ? s(fresh[0].reason) : t('alerts.hasAlert'), body: t('alerts.forNames', { names: list(fresh.map((c) => c.name), t, s) }), href: '/app#avisos', action: t('alerts.reply'), about: freshIds }]
    },
  },
  admin: {
    read: async () => {
      const res = await api.admin.organizations.$get()
      if (!res.ok) return null
      return new Map((await res.json()).organizations.filter((o) => o.status === 'pending').map((o) => [String(o.id), { name: o.name }]))
    },
    applies: () => true,
    diff: (before, now, t, s) => {
      const fresh = [...now].filter(([id]) => !before?.has(id)).map(([, o]) => o.name)
      if (!fresh.length) return []
      return [{ tone: 'info', title: fresh.length === 1 ? t('alerts.onePending') : t('alerts.pendingCount', { count: fresh.length }), body: list(fresh, t, s), href: '/admin', action: t('alerts.review') }]
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
  const t = useT()
  const s = useServerText()
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [enabled, setEnabled] = useState(stored) // the person asked for sound and system notifications
  const [hidden, setHidden] = useState(document.hidden)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const alertsRef = useRef(alerts)
  alertsRef.current = alerts
  const serial = useRef(0)
  const held = useRef(new Set<string>()) // cards being read (pointer over them or focus inside) do not leave by themselves
  const systemNotes = useRef(new Map<string, Notification>())

  const dismiss = useCallback((id: string) => {
    held.current.delete(id)
    systemNotes.current.get(id)?.close()
    systemNotes.current.delete(id)
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
    if (!enabledRef.current) return
    if (fresh.some((a) => a.tone === 'urgent')) chime()
    if (!canNotify() || Notification.permission !== 'granted') return
    // The card is enough for an informative alert when the page is in front; urgent ones always reach the system.
    for (const a of fresh.filter((x) => x.tone === 'urgent' || document.hidden).slice(0, MAX_SYSTEM)) {
      try {
        const note = new Notification(a.title, { body: a.body, icon: '/android-chrome-192x192.png', tag: a.id })
        note.onclick = () => { window.focus(); if (a.href) location.assign(a.href); note.close() }
        systemNotes.current.set(a.id, note)
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
    const tick = async () => {
      if (busy) return // a slow answer must not be overtaken by the next poll
      busy = true
      const now = await WATCH[who.role].read(who).catch(() => null)
      busy = false
      if (!active || !now) return
      // Withdraw what is no longer true before showing what is new.
      const stillApplies = (key: string) => { const entry = now.get(key); return !!entry && WATCH[who.role].applies(entry) }
      for (const a of alertsRef.current) if (a.about && !a.leaving && !a.about.some(stillApplies)) dismiss(a.id)
      show(WATCH[who.role].diff(before, now, t, s))
      before = now
    }
    void tick()
    const timer = setInterval(tick, POLL_MS)
    const onChange = () => void tick()
    addEventListener(ALERTS_CHANGED, onChange)
    return () => {
      active = false
      clearInterval(timer)
      removeEventListener(ALERTS_CHANGED, onChange)
      for (const note of systemNotes.current.values()) note.close() // another persona must not act on these
      systemNotes.current.clear()
    }
  }, [userId, show, dismiss])

  // While the page is in the background, the tab title counts the alerts that are still on screen.
  const waiting = hidden ? alerts.filter((a) => !a.leaving).length : 0
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, '')
    document.title = waiting ? `(${waiting}) ${base}` : base
    return () => { document.title = base }
  }, [waiting])
  useEffect(() => {
    const seen = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', seen)
    return () => document.removeEventListener('visibilitychange', seen)
  }, [])

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    try { localStorage.setItem(STORE, next ? 'on' : 'off') } catch { /* private mode: lasts for this page only */ }
    if (!next) return
    enabledRef.current = true
    let blocked = !canNotify()
    if (canNotify() && Notification.permission !== 'granted') blocked = (await Notification.requestPermission().catch(() => 'denied')) !== 'granted'
    chime()
    show([{ tone: 'info', title: t('alerts.enabled'), body: blocked ? t('alerts.blocked') : t('alerts.enabledNote') }])
  }

  const follow = (a: Alert) => {
    // Same address as now (the case was opened by an earlier alert and closed by hand): no navigation happens, so say it again.
    if (a.href === location.pathname + location.hash) dispatchEvent(new HashChangeEvent('hashchange'))
    dismiss(a.id)
  }

  return <>
    <button className={enabled ? 'alerts-toggle on' : 'alerts-toggle'} aria-pressed={enabled} onClick={toggle}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.6L4.3 16a1 1 0 0 0 .9 1.5h13.6a1 1 0 0 0 .9-1.5L18 12.6V9a6 6 0 0 0-6-6Zm-2.2 16a2.3 2.3 0 0 0 4.4 0Z" fill="currentColor" /></svg>
      {enabled ? t('alerts.active') : t('alerts.enable')}
    </button>
    {createPortal(<div className="alerts" aria-label={t('alerts.title')}>
      {alerts.map((a) => <article key={a.id} className={`alert-card ${a.tone}${a.leaving ? ' leaving' : ''}`} role={a.tone === 'urgent' ? 'alert' : 'status'}
        onMouseEnter={() => held.current.add(a.id)} onMouseLeave={() => held.current.delete(a.id)} onFocus={() => held.current.add(a.id)} onBlur={() => held.current.delete(a.id)}>
        <span className="alert-icon" aria-hidden="true" />
        <div className="alert-text">
          <h3>{a.title}</h3>
          {a.body && <p>{a.body}</p>}
          {a.href && <a className="button" href={a.href} onClick={() => follow(a)}>{a.action}</a>}
        </div>
        <button className="alert-close" aria-label={t('alerts.close')} onClick={() => dismiss(a.id)}>{t('alerts.closeSymbol')}</button>
        {a.tone === 'info' && <span className="alert-timer" style={{ animationDuration: `${INFO_MS}ms` }} aria-hidden="true" />}
      </article>)}
    </div>, document.body)}
  </>
}
