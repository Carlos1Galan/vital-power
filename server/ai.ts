import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { MUNICIPALITIES } from './municipalities.ts'
import { knownZones } from './events.ts'

// The 3 Claude calls. Every output is zod-validated and goes to a person before it is used:
// the caregiver confirms the profile, the coordinator sees the reply next to its reading, the coordinator approves the briefing.
// None of them touches priority: that is fixed rules in priority.ts.

export const NEEDS = ['oxygen', 'cpap', 'ventilator', 'dialysis', 'insulin', 'other'] as const

const MODEL = 'claude-sonnet-5-5' // Docs/architecture.md §2
let client: Anthropic | undefined // created on first use, so tests and keyless dev never need a key

async function ask<T>(schema: z.ZodType<T>, system: string, content: string): Promise<T> {
  client ??= new Anthropic()
  const r = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4096,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default', // a safety decline reruns on a fallback model instead of failing the intake
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: 'user', content }],
  })
  if (r.parsed_output == null) throw new Error(`AI returned no valid output (stop_reason: ${r.stop_reason})`)
  return r.parsed_output
}

const Draft = z.object({
  displayName: z.string().nullable(),
  phone: z.string().nullable(),
  municipality: z.enum(MUNICIPALITIES).nullable(),
  placeHint: z.string().nullable(),
  needs: z.array(z.object({ kind: z.enum(NEEDS), batteryHours: z.number().nullable() })),
})

// Transcript → draft profile. The zone is one of knownZones(municipality) or null, never free text.
async function extractProfile(transcript: string) {
  const d = await ask(Draft, `Extrae el perfil de un paciente dependiente de electricidad en Puerto Rico a partir del relato de su cuidador.
- displayName: nombre o apodo del paciente, como lo dice el relato.
- municipality: uno de los municipios de la lista (mayúsculas, como los escribe LUMA), o null si no se menciona.
- placeHint: urbanización, barrio, sector o calle tal como se dice, o null.
- needs: cada equipo o tratamiento (oxygen = concentrador de oxígeno, cpap, ventilator, dialysis, insulin = insulina que necesita nevera, other). batteryHours solo si el relato dice cuántas horas dura la batería.
No inventes datos: lo que no está en el relato es null.`, `<relato>${transcript}</relato>`)
  const zones = d.municipality ? knownZones(d.municipality) : []
  const zone = d.placeHint && zones.length ? await matchZone(d.placeHint, zones) : null
  return { displayName: d.displayName, phone: d.phone, municipality: d.municipality, zone, needs: d.needs }
}

async function matchZone(hint: string, zones: string[]) {
  const Zone = z.object({ zone: z.enum(zones as [string, ...string[]]).nullable() })
  const { zone } = await ask(Zone, 'Elige la zona de LUMA que corresponde al lugar descrito. Si ninguna corresponde con claridad, responde null. Nunca adivines.', `<lugar>${hint}</lugar>`)
  return zone
}

const Reading = z.object({
  hasPower: z.boolean().nullable(),
  needsHelp: z.boolean(),
  summary: z.string(),
})

// Check-in reply → reading. The coordinator sees it next to the original text and confirms.
async function parseReply(message: string, reply: string) {
  return ask(Reading, `Lee la respuesta de un paciente (o su cuidador) a un mensaje de VitalPower durante un apagón.
- hasPower: true si dice que tiene luz, false si no tiene, null si no queda claro.
- needsHelp: true si pide ayuda o describe un riesgo (batería baja, falta de aire, insulina sin nevera).
- summary: una oración en español con lo que dijo, sin añadir nada.`, `<mensaje>${message}</mensaje>\n<respuesta>${reply}</respuesta>`)
}

const Briefing = z.object({ briefing: z.string(), callScript: z.string() })

// Event context → Spanish briefing and call script. The coordinator edits and approves before use.
async function draftBriefing(context: object) {
  return ask(Briefing, `Redacta en español, para un coordinador de respuesta en Puerto Rico:
- briefing: 3 a 5 líneas con la situación del paciente, usando solo los datos dados.
- callScript: el guion breve de la llamada al paciente o su cuidador.
El orden de prioridad ya fue decidido por reglas fijas: no lo cambies ni lo comentes.`, `<caso>${JSON.stringify(context)}</caso>`)
}

// One object so tests can stub a call with mock.method(ai, ...).
export const ai = { extractProfile, parseReply, draftBriefing }
