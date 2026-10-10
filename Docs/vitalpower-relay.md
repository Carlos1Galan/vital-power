# VitalPower Relay

**Caribbean AI Summit Healthcare Hackathon, October 8–10, 2026**
**Team of 2. Software only. Revised 2026-10-05: the hardware sensor is replaced by LUMA's public outage data.**

---

## One-line pitch

> Puerto Rico still has no list of people who need electricity to stay alive. VitalPower Relay builds one with consent, watches LUMA's outage data, and turns an outage into a call made to the right patient first.

---

## The problem

- Outages in Puerto Rico added up to **18+ hours per customer** in the fiscal year to date, and their duration is up **16.2%**.
- **17.8% of adults have diabetes.** Insulin can stay out of the fridge only up to 86°F (FDA), and a home without power goes past that.
- Patients on **oxygen concentrators and CPAP machines** depend on batteries that last hours, not days.
- **Nobody keeps a list of these patients.** CPI reported that no governor has created a registry of electricity-dependent people.

When the power goes out today, nobody knows which patient to call first.

---

## How it works

1. **Spanish voice intake.** A caregiver says *"mi papá usa concentrador, la batería dura dos horas, y tiene insulina en la nevera."* The AI turns that into a structured profile (equipment, battery duration, medication, municipality and barrio). The caregiver confirms it before it is saved.
2. **Outage watch.** The system polls LUMA's public outage data every few minutes and matches the affected municipalities and zones against the registered patients' locations.
3. **Check-in.** LUMA reports outages by zone, not by house. So when a patient's zone appears, the system sends a check-in message (*"¿Tiene luz en su casa?"*). Until the patient answers, their status is shown as **"possible outage, unconfirmed."**
4. **Prioritized call list.** Fixed, transparent rules order the patients, for example "battery lasts 2 hours" goes above "insulin in the fridge." Each ranking **shows its reason**. The AI never decides who gets help first.
5. **The coordinator acts.** The AI drafts a Spanish briefing and call script. A human approves it, makes the call, and **records the outcome** and the next action.
6. **Honest about stale data.** Every screen shows the timestamp of the last LUMA reading. If the feed stops responding, the data is labeled "stale" instead of being shown as current.

---

## The data source: LUMA

LUMA's public outage page is `https://miluma.lumapr.com/outages/status`. The page loads its data from two public endpoints, both checked on 2026-10-05:

| Endpoint | What it returns |
|---|---|
| `GET https://api.miluma.lumapr.com/miluma-outage-api/outage/regionsWithoutService` | The 7 regions, each with total clients, clients without service, clients affected by planned outages, clients affected by load shedding, percentages, and a timestamp |
| `POST https://api.miluma.lumapr.com/miluma-outage-api/outage/municipality/towns` | For each municipality sent in the body, the list of affected zones (barrios and sectors) |

**What we learned from testing them:**

- The municipality endpoint needs the name in **uppercase** (`["ARECIBO"]`). A mixed-case name returns an empty list, and an unknown name returns a 500 error.
- It returns **zone names only**, with no customer counts per zone.
- Counts exist only at the **region** level.
- The data separates **planned outages** and **load shedding** from other outages, which is useful for the priority rules: a planned outage has a known end.

**Limits to design around:**

- These endpoints are **undocumented**. LUMA can change or block them at any time, so the app must store every reading and keep working from the last one.
- The finest detail is the **zone**, which is why the check-in step exists.
- We have not read LUMA's terms of use for this data. Ask at the kickoff or check before the demo.

---

## Where the AI is used

| Task | AI or rules | Human check |
|---|---|---|
| Spanish voice note to structured patient profile | AI | Caregiver confirms |
| Matching a free-text address to a municipality and zone | AI, with a fixed list of LUMA zone names | Caregiver confirms |
| Priority order of the call list | **Rules, not AI** | Reason shown on screen |
| Spanish briefing and call script | AI | Coordinator approves |
| Reading the patient's check-in reply | AI | Coordinator sees the original text |

---

## The 2-minute demo

We cannot cause a real outage on stage, so the demo uses **a recorded real LUMA outage, replayed**, and says so on screen.

| Time | What judges see |
|---|---|
| 0:00–0:20 | Meet the patient (synthetic). A Spanish voice note becomes a confirmed profile |
| 0:20–0:35 | **The live LUMA feed**, with today's real numbers and timestamp |
| 0:35–0:55 | **Replay of a recorded real outage** in the patient's zone, labeled "replay." The patient moves to "possible outage, unconfirmed" |
| 0:55–1:15 | The check-in goes out. The patient answers *"no hay luz, la batería está en la mitad"* and the status becomes confirmed |
| 1:15–1:35 | The call list reorders, with the reason for the priority shown |
| 1:35–1:50 | The coordinator approves the Spanish briefing and records the contact and next action |
| 1:50–2:00 | Close on the patient's recorded outcome: someone got help |

**Before the event:** start saving LUMA readings as soon as the hackathon begins, so the replay comes from a real outage captured during the build.

---

## Build plan for 2 people

| | Person A | Person B |
|---|---|---|
| **Owns** | LUMA polling, storing readings, zone matching, priority rules, replay mode, failure tests | Interface, AI extraction, check-in flow, approval and briefing, demo video |

- **Stack:** Node, React and Postgres (Supabase).
- **Friday morning:** the full path works end to end with one patient (reading arrives, patient is flagged, call list updates).
- **Friday evening:** stop adding features. Saturday is for the demo and the video.

**In scope**

- 5 synthetic patients in 2 municipalities, registered by a caregiver, a care facility and a patient registering themselves
- Responder organizations that register, declare the municipalities they serve, and are approved by an admin; the first to claim an event makes the call
- Demo persona switcher for every role (no real authentication)
- Live LUMA polling plus replay mode
- Check-in, call list, briefing, recorded outcome

**Cut**

- Any hardware
- Pharmacy fridge reservations and handoffs
- Transport, municipal maps, EHR integration
- Any "time until the medicine goes bad" estimate

---

## Future plan (mention in the pitch, do not build)

- **Home sensor.** A small ESP32 board with a temperature probe in the patient's fridge. It confirms the outage at the house itself and removes the need for the check-in message.
- **Pharmacy mode.** When a pharmacy's fridge loses power, the same system lists the patients whose prescriptions are waiting there, for the pharmacist to review.
- **Generator-backed storage.** Community pharmacies offering fridge space for patients' insulin during long outages. This needs legal review under Puerto Rico's Pharmacy Law (Ley 247-2004).
- **An official data agreement with LUMA**, for household-level outage data instead of zone-level.

---

## Risks and open questions

| Risk | How we handle it |
|---|---|
| LUMA changes or blocks the endpoints | Store every reading, label stale data, and keep replay mode as the demo fallback |
| A zone-level outage does not mean the patient's home is out | The check-in step, and the "unconfirmed" label |
| The patient does not answer the check-in | No answer plus high-risk equipment moves the patient up the list, with that reason shown |
| Judges ask "who makes the calls?" | Registered **responder organizations** (clinic, municipality, health plan, DME supplier), each for the municipalities it declared and an admin approved. The first to claim an event makes the call. Still ask at the kickoff who would run it in real life |
| Judges ask about patient privacy | All demo patients are synthetic. Real use needs consent at sign-up, which the intake step already records |

**Still to find out at the kickoff on October 8:**

1. Who would run the call center in real life.
2. Whether community pharmacies are CUD members.
3. Whether there is any rule against using LUMA's public data.

---

## Rules reminder

The Devpost rules **prohibit arriving with a prebuilt project.**

- **Allowed before October 8:** installing tools, reading how LUMA's endpoints respond, sketches, interviews, this document.
- **Not allowed:** writing the VitalPower Relay code early.

---

## Backup idea

**CareGap PR** (the coworker's original top pick). It is the most reliable build, but similar tools already exist in Puerto Rico's health plans (Triple-S uses Nagnoi STARSTrack), so it is weaker on novelty.

---

## Sources

- [LUMA outage status page](https://miluma.lumapr.com/outages/status)
- [LUMA outages up 16.2% (Metro, Jan 2026)](https://www.metro.pr/noticias/2026/01/28/aumentan-apagones-en-puerto-rico-duracion-sube-162-y-frecuencia-33/)
- [18+ hours without power, fiscal year to date (Metro, Apr 2026)](https://www.metro.pr/noticias/2026/04/06/informe-de-luma-refleja-139-minutos-sin-luz-en-febrero/)
- [FDA insulin storage in emergencies](https://www.fda.gov/drugs/emergency-preparedness-drugs/informacion-sobre-el-almacenamiento-de-insulina-y-el-cambio-entre-productos-durante-una-emergencia)
- [No registry of electricity-dependent patients (CPI)](https://periodismoinvestigativo.com/2025/09/puerto-rico-electricity-dependent-patients-registry-maria/)
- [Devpost rules](https://caribbean-ai-summit-hackathon.devpost.com/rules)
