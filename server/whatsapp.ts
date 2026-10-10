import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { db, setting } from './db.ts'
import { readReplyLater } from './ai.ts'

// WhatsApp through Twilio (the sandbox for the demo). The check-in goes out automatically; after that only a coordinator writes.
// No AI text is ever sent to a patient: the AI only reads the first reply, exactly as in the web check-in.
// Configuration lives in .env (see .env.example); with no Twilio credentials, nothing is sent.

const env = process.env
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const OPEN = "e.status IN ('possible','confirmed')"
const SANDBOX = 'whatsapp:+14155238886' // Twilio's shared WhatsApp sandbox number
export const RECEIPT = 'Gracias, recibimos su respuesta. Un coordinador la revisará.'

export const whatsappOn = () => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)

// Digits with country code (what messages.phone stores); 10 digits = PR/US without the 1. null = cannot be messaged.
// WHATSAPP_DEMO_TO sends everything to one demo phone: the seed numbers (787-555-01xx) are fictional.
export function waNumber(phone: string | null) {
  const digits = (env.WHATSAPP_DEMO_TO || phone || '').replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits.length > 10 ? digits : null
}

// Twilio signs webhooks against the public URL it called, which the server behind a tunnel cannot see: hence PUBLIC_URL.
const publicUrl = (path: string) => env.PUBLIC_URL ? `${env.PUBLIC_URL.replace(/\/$/, '')}/api/whatsapp/${path}` : null

type Outgoing = { eventId: number; phone: string; body: string; sentBy?: number | null; template?: string }

// The row is written before the network call, so an overlapping run never sends it twice. Returns the error, or null.
export async function send({ eventId, phone, body, sentBy = null, template }: Outgoing) {
  const id = db.prepare("INSERT INTO messages (event_id, dir, phone, body, sent_by) VALUES (?, 'out', ?, ?, ?)").run(eventId, phone, body, sentBy).lastInsertRowid
  const form = new URLSearchParams({ From: env.TWILIO_WHATSAPP_FROM || SANDBOX, To: `whatsapp:+${phone}` })
  if (template) form.set('ContentSid', template)
  else form.set('Body', body)
  const status = publicUrl('status')
  if (status) form.set('StatusCallback', status)
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    })
    const json = await res.json() as { sid?: string; message?: string }
    if (!res.ok || !json.sid) throw new Error(json.message ?? `HTTP ${res.status}`)
    db.prepare('UPDATE messages SET wa_id = ? WHERE id = ?').run(json.sid, id)
    return null
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(error, id)
    return error
  }
}

// New check-ins of open events (current mode) with no WhatsApp message yet. The 10-minute window keeps a restart,
// or switching WhatsApp on, from messaging old cases. Every row is inserted before the first await (map runs each send
// up to its fetch), so the next tick never picks the same check-in again.
export async function sendCheckins() {
  if (!whatsappOn()) return
  const mode = setting('mode')
  const rows = db.prepare(`SELECT e.id AS eventId, p.display_name AS name, p.phone, c.message FROM checkins c
      JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
    WHERE ${OPEN} AND e.mode = ? AND c.reply_at IS NULL AND c.sent_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.event_id = e.id)`).all(mode) as { eventId: number; name: string; phone: string | null; message: string }[]
  await Promise.all(rows.flatMap((r) => {
    const phone = waNumber(r.phone)
    const body = `${mode === 'replay' ? 'REPLAY · ' : ''}VitalPower · ${r.name}\n${r.message}`
    return phone ? [send({ eventId: r.eventId, phone, body, template: env.TWILIO_CHECKIN_CONTENT_SID || undefined })] : []
  }))
}

const Incoming = z.object({
  MessageSid: z.string(), From: z.string(), Body: z.string().default(''),
  OriginalRepliedMessageSid: z.string().optional(), // set when the person quotes one of our messages
})
const Status = z.object({ MessageSid: z.string(), MessageStatus: z.string(), ErrorCode: z.string().optional(), ErrorMessage: z.string().optional() })

function receive(m: z.infer<typeof Incoming>) {
  const from = m.From.replace(/\D/g, '')
  // The open case (current mode) this phone was last written about, or the one the reply quotes.
  const target = db.prepare(`SELECT m.event_id AS eventId FROM messages m JOIN outage_events e ON e.id = m.event_id
    WHERE m.dir = 'out' AND m.phone = :from AND ${OPEN} AND e.mode = :mode
    ORDER BY (:ctx IS NOT NULL AND m.wa_id = :ctx) DESC, m.id DESC LIMIT 1`)
    .get({ from, ctx: m.OriginalRepliedMessageSid ?? null, mode: setting('mode') }) as { eventId: number } | undefined
  if (!target) return // e.g. the "join <code>" that enrolls the phone in the sandbox
  const body = m.Body.trim().slice(0, 1000) || '[adjunto]'
  const added = db.prepare("INSERT OR IGNORE INTO messages (event_id, dir, phone, body, wa_id) VALUES (?, 'in', ?, ?, ?)").run(target.eventId, from, body, m.MessageSid).changes
  if (!added) return // Twilio retried a delivery we already have
  // The first reply answers the check-in as in the web app: the AI reads it, a coordinator confirms it.
  const answered = db.prepare(`UPDATE checkins SET reply_text = ?, reply_at = ${NOW}
    WHERE id = (SELECT max(id) FROM checkins WHERE event_id = ?) AND reply_at IS NULL RETURNING id`).get(body, target.eventId) as { id: number } | undefined
  if (!answered) return
  readReplyLater(answered.id)
  void send({ eventId: target.eventId, phone: from, body: RECEIPT })
}

// X-Twilio-Signature: base64 HMAC-SHA1, keyed by the auth token, of the URL followed by every POST field (key+value, sorted by key).
// No PUBLIC_URL or token configured = refuse everything.
export function signature(url: string, params: Record<string, string>) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('')
  return createHmac('sha1', env.TWILIO_AUTH_TOKEN ?? '').update(data).digest('base64')
}

// The webhook's form fields if Twilio signed them, else null.
async function signedForm(c: Context, path: string) {
  const url = publicUrl(path)
  const header = c.req.header('x-twilio-signature')
  if (!url || !env.TWILIO_AUTH_TOKEN || !header) return null
  const params = Object.fromEntries(new URLSearchParams(await c.req.text()))
  const expected = Buffer.from(signature(url, params))
  const got = Buffer.from(header)
  return got.length === expected.length && timingSafeEqual(got, expected) ? params : null
}

// Twilio's endpoints, not the app's: an empty TwiML answer, as Twilio expects (no automatic reply).
const twiml = (c: Context) => c.body('<Response/>', 200, { 'Content-Type': 'text/xml' })
export const whatsappRoutes = new Hono()
  // Sandbox settings → "When a message comes in": https://<public tunnel>/api/whatsapp/webhook (POST).
  .post('/whatsapp/webhook', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const form = await signedForm(c, 'webhook')
    if (!form) return c.text('Forbidden', 403)
    const m = Incoming.safeParse(form)
    if (m.success) receive(m.data)
    return twiml(c)
  })
  // Delivery reports, set per message through StatusCallback. A send can be accepted and then fail
  // (for example outside the 24-hour window, or a phone that never joined the sandbox): keep the reason on the message.
  .post('/whatsapp/status', bodyLimit({ maxSize: 64 * 1024 }), async (c) => {
    const form = await signedForm(c, 'status')
    if (!form) return c.text('Forbidden', 403)
    const s = Status.safeParse(form)
    if (s.success && (s.data.MessageStatus === 'failed' || s.data.MessageStatus === 'undelivered'))
      db.prepare('UPDATE messages SET error = ? WHERE wa_id = ?').run(s.data.ErrorMessage || `Twilio error ${s.data.ErrorCode ?? s.data.MessageStatus}`, s.data.MessageSid)
    return twiml(c)
  })
