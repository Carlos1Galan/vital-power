import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rank, type RankInput } from './priority.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

const ev = (o: Partial<RankInput> & { eventId: number }): RankInput => ({
  status: 'possible', openedAt: minsAgo(30), needs: [], checkinSentAt: minsAgo(30), checkinReplyAt: minsAgo(25), ...o,
})
const one = (o: Partial<RankInput>) => rank([ev({ eventId: 1, ...o })], NOW)[0]

test('rule 1: confirmed outage + battery <= 4 h is tier 1 with the hours', () => {
  const r = one({ status: 'confirmed', needs: [{ kind: 'oxygen', batteryHours: 2 }] })
  assert.equal(r.tier, 1)
  assert.deepEqual(r.reasons, ['Sin luz confirmada; batería dura 2 h'])
  assert.equal(one({ status: 'confirmed', needs: [{ kind: 'cpap', batteryHours: 4 }] }).tier, 1)
  assert.notEqual(one({ status: 'confirmed', needs: [{ kind: 'cpap', batteryHours: 4.5 }] }).tier, 1)
})

test('rule 1 reads the lowest battery across devices', () => {
  const r = one({ status: 'confirmed', needs: [{ kind: 'cpap', batteryHours: 8 }, { kind: 'oxygen', batteryHours: 1.5 }] })
  assert.deepEqual(r.reasons, ['Sin luz confirmada; batería dura 1.5 h'])
})

test('rule 2: check-in unanswered > 15 min + breathing device is tier 1', () => {
  const r = one({ needs: [{ kind: 'oxygen', batteryHours: null }], checkinSentAt: minsAgo(16), checkinReplyAt: null })
  assert.equal(r.tier, 1)
  assert.deepEqual(r.reasons, ['Sin respuesta; usa concentrador', 'Posible apagón, sin confirmar'])
  assert.equal(one({ needs: [{ kind: 'ventilator', batteryHours: null }], checkinSentAt: minsAgo(20), checkinReplyAt: null }).reasons[0], 'Sin respuesta; usa ventilador')
  assert.equal(one({ needs: [{ kind: 'cpap', batteryHours: null }], checkinSentAt: minsAgo(20), checkinReplyAt: null }).reasons[0], 'Sin respuesta; usa CPAP')
})

test('rule 2 does not fire at exactly 15 min, after a reply, or without a breathing device', () => {
  assert.equal(one({ needs: [{ kind: 'oxygen', batteryHours: null }], checkinSentAt: minsAgo(15), checkinReplyAt: null }).tier, 3)
  assert.equal(one({ needs: [{ kind: 'oxygen', batteryHours: null }], checkinSentAt: minsAgo(60) }).tier, 3)
  assert.equal(one({ needs: [{ kind: 'insulin', batteryHours: null }], checkinSentAt: minsAgo(60), checkinReplyAt: null }).tier, 3)
})

test('rule 3: confirmed outage + insulin is tier 2', () => {
  const r = one({ status: 'confirmed', needs: [{ kind: 'insulin', batteryHours: null }] })
  assert.equal(r.tier, 2)
  assert.deepEqual(r.reasons, ['Sin luz confirmada; insulina en nevera'])
})

test('rule 4: possible outage, unconfirmed, is tier 3', () => {
  const r = one({ needs: [{ kind: 'insulin', batteryHours: null }] })
  assert.equal(r.tier, 3)
  assert.deepEqual(r.reasons, ['Posible apagón, sin confirmar'])
})

test('a confirmed outage no rule covers still shows a reason', () => {
  const r = one({ status: 'confirmed', needs: [{ kind: 'dialysis', batteryHours: null }] })
  assert.equal(r.tier, 3)
  assert.deepEqual(r.reasons, ['Sin luz confirmada'])
})

test('order: tier, then lowest battery, then oldest event', () => {
  const ids = rank([
    ev({ eventId: 1, needs: [{ kind: 'insulin', batteryHours: null }] }),                                   // tier 3
    ev({ eventId: 2, status: 'confirmed', needs: [{ kind: 'insulin', batteryHours: null }] }),              // tier 2
    ev({ eventId: 3, status: 'confirmed', needs: [{ kind: 'oxygen', batteryHours: 3 }] }),                  // tier 1, 3 h
    ev({ eventId: 4, status: 'confirmed', needs: [{ kind: 'oxygen', batteryHours: 1 }] }),                  // tier 1, 1 h
    ev({ eventId: 5, needs: [{ kind: 'oxygen', batteryHours: null }], checkinReplyAt: null }),              // tier 1, no battery
    ev({ eventId: 6, needs: [{ kind: 'oxygen', batteryHours: null }], checkinReplyAt: null, openedAt: minsAgo(90) }), // older
  ], NOW).map((r) => r.eventId)
  assert.deepEqual(ids, [4, 3, 6, 5, 2, 1])
})

test('rank is pure: it keeps the caller fields and does not mutate the input', () => {
  const input = [ev({ eventId: 1 })]
  const copy = structuredClone(input)
  const [r] = rank(input, NOW)
  assert.deepEqual(input, copy)
  assert.equal(r.eventId, 1)
})
