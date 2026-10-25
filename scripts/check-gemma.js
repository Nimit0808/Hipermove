// Sends a realistic squat session to the running server and checks Gemma's reply.
// Usage: node scripts/check-gemma.js   (server must be running)
const PORT = process.env.PORT || 3000;
const base = `http://localhost:${PORT}`;

const summary = {
  exercise: 'Squat', measuredJoint: 'knee angle',
  thresholds: { countBelowDeg: 100, finishAboveDeg: 160 },
  reps: 5, partialReps: 1, sessionSeconds: 14.2,
  avgMinAngleDeg: 94.6, deepestMinAngleDeg: 82.1, shallowestMinAngleDeg: 99.3,
  depthSpreadDeg: 6.8, avgRepSeconds: 2.1, repSecondsStdDev: 0.4, avgTorsoLeanDeg: 38.5,
  perRep: [],
};

try {
  const h = await (await fetch(`${base}/api/health`)).json();
  console.log('Health:', h);
  if (!h.gemmaConfigured) { console.error('\nFAIL: GEMINI_API_KEY missing in .env'); process.exit(1); }
  console.log('\nAsking Gemma (can take 10-30 s)...');
  const r = await fetch(`${base}/api/explain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, images: [] }),
  });
  const d = await r.json();
  if (!r.ok) { console.error('\nFAIL:', d.error); process.exit(1); }
  if (!d.explanation) {
    console.error('\nFAIL: Gemma replied but not in JSON. Raw reply:\n', d.raw || '(empty)');
    if (d.debug) console.error('\nDebug info (send this to Claude):\n', JSON.stringify(d.debug, null, 2));
    process.exit(1);
  }
  console.log('\nPASS. Gemma says:\n', JSON.stringify(d.explanation, null, 2));
} catch (e) {
  console.error('\nFAIL: server not reachable. Is "npm start" running in another window?', e.message);
  process.exit(1);
}
