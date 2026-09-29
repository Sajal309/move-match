import React, { useCallback, useEffect, useRef, useState } from 'react';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { AppState, StyleSheet, View } from 'react-native';
import { getPoseLandmarker } from '@move-match/pose-tracker';
import { RULE_VERSION } from '@move-match/rep-engine';
import type { Exercise, PosePacket, PosePoint, PullUpCalibration } from '@move-match/rep-engine';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { PoseCamera } from '../src/PoseCamera';
import { MovementArt } from '../src/MovementArt';
import { useAppTheme } from '../src/theme';

type CalibrationStep = 'bar_start' | 'bar_end' | 'hang' | 'top' | 'complete';

function find(points: PosePoint[], index: number) { return points.find((item) => item.index === index); }
function angle(a: PosePoint, b: PosePoint, c: PosePoint, width: number, height: number) {
  const ux = (a.x - b.x) * width, uy = (a.y - b.y) * height;
  const vx = (c.x - b.x) * width, vy = (c.y - b.y) * height;
  const denominator = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (denominator < 1) return null;
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / denominator))) * 180 / Math.PI;
}

export default function SetupScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; mode?: string; matchId?: string; sessionNonce?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const [facing, setFacing] = useState<'front' | 'back'>(exercise === 'pull_up' ? 'back' : 'front');
  const [packet, setPacket] = useState<PosePacket | null>(null);
  const latest = useRef<PosePacket | null>(null);
  const validSince = useRef<number | null>(null);
  const lastValid = useRef(0);
  const [clock, setClock] = useState(() => performance.now());
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelError, setModelError] = useState('');
  const [quality, setQuality] = useState('Move into frame so we can check your setup');
  const [barPoints, setBarPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [step, setStep] = useState<CalibrationStep>('bar_start');
  const [calibration, setCalibration] = useState<PullUpCalibration | null>(null);
  const [topCheck, setTopCheck] = useState('');
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState(AppState.currentState);

  useEffect(() => {
    const id = setInterval(() => setClock(performance.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      try {
        const diagnostics = JSON.parse(getPoseLandmarker().diagnostics()) as { modelLoaded?: boolean; lastError?: string };
        setModelLoaded(Boolean(diagnostics.modelLoaded));
        setModelError(diagnostics.modelLoaded ? '' : diagnostics.lastError ?? 'The pose model is still loading');
      } catch {
        setModelLoaded(false);
        setModelError('Pose tracker native module is unavailable. Rebuild the development app after installing dependencies.');
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  const onPacket = useCallback((json: string) => {
    let next: PosePacket;
    try { next = JSON.parse(json) as PosePacket; } catch { return; }
    latest.current = next;
    setPacket(next);
    const indices = exercise === 'push_up' ? [11, 13, 15, 23, 27] : [11, 12, 13, 14, 15, 16, 23, 24, 9, 10, 27, 28];
    const joints = indices.map((index) => find(next.landmarks, index));
    if (joints.some((item) => !item)) {
      validSince.current = null;
      setQuality('Move farther back and keep your whole body visible');
      return;
    }
    const values = joints as PosePoint[];
    const low = Math.min(...values.map((item) => Math.min(item.visibility, item.presence)));
    if (low < 0.7) {
      validSince.current = null;
      setQuality('More light needed — keep key joints visible');
      return;
    }
    if (values.some((item) => item.x < 0.015 || item.x > 0.985 || item.y < 0.015 || item.y > 0.985)) {
      validSince.current = null;
      setQuality('Keep your whole body visible inside the frame');
      return;
    }
    const now = performance.now();
    if (now - lastValid.current > 650) validSince.current = now;
    if (validSince.current === null) validSince.current = now;
    lastValid.current = now;
    setQuality(exercise === 'push_up' ? 'Good framing — turn to a side view' : 'Good framing — use the bar calibration below');
  }, [exercise]);

  useEffect(() => {
    if (!packet || clock - lastValid.current > 900) {
      validSince.current = null;
      setQuality((current) => current.startsWith('Good framing') ? 'Tracking paused — return to the camera view' : current);
    }
  }, [clock, packet]);

  const readyDuration = validSince.current === null ? 0 : performance.now() - validSince.current;
  const bodyReady = modelLoaded && readyDuration >= 2_000 && clock - lastValid.current < 900;
  const pullUpReady = exercise !== 'pull_up' || (calibration !== null && Date.now() - calibration.calibratedAtMs <= 60_000);
  const canStart = bodyReady && pullUpReady;

  const onPreviewTap = useCallback((point: { x: number; y: number }) => {
    if (exercise !== 'pull_up' || (step !== 'bar_start' && step !== 'bar_end')) return;
    if (barPoints.length === 0) {
      setBarPoints([point]);
      setStep('bar_end');
      setTopCheck('Tap the other end of the same visible bar');
      return;
    }
    const first = barPoints[0];
    if (Math.abs(first.y - point.y) > 0.08) {
      setBarPoints([]);
      setStep('bar_start');
      setTopCheck('Those points are too far apart vertically. Mark two points along the bar.');
      return;
    }
    setBarPoints([first, point]);
    setStep('hang');
    setTopCheck('Bar line set. Demonstrate a stable full hang next.');
  }, [barPoints, exercise, step]);

  const captureHang = () => {
    const current = latest.current;
    if (!current) return setTopCheck('Wait for the pose overlay before capturing a hang');
    const shoulderL = find(current.landmarks, 11), shoulderR = find(current.landmarks, 12);
    const elbowL = find(current.landmarks, 13), elbowR = find(current.landmarks, 14);
    const wristL = find(current.landmarks, 15), wristR = find(current.landmarks, 16);
    const hipL = find(current.landmarks, 23), hipR = find(current.landmarks, 24);
    if (!shoulderL || !shoulderR || !elbowL || !elbowR || !wristL || !wristR || !hipL || !hipR ||
      Math.min(...[shoulderL, shoulderR, elbowL, elbowR, wristL, wristR, hipL, hipR].map((p) => p.visibility)) < 0.7) {
      return setTopCheck('Keep both shoulders, elbows, wrists and hips visible');
    }
    const leftAngle = angle(shoulderL, elbowL, wristL, current.width, current.height);
    const rightAngle = angle(shoulderR, elbowR, wristR, current.width, current.height);
    const shoulderX = (shoulderL.x + shoulderR.x) / 2, shoulderY = (shoulderL.y + shoulderR.y) / 2;
    const hipX = (hipL.x + hipR.x) / 2, hipY = (hipL.y + hipR.y) / 2;
    const torsoLength = Math.hypot((shoulderX - hipX) * current.width, (shoulderY - hipY) * current.height);
    if (leftAngle === null || rightAngle === null || Math.min(leftAngle, rightAngle) < 145 || torsoLength < 10) {
      return setTopCheck('Show a straight-arm full hang with your shoulders below your wrists');
    }
    setCalibration({
      barStart: barPoints[0], barEnd: barPoints[1], hangTorsoLengthPx: torsoLength,
      hangShoulderY: shoulderY * current.height,
      barY: ((barPoints[0].y + barPoints[1].y) / 2) * current.height,
      calibratedAtMs: Date.now(),
    });
    setStep('top');
    setTopCheck('Now demonstrate the top position: elbows bent and mouth proxy above your bar line');
  };

  const confirmTop = () => {
    const current = latest.current;
    if (!current || !calibration) return setTopCheck('Capture a full hang first');
    const shoulderL = find(current.landmarks, 11), shoulderR = find(current.landmarks, 12);
    const elbowL = find(current.landmarks, 13), elbowR = find(current.landmarks, 14);
    const wristL = find(current.landmarks, 15), wristR = find(current.landmarks, 16);
    const mouthL = find(current.landmarks, 9), mouthR = find(current.landmarks, 10);
    if (!shoulderL || !shoulderR || !elbowL || !elbowR || !wristL || !wristR || !mouthL || !mouthR) {
      return setTopCheck('Keep your mouth, both shoulders and arms in view');
    }
    const leftAngle = angle(shoulderL, elbowL, wristL, current.width, current.height);
    const rightAngle = angle(shoulderR, elbowR, wristR, current.width, current.height);
    const shoulderY = ((shoulderL.y + shoulderR.y) / 2) * current.height;
    const mouthY = ((mouthL.y + mouthR.y) / 2) * current.height;
    const enoughRise = calibration.hangShoulderY - shoulderY >= calibration.hangTorsoLengthPx * 0.25;
    if (leftAngle === null || rightAngle === null || Math.max(leftAngle, rightAngle) > 100 || !enoughRise || mouthY >= calibration.barY) {
      return setTopCheck('Show a higher top position. MOVE / MATCH uses an approximate mouth proxy and manual bar line.');
    }
    const complete = { ...calibration, calibratedAtMs: Date.now() };
    setCalibration(complete);
    setStep('complete');
    setTopCheck('Bar calibration complete. Reconfirm within 60 seconds before starting.');
  };

  const beginPractice = () => {
    if (!canStart) return;
    if (params.mode === 'friend_host') {
      router.push({ pathname: '/friend-invite', params: { exercise, calibration: calibration ? JSON.stringify(calibration) : '',
        facing, setupConfirmedAtMs: String(Date.now()) } });
      return;
    }
    if ((params.mode === 'friend_guest' || params.mode === 'friend_existing' || params.mode === 'ranked_existing') && params.matchId && params.sessionNonce) {
      router.push({ pathname: '/match', params: { exercise, matchId: params.matchId, sessionNonce: params.sessionNonce,
        calibration: calibration ? JSON.stringify(calibration) : '', mode: params.mode === 'ranked_existing' ? 'ranked' : 'friend',
        facing, setupConfirmedAtMs: String(Date.now()) } });
      return;
    }
    if (params.mode === 'ranked') {
      router.push({ pathname: '/queue', params: { exercise, facing, calibration: calibration ? JSON.stringify(calibration) : '', setupConfirmedAtMs: String(Date.now()) } });
      return;
    }
    router.push({ pathname: '/practice', params: {
      exercise,
      facing,
      calibration: calibration ? JSON.stringify(calibration) : '',
      ruleVersion: RULE_VERSION[exercise],
    } });
  };

  const switchCamera = () => {
    setFacing((current) => current === 'front' ? 'back' : 'front');
    validSince.current = null;
    lastValid.current = 0;
    setQuality('Camera changed. Recheck your full framing before starting.');
    if (exercise === 'pull_up') {
      setBarPoints([]);
      setCalibration(null);
      setStep('bar_start');
      setTopCheck('Camera changed. Please calibrate the visible bar again.');
    }
  };

  return <Page>
    <View style={styles.heading}>
      <Eyebrow>CAMERA SETUP · APP-STANDARD {exercise === 'push_up' ? 'PUSH-UPS' : 'PULL-UPS'}</Eyebrow>
      <TextBlock variant="title">Let’s get your frame ready.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>{exercise === 'push_up'
        ? 'Set the phone down securely. Use a side view with your full body and the visible-side shoulder, elbow, wrist, hip and ankle in frame.'
        : 'Use a stable, safely installed bar. Keep the bar, hands, head, torso and feet visible. MOVE / MATCH does not verify grip or physical chin clearance.'}</TextBlock>
    </View>
    <PoseCamera facing={facing} active={isFocused && appState === 'active'} exercise={exercise} onPacket={onPacket}
      onPreviewTap={exercise === 'pull_up' && (step === 'bar_start' || step === 'bar_end') ? onPreviewTap : undefined} />
    <View style={styles.qualityRow}>
      <View style={[styles.dot, { backgroundColor: modelError ? theme.danger : canStart ? theme.primary : theme.warning }]} />
      <View style={{ flex: 1, gap: 3 }}>
        <TextBlock variant="label">{modelError ? 'Pose model unavailable' : modelLoaded ? (canStart ? 'Camera ready' : 'Checking camera setup') : 'Loading pose model'}</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>{modelError || quality}</TextBlock>
      </View>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>{packet ? `${packet.inferenceMs.toFixed(0)} ms` : '--'}</TextBlock>
    </View>
    {exercise === 'pull_up' ? <Card style={{ gap: 12 }}>
      <View style={styles.calibrationHeading}><MovementArt exercise="pull_up" /><View style={{ flex: 1, gap: 4 }}>
        <TextBlock variant="section">Bar calibration</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>This local setup is used only for this session.</TextBlock></View></View>
      <TextBlock variant="label">{step === 'bar_start' ? '1. Tap one end of the visible bar in the camera preview.'
        : step === 'bar_end' ? '2. Tap the other end of the same bar.'
          : step === 'hang' ? '3. Settle into a straight-arm full hang, then capture it.'
            : step === 'top' ? '4. Demonstrate the top position, then confirm it.'
              : 'Calibration complete. The bar line expires after 60 seconds.'}</TextBlock>
      {topCheck ? <TextBlock variant="caption" style={{ color: theme.secondary }}>{topCheck}</TextBlock> : null}
      {step === 'hang' ? <ActionButton title="Capture full hang" tone="secondary" onPress={captureHang} /> : null}
      {step === 'top' ? <ActionButton title="Confirm top position" tone="secondary" onPress={confirmTop} /> : null}
      {step === 'complete' ? <ActionButton title="Recalibrate bar" tone="quiet" onPress={() => { setStep('bar_start'); setBarPoints([]); setCalibration(null); }} /> : null}
    </Card> : <Card style={styles.guide}>
      <MovementArt exercise="push_up" />
      <View style={{ flex: 1, gap: 4 }}><TextBlock variant="label">Push-up setup guide</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>Keep a straight body line. Partial cycles and incomplete tracking won’t count.</TextBlock></View>
    </Card>}
    <ActionButton title="Switch camera" tone="quiet" onPress={switchCamera} />
    <ActionButton title={params.mode === 'friend_host' ? 'Create friend invite' : params.mode === 'friend_guest' ? 'Open friend lobby'
      : params.mode === 'ranked' ? 'Continue to quick match' : 'Start 45-second practice'} disabled={!canStart} onPress={beginPractice} />
    {!modelLoaded && modelError ? <TextBlock variant="caption" style={{ color: theme.danger }}>Rebuild the development client after native dependency changes. Camera setup will remain unavailable until the local model is bundled.</TextBlock> : null}
  </Page>;
}

const styles = StyleSheet.create({
  heading: { gap: 8 },
  qualityRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  calibrationHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  guide: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'transparent' },
});
