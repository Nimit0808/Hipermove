# HiperMove — AI Movement & Mobility Assistant

Hacktoberfest Hack Day · KodeKurrent S2 Jais × Open Science Labs · Track: **Best Use of Gemma 4**

Film a set of squats, push-ups or bicep curls with a phone. HiperMove tracks your body pose, draws the skeleton, counts reps, measures depth / tempo / torso lean per rep, and then **Gemma 4** reads both the measurements *and* the bottom-of-rep frames to explain the session in plain language.

> Measurement is done by a pose-estimation model (MediaPipe). Gemma 4 never makes up numbers; it explains the measured ones and comments on what is visible in the frames.

## How it works

```
 phone clip / webcam
        │
        ▼
 MediaPipe Pose Landmarker (in browser, WASM/GPU)  ──►  33 body landmarks per frame
        │
        ▼
 shared/repCounter.js
   • joint angle (hip-knee-ankle or shoulder-elbow-wrist), aspect-corrected
   • EMA smoothing + hysteresis state machine: top → descending → bottom → top
   • per rep: lowest angle, duration, torso lean; partial reps flagged
   • best-visibility side picked automatically
        │                                   ┌───────────────────────────────┐
        ├── live UI: skeleton, angle, count │ bottom frame of each rep is   │
        ├── angle-over-time chart           │ snapshotted with the skeleton │
        ▼                                   └───────────────────────────────┘
 POST /api/explain  { session summary JSON, up to 3 key frames (JPEG) }
        │
        ▼
 server.js ──► Gemini API ──► gemma-4-26b-a4b-it  (multimodal: text + images)
        │
        ▼
 headline · summary · observations tied to numbers · coaching tips · caveats
```

Video never leaves the browser. Only the numeric summary and at most 3 small JPEG frames are sent to the server, which forwards them to Gemma and stores nothing.

## Run it

Requirements: Node 18.17+, a Gemini API key ([AI Studio](https://aistudio.google.com/apikey)).

```bash
git clone <your-repo-url> && cd hipermove
npm install
cp .env.example .env        # put your GEMINI_API_KEY in .env
npm start                   # http://localhost:3000
npm test                    # rep-counter unit tests
```

Camera mode needs `localhost` or HTTPS. Uploading a clip works anywhere.

Optional: `docker build -t hipermove . && docker run -p 3000:3000 --env-file .env hipermove`

### Recording tips
- **Side view**, whole body in frame, phone propped at roughly hip height, steady.
- Good light, plain background, fitted clothing.
- Start standing tall (the counter arms itself once the joint is straight), do 3–10 reps, finish standing.

## Rep thresholds

| Exercise | Joint measured | Counts when below | Finishes when above | Partial if dips below |
|---|---|---|---|---|
| Squat | knee (hip–knee–ankle) | 100° | 160° | 140° |
| Push-up | elbow (shoulder–elbow–wrist) | 95° | 155° | 135° |
| Bicep curl | elbow | 55° | 145° | 110° |

Edit them in `shared/repCounter.js` → `EXERCISES`.

## Project layout

```
server.js                 Express: static files + /api/explain (Gemma 4) + /api/health
shared/repCounter.js      angle maths, smoothing, rep state machine, session summary
public/index.html         UI
public/app.js             MediaPipe setup, overlay drawing, chart, table, Gemma call
public/styles.css         light/dark theme
test/repCounter.test.js   synthetic-pose tests (full reps, partial rep, noise, low visibility)
```

## Limitations
- Single 2D camera: angles change with camera angle; a front view under-reads knee flexion. Side view is assumed.
- Thresholds are generic, not personalised; very shallow or very deep mobility ranges may need tuning.
- One person per frame. Loose clothing, occlusion and low light reduce tracking quality.
- Torso lean is relative to the image vertical, so a tilted phone adds error.
- Not a medical device. No injury or condition is diagnosed.

## Attribution
- **MediaPipe Pose Landmarker** (`@mediapipe/tasks-vision` 0.10.35, `pose_landmarker_full` model), Google, Apache 2.0. Loaded from jsDelivr / Google Storage.
- **Gemma 4** (`gemma-4-26b-a4b-it`) via the Gemini API, Google. Use is subject to the Gemma Terms of Use.
- Express, dotenv (MIT). Fonts: Barlow / Barlow Condensed (SIL OFL) via Google Fonts.

Original work for this Hack Day: rep-counting engine, per-rep metrics, key-frame capture, Gemma prompt + multimodal pipeline, and UI.
