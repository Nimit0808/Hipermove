import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
const API_KEY = process.env.GEMINI_API_KEY;

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shared', express.static(path.join(__dirname, 'shared')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: MODEL, gemmaConfigured: Boolean(API_KEY) });
});

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_500_000;

function buildPrompt(summary, imageCount) {
  // Facts decided in code so Gemma cannot misjudge them.
  const facts = [];
  if (summary.exercise === 'Squat' && typeof summary.avgTorsoLeanDeg === 'number') {
    facts.push(summary.avgTorsoLeanDeg <= 45
      ? `Torso lean of ${summary.avgTorsoLeanDeg} degrees is NORMAL for a squat (20-45 is typical, lower is very upright). Do NOT tell the user to lift their chest or reduce lean; you may praise their upright torso.`
      : `Torso lean of ${summary.avgTorsoLeanDeg} degrees is high for a squat. One tip may suggest a more upright chest.`);
  }
  if (summary.exercise === 'Bicep curl') {
    facts.push('For curls, a smaller elbow angle means a stronger squeeze at the top. Say "squeeze" or "range of motion", never "depth".');
  }
  facts.push('avgMinAngleDeg is the average of each rep\'s LOWEST angle; call it "average lowest angle", not "average angle".');
  if (summary.partialReps > 0) {
    facts.push(`There were ${summary.partialReps} partial rep(s) that went down part way but did not reach the ${summary.thresholds?.countBelowDeg} degree target, so they were not counted. You MUST mention them in "observations" and give one tip in "tips" on turning them into full reps.`);
  }
  if (summary.reps < 3) {
    facts.push(`Only ${summary.reps} full rep(s) were counted. Do not describe the set as consistent or steady; suggest doing more reps for a better analysis.`);
  }

  return `You are the explanation layer of HiperMove, an exercise movement assistant.

The numbers below were MEASURED by MediaPipe Pose from a single 2D phone video. They are approximate.
Rules:
- Use the measured numbers as given. Never invent or alter measurements.
- Joint angles: 180 degrees means the joint is straight; smaller means more bent. For a squat, a smaller minimum knee angle means a deeper squat. For push-ups and curls the elbow angle works the same way.
- Torso lean is degrees away from vertical (0 = upright).
- ${imageCount > 0 ? `You also get ${imageCount} image(s): the bottom position of selected reps with the detected skeleton drawn on top; the yellow lines mark the measured joint. Comment only on what is clearly visible.` : 'No images were provided.'}
- Do not diagnose injuries, medical or musculoskeletal conditions. No medical advice. Speak like a friendly coach.
- Mention that camera angle and 2D tracking limit accuracy.
${facts.length ? `\nFacts already assessed (follow these exactly):\n${facts.map((f) => `- ${f}`).join('\n')}\n` : ''}
Measured session (JSON):
${JSON.stringify(summary, null, 2)}

Respond with ONLY a JSON object, no markdown fences, in this exact shape:
{
  "headline": "one short sentence verdict",
  "summary": "2-3 plain-language sentences about the session",
  "observations": ["up to 4 short points, each tied to a measured number or a visible detail"],
  "tips": ["up to 3 short, actionable coaching cues"],
  "caveats": "one sentence on measurement limits"
}`;
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

app.post('/api/explain', async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY is not set on the server. Add it to .env and restart.' });
  }
  const { summary, images = [] } = req.body || {};
  if (!summary || typeof summary !== 'object' || typeof summary.reps !== 'number') {
    return res.status(400).json({ error: 'Request needs a session summary. Analyse a clip first.' });
  }

  const imageParts = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(img || '');
    if (!m || m[1].length * 0.75 > MAX_IMAGE_BYTES) continue;
    imageParts.push({ inlineData: { mimeType: 'image/jpeg', data: m[1] } });
  }

  const prompt = buildPrompt(summary, imageParts.length);

  try {
    // Thinking off ("minimal") makes Gemma 4 answer much faster; the numbers are already measured.
    let result = await callGemma(prompt, imageParts, 1024, 'minimal');
    if (result.error && /thinking/i.test(result.error)) {
      console.warn('thinkingLevel not accepted, retrying with default settings');
      result = await callGemma(prompt, imageParts, 4096, null);
    }
    if (!result.error && !result.text.trim()) {
      console.warn(`Empty Gemma reply (finishReason=${result.finishReason}), retrying with a larger limit`);
      result = await callGemma(prompt, imageParts, 4096, null);
    }
    if (!result.error && !result.text.trim() && imageParts.length) {
      console.warn('Still empty, retrying without images');
      result = await callGemma(buildPrompt(summary, 0), [], 4096, null);
    }
    if (result.error) return res.status(502).json({ error: result.error });

    const parsed = extractJson(result.text);
    res.json({
      model: MODEL,
      imagesSent: imageParts.length,
      finishReason: result.finishReason,
      explanation: parsed,
      raw: parsed ? undefined : result.text,
      debug: result.text.trim() ? undefined : result.debug,
    });
  } catch (err) {
    console.error(err);
    const msg = err.name === 'TimeoutError' ? 'Gemma took longer than 90 s. Try again.' : `Could not reach the Gemma API: ${err.message}`;
    res.status(504).json({ error: msg });
  }
});

async function callGemma(prompt, imageParts, maxOutputTokens, thinkingLevel) {
  const t0 = Date.now();
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens,
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    },
  );
  const data = await r.json();
  if (!r.ok) {
    console.error('Gemma API error', r.status, JSON.stringify(data).slice(0, 500));
    return { text: '', error: data?.error?.message || `Gemma API returned ${r.status}` };
  }
  console.log(`Gemma call: ${((Date.now() - t0) / 1000).toFixed(1)} s, thinking=${thinkingLevel || 'default'}, ${imageParts.length} image(s), output tokens ${data?.usageMetadata?.candidatesTokenCount ?? '?'}, thinking tokens ${data?.usageMetadata?.thoughtsTokenCount ?? 0}`);
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('\n');
  const debug = {
    finishReason: cand?.finishReason,
    blockReason: data?.promptFeedback?.blockReason,
    partKinds: parts.map((p) => (p.thought ? 'thought' : Object.keys(p).join('+'))),
    usage: data?.usageMetadata,
  };
  if (!text.trim()) console.warn('Gemma returned no answer text:', JSON.stringify(debug));
  return { text, finishReason: cand?.finishReason, debug };
}

app.listen(PORT, () => {
  console.log(`HiperMove running on http://localhost:${PORT}  (model: ${MODEL}, key ${API_KEY ? 'set' : 'MISSING'})`);
});