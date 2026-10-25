# Submission kit

## Slide outline (8 slides)
1. **HiperMove** — one line: "Film a set. We count reps, measure your movement, Gemma explains it." Team names.
2. **Problem** — people training at home can't see their own form; rep counters exist, but numbers like "knee angle 94°" mean nothing to most users. No extra equipment allowed: just a phone.
3. **Solution** — screenshot of the app mid-squat (skeleton + yellow measured joint + big rep counter).
4. **Architecture** — the diagram from README. Stress: measurement = MediaPipe, explanation = Gemma 4, video stays in the browser.
5. **How Gemma 4 is used** — multimodal: session JSON + up to 3 bottom-of-rep frames with skeleton overlay → structured JSON (headline, observations tied to numbers, tips, caveats). Guardrails: no invented numbers, no diagnosis. Model: gemma-4-26b-a4b-it via Gemini API.
6. **Results** — your test clip: reps counted vs actual (e.g. 10/10), screenshot of rep table + angle chart + Gemma notes. Mention unit tests (synthetic poses: full, partial, noise, low visibility).
7. **Limitations** — 2D/side view only, generic thresholds, single person, not medical.
8. **Next** — more exercises, personalised thresholds from a calibration rep, session history, on-device Gemma for full offline privacy.

## 5-minute demo video script
- **0:00–0:30** Problem + what HiperMove does.
- **0:30–2:00** Upload a side-view squat clip. Point out skeleton, yellow knee joint with live angle, counter ticking, phase, angle chart dipping under the 100° line, rep rows filling in.
- **2:00–2:30** Show a partial rep getting flagged instead of counted.
- **2:30–3:30** Click **Explain my session**. Read Gemma's headline and one observation that cites a real measured number; point out it also commented on the frames.
- **3:30–4:15** Code tour: `repCounter.js` state machine, `server.js` prompt + image parts, `.env.example` (no keys committed). Run `npm test`.
- **4:15–5:00** Accuracy check (counted vs real), limitations, next steps.

## Pre-submit checklist
- [ ] Repo public, `.env` not committed, README renders
- [ ] Test clip recorded side view; real rep count noted for the accuracy slide
- [ ] Gemma response screenshot in slides
- [ ] Video under 5:00, links open in an incognito window
