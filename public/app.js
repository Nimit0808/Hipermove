import {
  FilesetResolver,
  PoseLandmarker,
  DrawingUtils,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs';
import { EXERCISES, RepCounter } from '/shared/repCounter.js';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

const $ = (id) => document.getElementById(id);
const els = {
  exercise: $('exercise'), file: $('file'), camera: $('camera'), stop: $('stop'),
  stage: $('stage'), video: $('video'), overlay: $('overlay'), empty: $('empty'),
  status: $('status'), tip: $('tip'), reps: $('reps'), angle: $('angle'), phase: $('phase'),
  partials: $('partials'), side: $('side'), metricLabel: $('metricLabel'), thresholdHint: $('thresholdHint'),
  trace: $('trace'), repRows: $('repRows'), leanHead: $('leanHead'), download: $('download'),
  explain: $('explain'), gemmaOut: $('gemmaOut'), modelTag: $('modelTag'),
};
const ctx = els.overlay.getContext('2d');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let landmarker = null;
let draw = null;
let counter = new RepCounter(els.exercise.value);
let source = null; // 'file' | 'camera'
let stream = null;
let running = false;
let lastVideoTime = -1;
let lastTs = 0;
let camStart = 0;
let samples = [];      // { t, a } for the trace
let repMarks = [];     // t (ms) when reps finished
let keyframes = [];    // data URLs of rep bottoms
let lastTraceDraw = 0;
const snap = document.createElement('canvas');
let snapDirty = false;

// ---------- setup ----------
async function initLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(WASM);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts('GPU'));
  } catch {
    landmarker = await PoseLandmarker.createFromOptions(vision, opts('CPU'));
  }
  draw = new DrawingUtils(ctx);
}

function applyExercise() {
  const ex = EXERCISES[els.exercise.value];
  els.metricLabel.textContent = ex.metric[0].toUpperCase() + ex.metric.slice(1);
  els.tip.textContent = ex.cameraTip;
  els.thresholdHint.textContent =
    `A rep counts when the ${ex.metric} drops to ${ex.down}° or lower and comes back above ${ex.up}°.`;
  els.leanHead.textContent = ex.torso ? 'Torso lean' : '—';
}

function resetSession() {
  counter = new RepCounter(els.exercise.value);
  samples = []; repMarks = []; keyframes = [];
  lastVideoTime = -1;
  els.reps.textContent = '0';
  els.angle.textContent = '–';
  els.phase.textContent = 'waiting';
  els.partials.textContent = '0';
  els.side.textContent = '–';
  els.repRows.innerHTML = '<tr class="placeholder"><td colspan="5">Reps appear here as they finish.</td></tr>';
  els.gemmaOut.hidden = true;
  els.gemmaOut.innerHTML = '';
  els.explain.disabled = true;
  els.download.disabled = true;
  drawTrace(true);
}

// ---------- sources ----------
function sizeStage() {
  const { videoWidth: w, videoHeight: h } = els.video;
  if (!w || !h) return;
  els.overlay.width = w;
  els.overlay.height = h;
  els.stage.style.aspectRatio = `${w} / ${h}`;
  const scale = Math.min(1, 480 / w);
  snap.width = Math.round(w * scale);
  snap.height = Math.round(h * scale);
}

async function startFile(file) {
  await stopAll();
  resetSession();
  source = 'file';
  els.stage.classList.remove('mirror');
  els.video.srcObject = null;
  els.video.src = URL.createObjectURL(file);
  els.video.loop = false;
  await once(els.video, 'loadedmetadata');
  sizeStage();
  els.empty.hidden = true;
  await els.video.play();
  begin();
}

async function startCamera() {
  await stopAll();
  resetSession();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch {
    setStatus('Camera access was blocked. Allow camera access in the browser, or upload a clip instead.');
    return;
  }
  source = 'camera';
  els.stage.classList.add('mirror');
  els.video.removeAttribute('src');
  els.video.srcObject = stream;
  await once(els.video, 'loadedmetadata');
  sizeStage();
  els.empty.hidden = true;
  await els.video.play();
  camStart = performance.now();
  begin();
}

function begin() {
  running = true;
  els.stop.disabled = false;
  els.exercise.disabled = true;
  requestAnimationFrame(loop);
}

async function stopAll() {
  running = false;
  els.video.pause();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  els.stop.disabled = true;
  els.exercise.disabled = false;
}

function finish() {
  running = false;
  els.stop.disabled = true;
  els.exercise.disabled = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  drawTrace(true);
  const done = counter.reps.length > 0 || counter.partials > 0;
  els.explain.disabled = !done;
  els.download.disabled = !done;
  els.phase.textContent = 'done';
  if (done) explain(); // start Gemma right away so notes are ready when the user looks
  if (!done) setStatus('No complete reps detected. Check the camera angle and that the whole body is visible.', true);
}

// ---------- main loop ----------
function loop() {
  if (!running) return;
  const v = els.video;
  if (v.readyState >= 2 && v.currentTime !== lastVideoTime) {
    lastVideoTime = v.currentTime;
    const ts = Math.max(lastTs + 1, performance.now());
    lastTs = ts;
    const result = landmarker.detectForVideo(v, ts);
    const tMs = source === 'file' ? v.currentTime * 1000 : performance.now() - camStart;
    handleResult(result, tMs);
  }
  if (source === 'file' && v.ended) { finish(); return; }
  requestAnimationFrame(loop);
}

function handleResult(result, tMs) {
  const W = els.overlay.width, H = els.overlay.height;
  ctx.clearRect(0, 0, W, H);
  const lm = result.landmarks?.[0];
  if (!lm) { els.phase.textContent = 'no person found'; return; }

  const bone = css('--bone'), mark = css('--mark');
  const lw = Math.max(2, W / 320);
  draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: bone, lineWidth: lw });
  draw.drawLandmarks(lm, { color: '#ffffff', fillColor: bone, radius: lw * 1.2, lineWidth: 1 });

  const out = counter.update(lm, tMs, W / H);
  if (!out) { els.phase.textContent = 'joint not visible'; return; }

  // highlight measured joint
  const [a, b, c] = counter.ex.joints[out.side].map((i) => lm[i]);
  ctx.strokeStyle = mark; ctx.lineWidth = lw * 2.2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(a.x * W, a.y * H); ctx.lineTo(b.x * W, b.y * H); ctx.lineTo(c.x * W, c.y * H); ctx.stroke();
  ctx.fillStyle = mark; ctx.beginPath(); ctx.arc(b.x * W, b.y * H, lw * 3, 0, Math.PI * 2); ctx.fill();
  drawAngleLabel(b.x * W, b.y * H, out.angle, lw, mark);

  if (out.newMin && snap.width) {
    const s = snap.getContext('2d');
    s.drawImage(els.video, 0, 0, snap.width, snap.height);
    s.drawImage(els.overlay, 0, 0, snap.width, snap.height);
    snapDirty = true;
  }

  for (const ev of out.events) {
    if (ev.type === 'rep') {
      repMarks.push(tMs);
      if (snapDirty) { keyframes.push(snap.toDataURL('image/jpeg', 0.72)); snapDirty = false; }
      addRepRow(ev.rep);
      els.reps.textContent = String(counter.reps.length);
      els.reps.classList.remove('bump'); void els.reps.offsetWidth; els.reps.classList.add('bump');
    } else if (ev.type === 'partial') {
      snapDirty = false;
      els.partials.textContent = String(counter.partials);
    }
  }

  els.angle.textContent = Math.round(out.angle);
  els.phase.textContent = out.phase;
  els.side.textContent = out.side;
  samples.push({ t: tMs, a: out.angle });
  if (performance.now() - lastTraceDraw > 120) drawTrace();
}

function drawAngleLabel(x, y, angle, lw, color) {
  // Canvas may be CSS-mirrored for the camera; flip text back so it stays readable.
  const mirrored = els.stage.classList.contains('mirror');
  const text = `${Math.round(angle)}°`;
  ctx.save();
  ctx.font = `700 ${Math.round(lw * 9)}px 'Barlow Condensed', sans-serif`;
  const tw = ctx.measureText(text).width;
  const px = x + lw * 6, py = y - lw * 6;
  ctx.translate(px, py);
  if (mirrored) ctx.scale(-1, 1);
  const ox = mirrored ? -tw - lw * 4 : 0;
  ctx.fillStyle = 'rgba(11,17,23,.75)';
  ctx.fillRect(ox - lw * 2, -lw * 9, tw + lw * 4, lw * 11);
  ctx.fillStyle = color;
  ctx.fillText(text, ox, 0);
  ctx.restore();
}

// ---------- trace chart ----------
function drawTrace(force = false) {
  lastTraceDraw = performance.now();
  const cv = els.trace;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const ex = counter.ex;
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const lo = 30, hi = 185;
  const y = (a) => pad.t + (1 - (a - lo) / (hi - lo)) * (h - pad.t - pad.b);
  const muted = css('--muted'), line = css('--line'), bone = css('--bone'), mark = css('--mark');

  g.font = "12px 'Barlow', sans-serif"; g.fillStyle = muted; g.textBaseline = 'middle';
  for (const [a, label] of [[ex.up, `${ex.up}°`], [ex.down, `${ex.down}°`]]) {
    g.strokeStyle = line; g.setLineDash([4, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, y(a)); g.lineTo(w - pad.r, y(a)); g.stroke();
    g.fillText(label, 2, y(a));
  }
  g.setLineDash([]);
  if (samples.length < 2) {
    g.fillText('The joint angle will plot here while the clip plays.', pad.l + 8, h / 2);
    return;
  }

  // file: whole clip so far; camera: last 20 s
  const tEnd = samples[samples.length - 1].t;
  const tStart = source === 'camera' ? Math.max(samples[0].t, tEnd - 20000) : samples[0].t;
  const span = Math.max(1, tEnd - tStart);
  const x = (t) => pad.l + ((t - tStart) / span) * (w - pad.l - pad.r);

  g.strokeStyle = mark; g.lineWidth = 2;
  for (const t of repMarks) {
    if (t < tStart) continue;
    g.beginPath(); g.moveTo(x(t), pad.t); g.lineTo(x(t), h - pad.b); g.stroke();
  }
  g.strokeStyle = bone; g.lineWidth = 2; g.lineJoin = 'round';
  g.beginPath();
  let started = false;
  for (const s of samples) {
    if (s.t < tStart) continue;
    const px = x(s.t), py = y(Math.min(hi, Math.max(lo, s.a)));
    started ? g.lineTo(px, py) : g.moveTo(px, py);
    started = true;
  }
  g.stroke();
  g.fillStyle = muted; g.textBaseline = 'alphabetic';
  g.fillText(`${(tStart / 1000).toFixed(1)} s`, pad.l, h - 3);
  const endLabel = `${(tEnd / 1000).toFixed(1)} s`;
  g.fillText(endLabel, w - pad.r - g.measureText(endLabel).width, h - 3);
}

// ---------- reps table ----------
function addRepRow(rep) {
  const placeholder = els.repRows.querySelector('.placeholder');
  if (placeholder) placeholder.remove();
  const ex = counter.ex;
  const notes = [];
  if (rep.minAngle <= ex.down - 15) notes.push(['Full range', 'note-good']);
  else if (rep.minAngle > ex.down - 3) notes.push(['Just reached depth', 'note-warn']);
  if (rep.durationS < 1.0) notes.push(['Fast', 'note-warn']);
  if (counter.key === 'squat' && rep.torsoLean != null && rep.torsoLean > 45) notes.push(['Leaning forward', 'note-warn']);
  if (counter.key === 'curl' && rep.torsoLean != null && rep.torsoLean > 15) notes.push(['Body swing', 'note-warn']);

  const tr = document.createElement('tr');
  const cells = [
    String(rep.n),
    `${Math.round(rep.minAngle)}°`,
    `${rep.durationS.toFixed(1)} s`,
    rep.torsoLean == null ? '—' : `${Math.round(rep.torsoLean)}°`,
  ];
  for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
  const td = document.createElement('td');
  if (!notes.length) { td.textContent = 'Steady'; td.className = 'note-good'; }
  notes.forEach(([text, cls], i) => {
    const span = document.createElement('span');
    span.className = cls; span.textContent = (i ? ', ' : '') + text;
    td.appendChild(span);
  });
  tr.appendChild(td);
  els.repRows.appendChild(tr);
}

// ---------- Gemma ----------
function pickKeyframes() {
  // Two frames (first and deepest-looking last rep) keep Gemma fast.
  if (keyframes.length <= 2) return keyframes;
  return [keyframes[0], keyframes[keyframes.length - 1]];
}

let explaining = false;
async function explain() {
  if (explaining) return;
  explaining = true;
  els.explain.disabled = true;
  els.gemmaOut.hidden = false;
  els.gemmaOut.innerHTML = '';
  const waiting = document.createElement('p');
  waiting.className = 'muted';
  els.gemmaOut.appendChild(waiting);
  const t0 = performance.now();
  const tick = () => {
    const sec = Math.round((performance.now() - t0) / 1000);
    els.explain.textContent = `Gemma is reading your session… ${sec}s`;
    waiting.textContent = sec < 8
      ? 'Sending your measurements and rep frames to Gemma 4.'
      : 'Gemma is writing your coach notes. This usually takes 10–25 seconds.';
  };
  tick();
  const timer = setInterval(tick, 1000);
  try {
    const r = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: counter.summary(), images: pickKeyframes() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `Server returned ${r.status}`);
    renderExplanation(data);
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `Gemma could not explain this session: ${err.message}`;
    els.gemmaOut.appendChild(p);
  } finally {
    clearInterval(timer);
    waiting.remove();
    explaining = false;
    els.explain.disabled = false;
    els.explain.textContent = 'Explain again';
  }
}

function renderExplanation({ explanation, raw, model, imagesSent }) {
  const out = els.gemmaOut;
  const add = (tag, text, cls) => {
    const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; out.appendChild(n); return n;
  };
  if (!explanation) { add('p', raw || 'Empty response.'); return; }
  if (explanation.headline) add('h3', explanation.headline);
  if (explanation.summary) add('p', explanation.summary);
  const list = (title, items) => {
    if (!Array.isArray(items) || !items.length) return;
    add('h4', title);
    const ul = document.createElement('ul');
    items.forEach((i) => { const li = document.createElement('li'); li.textContent = i; ul.appendChild(li); });
    out.appendChild(ul);
  };
  list('What the numbers show', explanation.observations);
  list('Try next set', explanation.tips);
  if (explanation.caveats) add('p', explanation.caveats, 'caveat');
  add('p', `${model} · ${imagesSent} frame${imagesSent === 1 ? '' : 's'} analysed`, 'caveat');
}

// ---------- utils & wiring ----------
function once(target, ev) { return new Promise((res) => target.addEventListener(ev, res, { once: true })); }
function setStatus(msg, showEmpty = false) {
  els.status.textContent = msg;
  if (showEmpty) els.empty.hidden = false;
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(counter.summary(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hipermove-${counter.key}-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

els.exercise.addEventListener('change', () => { applyExercise(); resetSession(); });
els.file.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) startFile(f); e.target.value = ''; });
els.camera.addEventListener('click', startCamera);
els.stop.addEventListener('click', async () => { await stopAll(); finish(); });
els.explain.addEventListener('click', explain);
els.download.addEventListener('click', downloadJson);
window.addEventListener('resize', () => drawTrace(true));

applyExercise();
drawTrace(true);
setControls(false);
fetch('/api/health').then((r) => r.json()).then((h) => {
  els.modelTag.textContent = h.model;
  if (!h.gemmaConfigured) els.modelTag.title = 'GEMINI_API_KEY is not set on the server';
}).catch(() => {});

function setControls(ready) {
  els.camera.disabled = !ready;
  els.file.disabled = !ready;
  document.querySelector('label[for="file"]').toggleAttribute('aria-disabled', !ready);
}

initLandmarker()
  .then(() => { setControls(true); setStatus('Upload a clip or turn on the camera.'); })
  .catch((err) => { console.error(err); setStatus('The pose model failed to load. Check your connection and reload the page.'); });