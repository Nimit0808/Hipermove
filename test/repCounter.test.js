import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RepCounter, jointAngle, torsoLean } from '../shared/repCounter.js';

// Build a 33-landmark pose where the left knee angle equals `deg`.
function poseWithKneeAngle(deg, noise = 0) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }));
  const hip = { x: 0.5, y: 0.4, visibility: 0.95 };
  const knee = { x: 0.5, y: 0.6, visibility: 0.95 };
  const t = ((deg + noise) * Math.PI) / 180; // rotate ankle around knee
  const ankle = { x: knee.x + 0.2 * Math.sin(t), y: knee.y - 0.2 * Math.cos(t), visibility: 0.95 };
  lm[23] = hip; lm[25] = knee; lm[27] = ankle;
  lm[11] = { x: 0.52, y: 0.15, visibility: 0.95 };
  return lm;
}

function* trajectory(segments, fps = 30) {
  let t = 0;
  for (const [from, to, seconds] of segments) {
    const n = Math.round(seconds * fps);
    for (let i = 0; i < n; i++) {
      yield [from + ((to - from) * i) / n, t];
      t += 1000 / fps;
    }
  }
}

test('jointAngle basics', () => {
  assert.equal(Math.round(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })), 90);
  assert.equal(Math.round(jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 })), 180);
  assert.equal(Math.round(torsoLean({ x: 0.5, y: 0 }, { x: 0.5, y: 1 })), 0);
});

test('counts full squats, flags partials, ignores noise', () => {
  const c = new RepCounter('squat');
  const segs = [
    [175, 175, 1],
    [175, 85, 1], [85, 175, 1],   // rep 1
    [175, 92, 0.8], [92, 175, 0.8], // rep 2
    [175, 125, 0.7], [125, 175, 0.7], // partial
    [175, 70, 1.2], [70, 175, 1.2], // rep 3
    [175, 168, 0.3], [168, 175, 0.3], // wobble at the top, should not count
    [175, 175, 0.5],
  ];
  let i = 0;
  for (const [deg, t] of trajectory(segs)) {
    const jitter = Math.sin(i++ * 1.7) * 2; // +-2 deg tracking noise
    c.update(poseWithKneeAngle(deg, jitter), t, 1);
  }
  const s = c.summary();
  assert.equal(s.reps, 3);
  assert.equal(s.partialReps, 1);
  assert.ok(s.deepestMinAngleDeg < 80, `deepest ${s.deepestMinAngleDeg}`);
  assert.ok(s.avgRepSeconds > 1.4 && s.avgRepSeconds < 2.8, `tempo ${s.avgRepSeconds}`);
});

test('low visibility frames are ignored', () => {
  const c = new RepCounter('squat');
  const lm = poseWithKneeAngle(90);
  for (const i of [23, 25, 27]) lm[i].visibility = 0.1;
  assert.equal(c.update(lm, 0), null);
});
