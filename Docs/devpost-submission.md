# Devpost submission text

Draft of 2026-10-09. Paste the sections into the matching Devpost fields.

**Project name:** VitalPower

**Tagline (under 200 characters):**
Know who to call first when the power goes out. A call list for the people in Puerto Rico who depend on electricity for medical equipment.

**Built with (tags):** react, typescript, vite, hono, node.js, sqlite, zod, anthropic-claude, web-speech-api

## Before submitting

- Add the team members, the video link and the repository link.
- Screenshots to include: the Landing page with the live number, the ranked call list with reasons, the check-in card, the three-step registration.
- "Try it out": the app runs locally only, so link the repository unless it is deployed.
- Read the two Centro de Periodismo Investigativo articles (2024 and 2025) once before submitting. The claims below were checked against search summaries and a republication, not the articles themselves.
- The test count (79) is true of `main` on 2026-10-09. Rerun `npm test` and update it if the code changes.
- Check this event's required fields and word limits. Trim "Challenges" first if you need to cut.

Sources for the figures: HHS emPOWER Map (public data, updated 2026-10-07): 44,483 Medicare beneficiaries in Puerto Rico with electricity-dependent equipment. LUMA's registry of about 3,000: statement by its president, August 2024, reported by Centro de Periodismo Investigativo. No complete registry since María: Centro de Periodismo Investigativo, September 2025.

---

## About the project (paste from here)

## Inspiration

In Puerto Rico, the power goes out a lot. For most people that is an inconvenience. For someone on a home oxygen machine, it is a countdown.

Federal Medicare data counts 44,483 people in Puerto Rico who use medical equipment that needs electricity (HHS emPOWER, October 2026). The electric company's own list of life-preserving equipment had about 3,000 people in 2024. Journalists at the Centro de Periodismo Investigativo reported in 2025 that no governor has created a complete registry since Hurricane María.

So when an outage hits, health plans and emergency offices do not know who is in danger, or who to call first. We built VitalPower to answer that one question.

## What it does

VitalPower keeps a consent-based list of patients who depend on electricity, watches for outages, and gives responder organizations a ranked call list with the reason next to every name.

- **A caregiver registers a patient by talking.** "My mother uses an oxygen concentrator with a three-hour battery." The form fills itself in. The caregiver checks it, gives consent, and saves.
- **We watch for outages.** Every three minutes the app reads LUMA's public outage data. When a registered patient's area loses power, the family gets one question: "Do you have power at home?"
- **The most urgent call comes first.** A coordinator sees the family's exact reply, confirms it, and the list reorders. The first organization to take a case gets it, so nobody is called twice and nobody is missed.
- **The loop closes.** The coordinator gets a drafted call script, makes the call, records what happened, and the family can see that someone took the case.

There are three views, one per audience: patients and caregivers, organizations, and administrators. Each person only receives what they are allowed to see. The whole app works in English and Spanish, in light and dark mode, and raises on-screen and system alerts when someone needs a call.

## The AI never decides who goes first

This was our main design rule. The order of the call list comes from a short set of fixed rules, for example "no power confirmed and four hours of battery or less". The reason is shown beside every name, so a coordinator can always see why someone is first.

AI (Claude) does three smaller jobs: it fills the registration form from what the caregiver says, reads the family's reply for the coordinator, and drafts the call script. A person checks every one of those before it is used, and if the AI is unavailable, people do the step by hand.

## How we built it

- **Frontend:** React and TypeScript with Vite. No UI framework; our own stylesheet with design tokens for both themes.
- **Backend:** Hono on Node, with SQLite through Node's built-in driver. The frontend calls the API through a typed client, so a changed route breaks the build instead of the demo.
- **Outage data:** LUMA's public outage feed, polled every three minutes. Every reading is stored, including failures, which lets us replay a real recorded outage for the demo.
- **AI:** the Anthropic API with structured outputs, validated again on our side.
- **Safety:** who can see what is enforced in the database queries, not in the screens. 79 automated tests cover the ranking rules, the visibility rules, the claim race between organizations, and the AI steps.
- **Browser features:** speech recognition for voice registration, system notifications for alerts.

## Challenges we ran into

- **The outage feed did not behave the way we expected.** It rejects requests that do not look like a browser, answers an unknown town name with an empty list instead of an error, and spells municipalities without accents but keeps the Ñ. We now store every reading and mark the screen when data is old.
- **Keeping the AI in its place.** A reply like "the battery is about half" is easy for a model to turn into a guess. We made sure a reply can never change the order by itself: a person confirms, and the rules use the battery hours on file.
- **Two people, one codebase, two days.** At one point a merge left the main branch unable to build. Running the tests and the build before every push fixed that habit quickly.
- **Checking our own claims.** When we fact-checked the pitch we found two lines that were wrong as worded. A registry does exist at the electric company; it is just very small. And federal data does include names, but only for health authorities during an emergency. We rewrote both.

## Accomplishments that we're proud of

- The full story runs end to end on a real recorded outage: registration, outage, check-in, confirmation, ranked list, call script, outcome.
- A coordinator can always see why a patient is where they are on the list.
- It is usable by someone who is not comfortable with technology: large text, one clear action per screen, voice input, two languages.

## What we learned

- In health care, being able to explain a decision matters more than making it clever.
- Public data is only useful if you plan for the moments it is late, missing or wrong.
- Checking the facts in your own pitch is worth an hour.

## What's next for VitalPower

- **A power sensor in the home.** A small plug-in device with its own battery and cell connection that tells us the moment the power goes out, so we do not depend on a single source of outage data. Devices like this already exist, so it is buildable.
- **Text messages,** so the outage question reaches the family's phone directly.
- **Real sign-in** for families and organizations. The demo uses a persona switcher and fictional patients only.
- **A first pilot** with one health plan or municipality, with real patients who choose to join.
