// Small helpers shared by B's screens.

export const NEED_LABEL: Record<string, string> = {
  oxygen: 'Oxígeno', cpap: 'CPAP', ventilator: 'Ventilador', dialysis: 'Diálisis', insulin: 'Insulina', other: 'Otro equipo',
}

export type Need = { kind: string; batteryHours: number | null }
export const needText = (n: Need) => `${NEED_LABEL[n.kind] ?? n.kind}${n.batteryHours === null ? '' : ` · batería ${n.batteryHours} h`}`

// Every API error comes back as { error: string }; fall back to the status code.
export async function errorText(res: Response) {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown }
  return typeof body.error === 'string' ? body.error : `Error ${res.status}`
}

export function ago(iso: string, now = Date.now()) {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 1) return 'ahora mismo'
  if (min < 60) return `hace ${min} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `hace ${h} h ${min % 60} min` : `hace ${Math.floor(h / 24)} d`
}
