import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { app } from './app.ts'
import { ai } from './ai.ts'
import { processTownsReading } from './events.ts'
import { RECEIPT, sendCheckins, signature } from './whatsapp.ts'

ai.complete = (async () => { throw new Error('AI is off in this test file') }) as typeof ai.complete
console.error = () => {}
Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'secret', PUBLIC_URL: 'https://demo.example/', WHATSAPP_DEMO_TO: '787-000-1111' })
const DEMO = '17870001111'

// Twilio stand-in: records every send and answers with a fresh message sid.
let sent: Record<string, string>[] = []
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  sent.push(Object.fromEntries(init.body as URLSearchParams))
  return Response.json({ sid: `SM${sent.length}` }, { status: 201 })
}) as typeof fetch

// Signed as Twilio signs: against the public URL, not the one the server sees.
const webhook = (path: 'webhook' | 'status', params: Record<string, string>, sig = signature(`https://demo.example/api/whatsapp/${path}`, params)) =>
  app.request(`/api/whatsapp/${path}`, { method: 'POST', body: new URLSearchParams(params), headers: { 'x-twilio-signature': sig } })
const inbound = (sid: string, text: string, quoted?: string) =>
  webhook('webhook', { MessageSid: sid, From: `whatsapp:+${DEMO}`, Body: text, ...(quoted ? { OriginalRepliedMessageSid: quoted } : {}) })
const eventOf = async (patientId: number) => (await db.prepare("SELECT id FROM outage_events WHERE patient_id = ? AND status IN ('possible','confirmed')").get(patientId) as { id: number }).id
const replyOf = async (patientId: number) => (await db.prepare('SELECT reply_text AS r FROM checkins WHERE event_id = ?').get(await eventOf(patientId)) as { r: string | null }).r
const messagesOf = async (patientId: number) => await db.prepare('SELECT dir, body, error FROM messages WHERE event_id = ? ORDER BY id').all(await eventOf(patientId)) as { dir: string; body: string; error: string | null }[]

beforeEach(async () => {
  await db.exec("DELETE FROM messages; DELETE FROM briefings; DELETE FROM call_outcomes; DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings; UPDATE settings SET value = 'live' WHERE key = 'mode'")
  // Patients 1 and 5 (CAGUAS) lose power; the check-ins go out once.
  const id = (await db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, 1, ?) RETURNING id").get(JSON.stringify({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }] })) as { id: number }).id
  await processTownsReading(id)
  sent = []
  await sendCheckins()
})

test('each new check-in goes out once, to the demo phone', async () => {
  assert.equal(sent.length, 2)
  assert.ok(sent.every((m) => m.To === `whatsapp:+${DEMO}` && m.From === 'whatsapp:+14155238886' && m.Body.endsWith('¿Tiene luz en su casa?')))
  assert.equal(sent[0].StatusCallback, 'https://demo.example/api/whatsapp/status')
  await sendCheckins()
  assert.equal(sent.length, 2)
})

test('the webhooks refuse a missing or wrong signature', async () => {
  const params = { MessageSid: 'in.x', From: `whatsapp:+${DEMO}`, Body: 'Sí' }
  assert.equal((await webhook('webhook', params, 'wrong')).status, 403)
  assert.equal((await webhook('webhook', params, signature('http://localhost:3000/api/whatsapp/webhook', params))).status, 403)
  assert.equal((await webhook('status', { MessageSid: 'SM1', MessageStatus: 'failed' }, 'wrong')).status, 403)
  assert.equal(await replyOf(1), null)
})

test('the first reply answers the quoted check-in once; later messages only join the chat', async () => {
  const quoted = (await db.prepare("SELECT wa_id FROM messages WHERE event_id = ?").get(await eventOf(1)) as { wa_id: string }).wa_id
  assert.equal((await inbound('in.1', 'No hay luz, quedan 2 horas', quoted)).status, 200)
  await inbound('in.1', 'No hay luz, quedan 2 horas', quoted) // Twilio retry
  await inbound('in.2', 'Gracias') // no quote: the case last written to this phone (the receipt)
  assert.equal(await replyOf(1), 'No hay luz, quedan 2 horas')
  assert.deepEqual((await messagesOf(1)).map((m) => [m.dir, m.body]).slice(1), [['in', 'No hay luz, quedan 2 horas'], ['out', RECEIPT], ['in', 'Gracias']])
  assert.equal(await replyOf(5), null)
})

test('only the claiming organization writes, and a failed delivery is kept on the message', async () => {
  const path = `/api/events/${await eventOf(1)}/messages`
  const post = () => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'vp_user=3' }, body: JSON.stringify({ text: '¿Necesita oxígeno?' }) })
  assert.equal((await post()).status, 403)
  await app.request(`/api/events/${await eventOf(1)}/claim`, { method: 'POST', headers: { Cookie: 'vp_user=3' } })
  assert.equal((await post()).status, 201)
  await webhook('status', { MessageSid: `SM${sent.length}`, MessageStatus: 'undelivered', ErrorCode: '63016' })
  assert.deepEqual({ ...(await messagesOf(1)).at(-1) }, { dir: 'out', body: '¿Necesita oxígeno?', error: 'Twilio error 63016' })
})
