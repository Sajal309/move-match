export type Exercise = 'push_up' | 'pull_up';
export type RepState = 'NOT_READY' | 'TOP_READY' | 'DESCENDING' | 'BOTTOM_CONFIRMED' | 'ASCENDING'
  | 'TOP_CANDIDATE' | 'BOTTOM_CANDIDATE' | 'TOP_RETURN_CANDIDATE'
  | 'HANG_CANDIDATE' | 'HANG_READY' | 'PULLING_UP' | 'PULL_TOP_CANDIDATE' | 'TOP_CONFIRMED'
  | 'LOWERING' | 'HANG_RETURN_CANDIDATE';
export type Quality = 'ready' | 'low_confidence' | 'out_of_frame' | 'occluded' | 'camera_moved' | 'model_error';

export interface PosePoint {
  index: number;
  x: number;
  y: number;
  z: number;
  visibility: number;
  presence: number;
}

export interface PosePacket {
  timestampMs: number;
  width: number;
  height: number;
  rotationDegrees?: 0 | 90 | 180 | 270;
  inferenceMs: number;
  landmarks: PosePoint[];
}

export interface PullUpCalibration {
  barStart: { x: number; y: number };
  barEnd: { x: number; y: number };
  hangTorsoLengthPx: number;
  hangShoulderY: number;
  barY: number;
  calibratedAtMs: number;
}

export interface RepMachine {
  exercise: Exercise;
  state: RepState;
  count: number;
  lastTimestampMs: number;
  stateSinceMs: number;
  cycleStartedMs: number;
  sessionStartedMs: number;
  lastRepMs: number;
  smoothed: { elbow: number; body: number; shouldersY: number; mouthY: number; wristsY: number } | null;
  trackedSide: 'left' | 'right' | null;
  minElbowDeg: number;
  maxElbowDeg: number;
  minVisibility: number;
  quality: Quality;
  cue: string;
}

export interface RepStep {
  machine: RepMachine;
  repCompleted: boolean;
  rejectedReason?: string;
  observation?: LocalRepObservation;
}

export interface LocalRepObservation {
  cycleStartMs: number;
  cycleEndMs: number;
  minElbowDeg: number;
  maxElbowDeg: number;
  minimumRequiredVisibility: number;
  trackingGapMs: number;
}

export const RULE_VERSION = { push_up: 'push_up_v1', pull_up: 'pull_up_v1' } as const;
export const MODEL_VERSION = 'google-pose-landmarker-lite-float16';
const MIN_VISIBILITY = 0.7;

export function createRepMachine(exercise: Exercise): RepMachine {
  return {
    exercise,
    state: 'NOT_READY',
    count: 0,
    lastTimestampMs: -1,
    stateSinceMs: 0,
    cycleStartedMs: 0,
    sessionStartedMs: 0,
    lastRepMs: 0,
    smoothed: null,
    trackedSide: null,
    minElbowDeg: 180,
    maxElbowDeg: 0,
    minVisibility: 1,
    quality: 'out_of_frame',
    cue: exercise === 'push_up' ? 'Show your full side profile' : 'Keep the bar and both hands visible',
  };
}

function point(points: PosePoint[], index: number): PosePoint | undefined {
  'worklet';
  return points.find((entry) => entry.index === index);
}

function angleDegrees(a: PosePoint, b: PosePoint, c: PosePoint, width: number, height: number): number | null {
  'worklet';
  const abx = (a.x - b.x) * width;
  const aby = (a.y - b.y) * height;
  const cbx = (c.x - b.x) * width;
  const cby = (c.y - b.y) * height;
  const denominator = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!Number.isFinite(denominator) || denominator < 1e-6) return null;
  const cosine = Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / denominator));
  return Math.acos(cosine) * (180 / Math.PI);
}

function smooth(previous: number | undefined, current: number, deltaMs: number): number {
  'worklet';
  if (previous === undefined) return current;
  const alpha = 1 - Math.exp(-Math.max(1, deltaMs) / 100);
  return previous + alpha * (current - previous);
}

function invalidCycle(machine: RepMachine, timestampMs: number, reason: string): RepStep {
  'worklet';
  return {
    machine: {
      ...machine,
      state: 'NOT_READY',
      stateSinceMs: timestampMs,
      cycleStartedMs: 0,
      smoothed: null,
      trackedSide: null,
      minElbowDeg: 180,
      maxElbowDeg: 0,
      minVisibility: 1,
      quality: 'occluded',
      cue: reason,
    },
    repCompleted: false,
    rejectedReason: reason,
  };
}

export function stepRepMachine(
  machine: RepMachine,
  sample: PosePacket,
  pullUpCalibration?: PullUpCalibration,
  roundDurationMs?: number,
): RepStep {
  'worklet';
  const time = sample.timestampMs;
  if (!Number.isFinite(time) || time <= machine.lastTimestampMs) return { machine, repCompleted: false };
  if (roundDurationMs !== undefined && machine.sessionStartedMs > 0 && time - machine.sessionStartedMs >= roundDurationMs) {
    return { machine: { ...machine, state: 'NOT_READY', cycleStartedMs: 0, cue: 'Practice round complete' }, repCompleted: false };
  }
  const elapsed = machine.lastTimestampMs < 0 ? 0 : time - machine.lastTimestampMs;
  if (elapsed > 250) return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Tracking paused — get back in frame');
  if (sample.width < 1 || sample.height < 1 || sample.landmarks.length < 33) {
    return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Keep your whole body visible');
  }

  let elbow: number | null;
  let body: number | null = null;
  let shouldersY = 0;
  let mouthY = 0;
  let wristsY = 0;
  let required: PosePoint[];
  let trackedSide = machine.trackedSide;
  if (machine.exercise === 'push_up') {
    const left = [11, 13, 15, 23, 27].map((index) => point(sample.landmarks, index));
    const right = [12, 14, 16, 24, 28].map((index) => point(sample.landmarks, index));
    const confidence = (items: Array<PosePoint | undefined>) => items.length === 5 && items.every(Boolean)
      ? Math.min(...(items as PosePoint[]).map((item) => Math.min(item.visibility, item.presence))) : 0;
    const chooseLeft = trackedSide === 'left' || (trackedSide === null && confidence(left) >= confidence(right));
    const chosen = chooseLeft ? left : right;
    trackedSide = chooseLeft ? 'left' : 'right';
    required = chosen.filter(Boolean) as PosePoint[];
    if (required.length !== 5 || confidence(chosen) < MIN_VISIBILITY) {
      return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Keep one complete side profile visible');
    }
    const [shoulder, elbowPoint, wrist, hip, ankle] = required;
    elbow = angleDegrees(shoulder, elbowPoint, wrist, sample.width, sample.height);
    body = angleDegrees(shoulder, hip, ankle, sample.width, sample.height);
  } else {
    const leftShoulder = point(sample.landmarks, 11);
    const rightShoulder = point(sample.landmarks, 12);
    const leftElbow = point(sample.landmarks, 13);
    const rightElbow = point(sample.landmarks, 14);
    const leftWrist = point(sample.landmarks, 15);
    const rightWrist = point(sample.landmarks, 16);
    const leftHip = point(sample.landmarks, 23);
    const rightHip = point(sample.landmarks, 24);
    const mouthLeft = point(sample.landmarks, 9);
    const mouthRight = point(sample.landmarks, 10);
    const feet = [point(sample.landmarks, 27), point(sample.landmarks, 28)];
    required = [leftShoulder, rightShoulder, leftElbow, rightElbow, leftWrist, rightWrist,
      leftHip, rightHip, mouthLeft, mouthRight, ...feet].filter(Boolean) as PosePoint[];
    if (!pullUpCalibration || required.length !== 12) {
      return invalidCycle({ ...machine, lastTimestampMs: time }, time,
        pullUpCalibration ? 'Show both arms, feet and the bar' : 'Place the bar line to calibrate');
    }
    const leftAngle = angleDegrees(leftShoulder!, leftElbow!, leftWrist!, sample.width, sample.height);
    const rightAngle = angleDegrees(rightShoulder!, rightElbow!, rightWrist!, sample.width, sample.height);
    if (leftAngle === null || rightAngle === null) return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Bring both arms into view');
    elbow = Math.min(leftAngle, rightAngle);
    shouldersY = ((leftShoulder!.y + rightShoulder!.y) / 2) * sample.height;
    mouthY = ((mouthLeft!.y + mouthRight!.y) / 2) * sample.height;
    wristsY = ((leftWrist!.y + rightWrist!.y) / 2) * sample.height;
    body = 180;
  }

  if (elbow === null || body === null) return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Move into a clear position');
  const visibility = Math.min(...required.map((item) => Math.min(item.visibility, item.presence)));
  if (visibility < MIN_VISIBILITY) return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'More light needed — keep key joints visible');

  const nextElbow = smooth(machine.smoothed?.elbow, elbow, elapsed);
  const nextBody = smooth(machine.smoothed?.body, body, elapsed);
  const nextShouldersY = smooth(machine.smoothed?.shouldersY, shouldersY, elapsed);
  const nextMouthY = smooth(machine.smoothed?.mouthY, mouthY, elapsed);
  const nextWristsY = smooth(machine.smoothed?.wristsY, wristsY, elapsed);
  let state = machine.state;
  let stateSince = machine.stateSinceMs || time;
  let cycleStarted = machine.cycleStartedMs;
  let repCompleted = false;
  let cue = machine.cue;
  let minElbow = Math.min(machine.minElbowDeg, nextElbow);
  let maxElbow = Math.max(machine.maxElbowDeg, nextElbow);
  let lastRepMs = machine.lastRepMs;
  let observation: LocalRepObservation | undefined;
  let cycleMinVisibility = Math.min(machine.minVisibility, visibility);

  if (machine.exercise === 'push_up') {
    const atTop = nextElbow >= 155 && nextBody >= 160;
    const atBottom = nextElbow <= 95 && nextBody >= 155;
    if (state === 'NOT_READY' && atTop) { state = 'TOP_CANDIDATE'; stateSince = time; cue = 'Hold a straight body line'; }
    else if (state === 'TOP_CANDIDATE' && !atTop) { state = 'NOT_READY'; stateSince = time; cue = 'Start from a steady straight-arm position'; }
    else if (state === 'TOP_CANDIDATE' && atTop && time - stateSince >= 150) { state = 'TOP_READY'; stateSince = time; cue = 'Lower with control'; }
    else if (state === 'TOP_READY' && !atTop) { state = 'DESCENDING'; stateSince = time; cycleStarted = time; minElbow = nextElbow; maxElbow = nextElbow; cycleMinVisibility = visibility; }
    else if (state === 'DESCENDING' && atBottom) { state = 'BOTTOM_CANDIDATE'; stateSince = time; }
    else if (state === 'BOTTOM_CANDIDATE' && !atBottom) { state = 'DESCENDING'; stateSince = time; }
    else if (state === 'BOTTOM_CANDIDATE' && atBottom && time - stateSince >= 120) { state = 'BOTTOM_CONFIRMED'; stateSince = time; cue = 'Press back to a straight body'; }
    else if (state === 'BOTTOM_CONFIRMED' && !atBottom) { state = 'ASCENDING'; stateSince = time; }
    else if (state === 'ASCENDING' && atTop) { state = 'TOP_RETURN_CANDIDATE'; stateSince = time; }
    else if (state === 'TOP_RETURN_CANDIDATE' && !atTop) { state = 'ASCENDING'; stateSince = time; }
    else if (state === 'TOP_RETURN_CANDIDATE' && atTop && time - stateSince >= 150) {
      if (cycleStarted > 0 && time - cycleStarted >= 600) {
        repCompleted = true;
        lastRepMs = time;
        observation = { cycleStartMs: cycleStarted - (machine.sessionStartedMs || time), cycleEndMs: time - (machine.sessionStartedMs || time),
          minElbowDeg: minElbow, maxElbowDeg: maxElbow, minimumRequiredVisibility: cycleMinVisibility, trackingGapMs: 0 };
        state = 'TOP_READY';
        cue = 'Nice. Keep a steady pace';
      } else {
        state = 'TOP_READY';
        cue = 'Use a slower full range';
      }
      stateSince = time;
      cycleStarted = 0;
      minElbow = 180;
      maxElbow = 0;
    }
    if (state === 'TOP_READY' && machine.lastRepMs > 0 && time - machine.lastRepMs > 10_000) {
      state = 'TOP_READY';
      cue = 'Ready when you are';
    }
  } else {
    const calibration = pullUpCalibration;
    if (!calibration) return invalidCycle({ ...machine, lastTimestampMs: time }, time, 'Place the bar line to calibrate');
    const wrists = [point(sample.landmarks, 15)!, point(sample.landmarks, 16)!];
    const lineDistance = (wrist: PosePoint) => distanceToSegment(
      wrist.x * sample.width, wrist.y * sample.height,
      calibration.barStart.x * sample.width, calibration.barStart.y * sample.height,
      calibration.barEnd.x * sample.width, calibration.barEnd.y * sample.height,
    );
    const handsNearBar = wrists.every((wrist) => lineDistance(wrist) <= calibration.hangTorsoLengthPx * 0.22);
    const atHang = nextElbow >= 155 && nextShouldersY > nextWristsY && handsNearBar;
    const torsoLength = calibration.hangTorsoLengthPx;
    const barY = calibration.barY;
    const atTop = nextElbow <= 80 &&
      calibration.hangShoulderY - nextShouldersY >= torsoLength * 0.25 &&
      nextMouthY < barY;
    if (state === 'NOT_READY' && atHang) { state = 'HANG_CANDIDATE'; stateSince = time; cue = 'Settle into a full hang'; }
    else if (state === 'HANG_CANDIDATE' && !atHang) { state = 'NOT_READY'; stateSince = time; cue = 'Show a full hang with both hands near the bar'; }
    else if (state === 'HANG_CANDIDATE' && atHang && time - stateSince >= 200) { state = 'HANG_READY'; stateSince = time; cue = 'Pull until your mouth clears the bar line'; }
    else if (state === 'HANG_READY' && !atHang) { state = 'PULLING_UP'; stateSince = time; cycleStarted = time; cycleMinVisibility = visibility; }
    else if (state === 'PULLING_UP' && atTop) { state = 'PULL_TOP_CANDIDATE'; stateSince = time; }
    else if (state === 'PULL_TOP_CANDIDATE' && !atTop) { state = 'PULLING_UP'; stateSince = time; }
    else if (state === 'PULL_TOP_CANDIDATE' && atTop && time - stateSince >= 120) { state = 'TOP_CONFIRMED'; stateSince = time; cue = 'Lower to a full hang'; }
    else if (state === 'TOP_CONFIRMED' && !atTop) { state = 'LOWERING'; stateSince = time; }
    else if (state === 'LOWERING' && atHang) { state = 'HANG_RETURN_CANDIDATE'; stateSince = time; }
    else if (state === 'HANG_RETURN_CANDIDATE' && !atHang) { state = 'LOWERING'; stateSince = time; }
    else if (state === 'HANG_RETURN_CANDIDATE' && atHang && time - stateSince >= 200) {
      if (cycleStarted > 0 && time - cycleStarted >= 900) {
        repCompleted = true;
        lastRepMs = time;
        observation = { cycleStartMs: cycleStarted - (machine.sessionStartedMs || time), cycleEndMs: time - (machine.sessionStartedMs || time),
          minElbowDeg: minElbow, maxElbowDeg: maxElbow, minimumRequiredVisibility: cycleMinVisibility, trackingGapMs: 0 };
        cue = 'Good rep. Return to a full hang';
      } else cue = 'Use a controlled full range';
      state = 'HANG_READY';
      stateSince = time;
      cycleStarted = 0;
      minElbow = 180;
      maxElbow = 0;
    }
  }

  if (cycleStarted > 0 && time - cycleStarted > (machine.exercise === 'push_up' ? 10_000 : 15_000)) {
    state = 'NOT_READY';
    stateSince = time;
    cycleStarted = 0;
    cue = machine.exercise === 'push_up' ? 'Return to the top position' : 'Reset to a full hang';
  }

  const updated: RepMachine = {
    ...machine,
    state,
    count: machine.count + (repCompleted ? 1 : 0),
    lastTimestampMs: time,
    stateSinceMs: stateSince,
    cycleStartedMs: cycleStarted,
    sessionStartedMs: machine.sessionStartedMs || time,
    lastRepMs,
    smoothed: { elbow: nextElbow, body: nextBody, shouldersY: nextShouldersY, mouthY: nextMouthY, wristsY: nextWristsY },
    trackedSide,
    minElbowDeg: minElbow,
    maxElbowDeg: maxElbow,
    minVisibility: repCompleted ? 1 : cycleStarted > 0 ? Math.min(cycleMinVisibility, visibility) : Math.min(machine.minVisibility, visibility),
    quality: 'ready',
    cue,
  };
  return { machine: updated, repCompleted, observation };
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  'worklet';
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-6) return Number.POSITIVE_INFINITY;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
