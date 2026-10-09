// The call-list order. Fixed rules, never AI: a pure function, no DB, no I/O.
// Docs/architecture.md §3. The ranking is never stored; it is computed per request.

export type NeedKind = 'oxygen' | 'cpap' | 'ventilator' | 'dialysis' | 'insulin' | 'other'

export type RankInput = {
  eventId: number
  status: 'possible' | 'confirmed'
  openedAt: string
  needs: { kind: NeedKind; batteryHours: number | null }[]
  checkinSentAt: string | null
  checkinReplyAt: string | null
}

export type Tier = 1 | 2 | 3

const NO_REPLY_MS = 15 * 60_000
const LOW_BATTERY_H = 4
// Checked in this order; the first device found names the reason.
const BREATHING: [NeedKind, string][] = [['ventilator', 'ventilador'], ['oxygen', 'concentrador'], ['cpap', 'CPAP']]

const minBattery = (e: RankInput) =>
  Math.min(...e.needs.map((n) => n.batteryHours ?? Infinity))

function score(e: RankInput, now: number): { tier: Tier; reasons: string[] } {
  const rules: [Tier, string][] = []
  const has = (k: NeedKind) => e.needs.some((n) => n.kind === k)
  const battery = minBattery(e)
  const confirmed = e.status === 'confirmed'

  if (confirmed && battery <= LOW_BATTERY_H) rules.push([1, `Sin luz confirmada; batería dura ${battery} h`])
  const device = BREATHING.find(([k]) => has(k))
  if (device && e.checkinSentAt && !e.checkinReplyAt && now - Date.parse(e.checkinSentAt) > NO_REPLY_MS)
    rules.push([1, `Sin respuesta; usa ${device[1]}`])
  if (confirmed && has('insulin')) rules.push([2, 'Sin luz confirmada; insulina en nevera'])
  if (!confirmed) rules.push([3, 'Posible apagón, sin confirmar'])
  if (!rules.length) rules.push([3, 'Sin luz confirmada'])

  return { tier: Math.min(...rules.map(([t]) => t)) as Tier, reasons: rules.map(([, r]) => r) }
}

// Tie-break: lowest battery hours, then oldest event.
export function rank<T extends RankInput>(events: T[], now = Date.now()): (T & { tier: Tier; reasons: string[] })[] {
  return events
    .map((e) => ({ ...e, ...score(e, now) }))
    .sort((a, b) => a.tier - b.tier || minBattery(a) - minBattery(b) || Date.parse(a.openedAt) - Date.parse(b.openedAt))
}
