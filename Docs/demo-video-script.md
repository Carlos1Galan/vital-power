# VitalPower demo video script

Two minutes, in English. It follows the sequence that was run end to end against the app on 2026-10-09, with the button names as they appear on screen in English.

## Before you record

- **Machine:** the one with the recorded outage. `git pull`, `npm run build`, `npm start`, open port 3000. (On Windows, `npm start` does not work; use `npm run api` and `npm run dev` and open port 5173.)
- **Browser:** Edge or Chrome, 100% zoom, full screen, bookmarks bar hidden. Dictation does not work in Brave.
- **Language:** English. The header button should read "Español".
- **Clean start:** as Platform admin, scroll to the bottom of Administration and press "Reset the demo", then "Yes, reset now".
- **Alerts:** press "Turn on alerts" once and allow notifications, so the pop-up and chime are on camera.
- **Know the reading number:** the recorded reading that contains the outage in the patient's zone. You type it in step 3.
- **Practice the voice line** twice. If dictation misfires on the take, type it; the result is the same.

## The script

| Time | What you do on screen | What you say |
|---|---|---|
| 0:00–0:10 | Landing page. Let the live number count up. | "This is VitalPower. Right now in Puerto Rico, this many homes have no power. Some of them have someone who depends on a medical machine." |
| 0:10–0:35 | "View as" → **Caregiver Ana (daughter)**. Press **Register a person** → **For someone else** → **Speak**, and say the patient line. Press **Continue**. The form fills in. Tick the consent box, press **Save registration**. | "Ana registers her mother just by talking." *(patient line)* "The form fills itself in. Ana checks it, gives consent, and saves." |
| 0:35–0:50 | "View as" → **Platform admin**. Under LUMA readings, type the reading number, press **Start replay**. Point at **Replay** in the header. | "We can't cause an outage on camera, so we replay a real one we recorded this week from LUMA's public data. The screen says replay." |
| 0:50–1:10 | "View as" → **Caregiver Ana**. The alert card slides in. In the check-in, type the reply and press **Send reply**. | "The outage reaches Doña Luz's neighborhood, and Ana gets one question: do you have power at home? She answers in her own words." |
| 1:10–1:30 | "View as" → **Health Plan coordinator**. Find Doña Luz, press **View case**. Point at the original reply, then the automatic reading. Press **Confirm: no power**. She moves to position 1. | "The coordinator sees Ana's exact words, and an automatic reading under them. A person confirms. Now Doña Luz is first on the list, and the reason is right there: no power, three hours of battery." |
| 1:30–1:50 | Press **Take case**. Press **Draft summary**, wait a few seconds, press **Approve summary**. In "What happened on the call?" type the result, press **Save result**. | "The health plan takes the case, so no other organization calls twice. The app drafts a call script, the coordinator approves it, makes the call, and records what happened." |
| 1:50–2:00 | "View as" → **Caregiver Ana**. Show Doña Luz's card: "Health Plan Demo took your case" and the call result. | "And Ana can see it: someone took her mother's case, and help is on the way. VitalPower. Know who to call first." |

## Lines to say or type on screen

- **Patient line (0:10):** "My mother, Doña Luz, lives in Villa Blanca in Caguas. She uses an oxygen concentrator with a three-hour battery. Her phone is 787-555-0199."
- **Ana's reply (0:50):** "No power since this morning, and the battery is about half."
- **Call result (1:30):** "Battery for one more hour." Next step: "Bring a portable generator."

## Why these exact words matter

- **"Three-hour battery"** is what puts Doña Luz first. The rule is confirmed no power plus 4 hours of battery or less. "About half" in the reply does not change the order, by design: the order comes from fixed rules and registered data, never from the AI's reading.
- **"Villa Blanca in Caguas"** has to match a zone in the recorded outage, or she is never flagged. If the recording covers a different zone, change the line to that zone.
- **Register before starting the replay.** A patient added after the replay starts is not flagged until the next reading.
- **Do not press "next reading"** after starting the replay. It can end the outage and remove the case mid-demo.
- **Use the Health Plan coordinator.** That organization covers Caguas and San Juan; the Emergency Office covers Caguas only; the Oxygen Supplier is pending and sees nothing.

## If something goes wrong on a take

- **Dictation fails:** type the patient line and carry on.
- **The form does not fill in:** fill it in by hand, or re-record. The AI takes 3 to 13 seconds, so pause the narration there.
- **The draft summary fails:** choose to write it yourself and type one sentence.
- **Anything else:** reset the demo and start again. A clean take is about two minutes.

## Recording

- **Windows:** Win+Alt+R starts and stops recording the active window; turn the microphone on in the Game Bar (Win+G).
- **Easier:** record the clicks silently, then read the script over it in a video editor. You can cut the waits while the AI works (around 0:30 and 1:35).

## Not confirmed

- The reading number on the presenting machine.
- How the Speak button handles an English sentence in the presenting browser. The flow was tested by typing.
