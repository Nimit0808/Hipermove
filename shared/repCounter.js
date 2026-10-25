// HiperMove rep counting engine.
// Pure functions + a small state machine over MediaPipe Pose landmarks.
// Landmark indices: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker

export const EXERCISES = {
  squat: {
    label: 'Squat',
    metric: 'knee angle',
    // hip, knee, ankle
    joints: { left: [23, 25, 27], right: [24, 26, 28] },
    torso: { left: [11, 23], right: [12, 24] },
    down: 100,        // must go at or below this to count a rep
    up: 160,          // must return at or above this to finish a rep
    partialBelow: 140, // dipped below this but never reached `down` => partial rep
    cameraTip: 'Side view, full body in frame, phone at hip height.',
  },
  pushup: {
    label: 'Push-up',
    metric: 'elbow angle',
    joints: { left: [11, 13, 15], right: [12, 14, 16] },
    torso: null,
    down: 95,
    up: 155,
    partialBelow: 135,
    cameraTip: 'Side view at floor level, whole body in frame.',
  },
  curl: {
    label: 'Bicep curl',
    metric: 'elbow angle',
    joints: { left: [11, 13, 15], right: [12, 14, 16] },
    torso: { left: [11, 23], right: [12, 24] },
    down: 55,
    up: 145,
    partialBelow: 110,
    cameraTip: 'Side view of the working arm, upper body in frame.',
  },
};

const RAD = 180 / Math.PI;

/** Angle ABC in degrees. `aspect` = frameWidth / frameHeight (landmarks are normalised per axis). */
export function jointAngle(a, b, c, aspect = 1) {
  const v1x = (a.x - b.x) * aspect, v1y = a.y - b.y;
  const v2x = (c.x - b.x) * aspect, v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
  if (!m1 || !m2) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return Math.acos(cos) * RAD;
}

/** Torso lean from vertical in degrees (0 = upright). Image y grows downward. */
export function torsoLean(shoulder, hip, aspect = 1) {
  const dx = (shoulder.x - hip.x) * aspect;
  const dy = hip.y - shoulder.y;
  return Math.atan2(Math.abs(dx), dy) * RAD;
}

const vis = (p) => (p && typeof p.visibility === 'number' ? p.visibility : 1);

export class RepCounter {
  constructor(exerciseKey, { alpha = 0.35, minVisibility = 0.5 } = {}) {
    this.ex = EXERCISES[exerciseKey];
    if (!this.ex) throw new Error(`Unknown exercise: ${exerciseKey}`);
    this.key = exerciseKey;
    this.alpha = alpha;
    this.minVisibility = minVisibility;
    this.reset();
  }

  reset() {
    this.phase = 'waiting'; // waiting -> top -> descending -> bottom -> top ...
    this.smoothed = null;
    this.reps = [];
    this.partials = 0;
    this.lastTopT = null;
    this.repMin = Infinity;
    this.repMinT = null;
    this.leanAtMin = null;
    this.firstT = null;
    this.lastT = null;
    this.side = null;
  }

  pickSide(lm) {
    const score = (ids) => ids.reduce((s, i) => s + vis(lm[i]), 0) / ids.length;
    const l = score(this.ex.joints.left), r = score(this.ex.joints.right);
    const side = l >= r ? 'left' : 'right';
    return Math.max(l, r) >= this.minVisibility ? side : null;
  }

  /**
   * Feed one frame of landmarks.
   * @returns null if the pose is not usable, else { angle, raw, side, phase, newMin, events }
   */
  update(lm, tMs, aspect = 1) {
    if (!lm || lm.length < 29) return null;
    const side = this.pickSide(lm);
    if (!side) return null;
    this.side = side;

    const [ia, ib, ic] = this.ex.joints[side];
    const raw = jointAngle(lm[ia], lm[ib], lm[ic], aspect);
    if (!Number.isFinite(raw)) return null;

    this.smoothed = this.smoothed == null ? raw : this.alpha * raw + (1 - this.alpha) * this.smoothed;
    const angle = this.smoothed;
    if (this.firstT == null) this.firstT = tMs;
    this.lastT = tMs;

    let lean = null;
    if (this.ex.torso) {
      const [is, ih] = this.ex.torso[side];
      lean = torsoLean(lm[is], lm[ih], aspect);
    }

    const { down, up, partialBelow } = this.ex;
    const events = [];
    let newMin = false;

    const trackMin = () => {
      if (angle < this.repMin) {
        this.repMin = angle;
        this.repMinT = tMs;
        this.leanAtMin = lean;
        newMin = true;
      }
    };

    switch (this.phase) {
      case 'waiting':
        if (angle >= up) { this.phase = 'top'; this.lastTopT = tMs; }
        break;
      case 'top':
        if (angle >= up) this.lastTopT = tMs;
        else { this.phase = 'descending'; this.repMin = Infinity; trackMin(); }
        break;
      case 'descending':
        trackMin();
        if (angle <= down) this.phase = 'bottom';
        else if (angle >= up) {
          if (this.repMin <= partialBelow) {
            this.partials += 1;
            events.push({ type: 'partial', minAngle: round1(this.repMin) });
          }
          this.phase = 'top';
          this.lastTopT = tMs;
        }
        break;
      case 'bottom':
        trackMin();
        if (angle >= up) {
          const rep = {
            n: this.reps.length + 1,
            minAngle: round1(this.repMin),
            durationS: round2((tMs - this.lastTopT) / 1000),
            bottomAtS: round2(this.repMinT / 1000),
            endAtS: round2(tMs / 1000),
            torsoLean: this.leanAtMin == null ? null : round1(this.leanAtMin),
          };
          this.reps.push(rep);
          events.push({ type: 'rep', rep });
          this.phase = 'top';
          this.lastTopT = tMs;
        }
        break;
    }

    return { angle, raw, side, phase: this.phase, newMin, events, lean };
  }

  summary() {
    return summarize(this.key, this.reps, this.partials, this.firstT, this.lastT);
  }
}

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

export function summarize(key, reps, partials, firstT, lastT) {
  const ex = EXERCISES[key];
  const depths = reps.map((r) => r.minAngle);
  const tempos = reps.map((r) => r.durationS);
  const leans = reps.map((r) => r.torsoLean).filter((x) => x != null);
  return {
    exercise: ex.label,
    measuredJoint: ex.metric,
    thresholds: { countBelowDeg: ex.down, finishAboveDeg: ex.up },
    reps: reps.length,
    partialReps: partials,
    sessionSeconds: firstT == null ? 0 : round2((lastT - firstT) / 1000),
    avgMinAngleDeg: depths.length ? round1(mean(depths)) : null,
    deepestMinAngleDeg: depths.length ? round1(Math.min(...depths)) : null,
    shallowestMinAngleDeg: depths.length ? round1(Math.max(...depths)) : null,
    depthSpreadDeg: depths.length ? round1(std(depths)) : null,
    avgRepSeconds: tempos.length ? round2(mean(tempos)) : null,
    repSecondsStdDev: tempos.length ? round2(std(tempos)) : null,
    avgTorsoLeanDeg: leans.length ? round1(mean(leans)) : null,
    perRep: reps,
  };
}
