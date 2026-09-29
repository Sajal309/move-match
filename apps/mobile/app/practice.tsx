import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Alert, StyleSheet, Vibration, View } from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { PoseCamera } from '../src/PoseCamera';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { savePracticeSession } from '../src/storage';
import { RULE_VERSION } from '@move-match/rep-engine';
import type { Exercise, PullUpCalibration, Quality } from '@move-match/rep-engine';
import { getPreferences } from '../src/preferences';
import { apiRequest } from '../src/api';
import { currentAccount } from '../src/account';
import { randomUuid } from '../src/ids';
import { MODEL_VERSION } from '@move-match/rep-engine';

const COUNTDOWN_MS = 5_000;
const ROUND_MS = 45_000;
type Phase = 'countdown' | 'active' | 'paused' | 'complete';

export default function PracticeScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; calibration?: string; ruleVersion?: string; facing?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const facing: 'front' | 'back' = params.facing === 'back' ? 'back' : exercise === 'pull_up' ? 'back' : 'front';
  const calibration = useRef<PullUpCalibration | undefined>(undefined);
  if (exercise === 'pull_up' && !calibration.current && params.calibration) {
    try { calibration.current = JSON.parse(params.calibration) as PullUpCalibration; } catch { calibration.current = undefined; }
  }
  const [phase, setPhase] = useState<Phase>('countdown');
  const [remainingMs, setRemainingMs] = useState(COUNTDOWN_MS);
  const [reps, setReps] = useState(0);
  const [quality, setQuality] = useState<Quality>('out_of_frame');
  const [cue, setCue] = useState('Settle into your starting position');
  const [inferenceMs, setInferenceMs] = useState(0);
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [spokenCountEnabled, setSpokenCountEnabled] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const isFocused = useIsFocused();
  const deadline = useRef(performance.now() + COUNTDOWN_MS);
  const pausedPhase = useRef<'countdown' | 'active'>('countdown');
  const finished = useRef(false);

  useEffect(() => { void getPreferences().then((prefs) => { setHapticsEnabled(prefs.haptics); setSpokenCountEnabled(prefs.spokenCount); }); }, []);

  const finish = useCallback(async () => {
    if (finished.current) return;
    finished.current = true;
    setPhase('complete');
    const sessionId = randomUuid();
    let synced = false;
    let xpAwarded = 0;
    try {
      await savePracticeSession({
        id: sessionId,
        exercise,
        reps,
        durationMs: ROUND_MS,
        finishedAt: new Date().toISOString(),
        ruleVersion: RULE_VERSION[exercise],
      });
    } catch {
      Alert.alert('Practice finished', 'Your result is ready, but local history could not be saved on this device.');
    }
    if (reps > 0 && await currentAccount()) {
      try {
        const result = await apiRequest<{ status: string; xpAwarded: number }>('/v1/practice-sessions', {
          method: 'POST', body: JSON.stringify({ id: sessionId, exercise, durationMs: ROUND_MS, acceptedReps: reps,
            ruleVersion: RULE_VERSION[exercise], modelVersion: MODEL_VERSION }),
        });
        synced = result.status === 'recorded' || result.status === 'duplicate';
        xpAwarded = result.xpAwarded ?? 0;
      } catch { /* A failed sync remains local practice with no online reward. */ }
    }
    router.replace({ pathname: '/results', params: { mode: 'practice', exercise, reps: String(reps), ruleVersion: RULE_VERSION[exercise],
      onlineSynced: String(synced), xpAwarded: String(xpAwarded) } });
  }, [exercise, reps]);

  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'active') return;
    const interval = setInterval(() => {
      const left = Math.max(0, deadline.current - performance.now());
      setRemainingMs(left);
      if (left <= 0 && phase === 'countdown') {
        deadline.current = performance.now() + ROUND_MS;
        setRemainingMs(ROUND_MS);
        setPhase('active');
      } else if (left <= 0 && phase === 'active') void finish();
    }, 50);
    return () => clearInterval(interval);
  }, [finish, phase]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppState(state);
      if (state !== 'active' && (phase === 'active' || phase === 'countdown')) {
        pausedPhase.current = phase;
        setRemainingMs(Math.max(0, deadline.current - performance.now()));
        setPhase('paused');
      }
    });
    return () => subscription.remove();
  }, [phase]);

  useEffect(() => {
    if (exercise === 'pull_up' && !calibration.current) {
      Alert.alert('Calibration expired', 'Return to setup and mark the bar again before practice.', [{ text: 'Back to setup', onPress: () => router.replace({ pathname: '/setup', params: { exercise } }) }]);
    }
  }, [exercise]);

  const pause = () => {
    pausedPhase.current = phase === 'countdown' || phase === 'active' ? phase : pausedPhase.current;
    setRemainingMs(Math.max(0, deadline.current - performance.now()));
    setPhase('paused');
  };
  const resume = () => {
    const next = pausedPhase.current;
    deadline.current = performance.now() + remainingMs;
    setPhase(next);
  };
  const leave = () => Alert.alert('Leave practice?', 'This round will end and won’t be saved as a completed session.', [
    { text: 'Keep practicing', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => router.back() },
  ]);
  const qualityText = quality === 'ready' ? cue : quality === 'low_confidence' ? 'More light needed — keep key joints visible'
    : quality === 'occluded' ? 'A key joint is hidden — get it back in view'
      : quality === 'model_error' ? 'Pose model unavailable' : quality === 'camera_moved' ? 'Camera moved — reset the phone and recalibrate'
        : 'Tracking paused — get back in frame';
  const onRep = useCallback((count: number) => {
    setReps(count);
    if (count > 0 && count % 5 === 0) {
      if (hapticsEnabled) Vibration.vibrate(10);
      if (spokenCountEnabled) AccessibilityInfo.announceForAccessibility(`${count} app-standard reps`);
    }
  }, [hapticsEnabled, spokenCountEnabled]);

  return <Page edges={['top', 'left', 'right', 'bottom']} contentStyle={styles.page}>
    <View style={styles.header}>
      <View style={{ flex: 1, gap: 4 }}>
        <Eyebrow>OFFLINE PRACTICE · {exercise === 'push_up' ? 'PUSH-UPS' : 'PULL-UPS'}</Eyebrow>
        <TextBlock variant="section">{phase === 'countdown' ? 'Get ready' : phase === 'paused' ? 'Practice paused' : 'Your round'}</TextBlock>
      </View>
      <TextBlock accessibilityLabel={`${Math.ceil((phase === 'countdown' ? remainingMs : remainingMs) / 1000)} seconds remaining`}
        variant="display" style={styles.timer}>{phase === 'complete' ? '0:00' : `${Math.floor(remainingMs / 60_000)}:${String(Math.ceil((remainingMs % 60_000) / 1000)).padStart(2, '0')}`}</TextBlock>
    </View>
    <View style={styles.cameraWrap}>
      <PoseCamera facing={facing} active={isFocused && appState === 'active' && phase !== 'complete'}
        exercise={exercise} counting={phase === 'active'} roundDurationMs={ROUND_MS} pullUpCalibration={calibration.current}
        onRep={onRep} onTracking={(status) => { setQuality(status.quality); setCue(status.cue); setInferenceMs(status.inferenceMs); }} />
      {phase === 'countdown' ? <View pointerEvents="none" style={[styles.countdownOverlay, { backgroundColor: theme.background + 'D9' }]}>
        <TextBlock variant="display" style={{ color: theme.tealText }}>{Math.max(1, Math.ceil(remainingMs / 1000))}</TextBlock>
      </View> : null}
      {phase === 'paused' ? <View style={[styles.countdownOverlay, { backgroundColor: theme.background + 'E8' }]}>
        <TextBlock variant="section">Paused</TextBlock><ActionButton title="Resume round" onPress={resume} />
      </View> : null}
    </View>
    <Card style={styles.scoreCard}>
      <View style={{ flex: 1, gap: 3 }}><Eyebrow>APP-STANDARD REPS</Eyebrow><TextBlock variant="display">{reps}</TextBlock></View>
      <View style={styles.status}>
        <View style={[styles.statusDot, { backgroundColor: quality === 'ready' ? theme.primary : theme.warning }]} />
        <View style={{ flex: 1, gap: 3 }}><TextBlock variant="label">{quality === 'ready' ? 'Tracking' : 'Tracking paused'}</TextBlock>
          <TextBlock variant="caption" style={{ color: theme.secondary }}>{qualityText}</TextBlock></View>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>{inferenceMs > 0 ? `${Math.round(inferenceMs)} ms` : ''}</TextBlock>
      </View>
    </Card>
    {phase === 'active' ? <ActionButton title="Pause practice" tone="secondary" onPress={pause} /> : null}
    <ActionButton title="Leave round" tone="quiet" onPress={leave} />
    <View style={{ flex: 1 }} />
  </Page>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timer: { fontVariant: ['tabular-nums'], fontSize: 35 },
  cameraWrap: { width: '100%', position: 'relative' },
  countdownOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, zIndex: 5,
    alignItems: 'center', justifyContent: 'center', gap: 14, borderRadius: 24 },
  scoreCard: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  status: { flex: 1.2, flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
});
