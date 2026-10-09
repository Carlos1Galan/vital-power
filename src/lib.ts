import { translate, getLang, type TextKey, type Translator } from './i18n.ts'
// Small helpers shared by B's screens.

export const NEED_KEY: Record<string, TextKey> = {
  oxygen: 'need.oxygen', cpap: 'need.cpap', ventilator: 'need.ventilator', dialysis: 'need.dialysis', insulin: 'need.insulin', other: 'need.other',
}

export type Need = { kind: string; batteryHours: number | null }
export const needText = (n: Need, t: Translator) => {
  const need = NEED_KEY[n.kind] ? t(NEED_KEY[n.kind]) : n.kind
  return n.batteryHours === null ? need : t('need.withBattery', { need, hours: n.batteryHours })
}

// Every API error comes back as { error: string }; fall back to the status code.
export async function errorText(res: Response) {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown }
  return typeof body.error === 'string' ? body.error : translate(getLang(), 'common.errorStatus', { status: res.status })
}

export function ago(iso: string, t: Translator, now = Date.now()) {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (min < 1) return t('time.now')
  if (min < 60) return t('time.minutes', { minutes: min })
  const h = Math.floor(min / 60)
  return h < 24 ? t('time.hours', { hours: h, minutes: min % 60 }) : t('time.days', { days: Math.floor(h / 24) })
}

// Mirrors server/municipalities.ts.
export const MUNICIPALITIES = [
  'ADJUNTAS', 'AGUADA', 'AGUADILLA', 'AGUAS BUENAS', 'AIBONITO', 'AÑASCO', 'ARECIBO', 'ARROYO',
  'BARCELONETA', 'BARRANQUITAS', 'BAYAMON', 'CABO ROJO', 'CAGUAS', 'CAMUY', 'CANOVANAS', 'CAROLINA',
  'CATAÑO', 'CAYEY', 'CEIBA', 'CIALES', 'CIDRA', 'COAMO', 'COMERIO', 'COROZAL', 'CULEBRA', 'DORADO',
  'FAJARDO', 'FLORIDA', 'GUANICA', 'GUAYAMA', 'GUAYANILLA', 'GUAYNABO', 'GURABO', 'HATILLO',
  'HORMIGUEROS', 'HUMACAO', 'ISABELA', 'JAYUYA', 'JUANA DIAZ', 'JUNCOS', 'LAJAS', 'LARES',
  'LAS MARIAS', 'LAS PIEDRAS', 'LOIZA', 'LUQUILLO', 'MANATI', 'MARICAO', 'MAUNABO', 'MAYAGUEZ',
  'MOCA', 'MOROVIS', 'NAGUABO', 'NARANJITO', 'OROCOVIS', 'PATILLAS', 'PEÑUELAS', 'PONCE',
  'QUEBRADILLAS', 'RINCON', 'RIO GRANDE', 'SABANA GRANDE', 'SALINAS', 'SAN GERMAN', 'SAN JUAN',
  'SAN LORENZO', 'SAN SEBASTIAN', 'SANTA ISABEL', 'TOA ALTA', 'TOA BAJA', 'TRUJILLO ALTO', 'UTUADO',
  'VEGA ALTA', 'VEGA BAJA', 'VIEQUES', 'VILLALBA', 'YABUCOA', 'YAUCO',
] as const
