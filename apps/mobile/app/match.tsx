import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, AppState, StyleSheet, View } from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import type { Socket } from 'socket.io-client';
import { getPoseLandmarker } from '@move-match/pose-tracker';
import type { Exercise, LocalRepObservation, PosePacket, PullUpCalibration, Quality } from '@move-match/rep-engine';
import { RULE_VERSION } from '@move-match/rep-engine';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { PoseCamera } from '../src/PoseCamera';
import { useAppTheme } from '../src/theme';
import { createAuthenticatedSocket } from '../src/network';
import { randomUuid } from '../src/ids';

type Phase = 'loading' | 'waiting' | 'countdown' | 'active' | 'reconnecting' | 'settling' | 'cancelled';
type Participant = {
  slot: number; is_self: boolean; display_name_snapshot: string; avatar_id_snapshot: string; accepted_count: number;
  state: string; mode: 'friend' | 'ranked'; exercise: Exercise; rule_version: string; model_version: string;
  start_at: string | null; end_at: string | null; outcome: string | null; score_player_1: number | null; score_player_2: number | null; reason: string | null;
};
type MatchSnapshot = { matchId: string; sessionNonce?: string; nextSeq: number; serverTime: string; participants: Participant[] };
type RepEvent = {
  protocolVersion: 1; eventId: string; matchId: string; sessionNonce: string; seq: number; exercise: Exercise;
  ruleVersion: string; modelVersion: string; cycleStartMs: number; cycleEndMs: number; minElbowDeg: number;
  maxElbowDeg: number; minimumRequiredVisibility: number; trackingGapMs: number; qualityFlags: string[];
};
type PendingEvent = { payload: RepEvent; createdAt: number };

export default function MatchScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ matchId?: string; sessionNonce?: string; exercise?: string; mode?: string; calibration?: string;
    facing?: string; setupConfirmedAtMs?: string }>();
  const matchId = params.matchId ?? '';
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const mode: 'friend' | 'ranked' = params.mode === 'ranked' ? 'ranked' : 'friend';
  const facing: 'front' | 'back' = params.facing === 'back' ? 'back' : exercise === 'pull_up' ? 'back' : 'front';
  const calibration = useRef<PullUpCalibration | undefined>(undefined);
  if (exercise === 'pull_up' && !calibration.current && params.calibration) {
    try { calibration.current = JSON.parse(params.calibration) as PullUpCalibration; } catch { calibration.current = undefined; }
  }
  const [phase, setPhase] = useState<Phase>('loading');
  const [connected, setConnected] = useState(false);
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [localReps, setLocalReps] = useState(0);
  const [serverScores, setServerScores] = useState({ player1: 0, player2: 0 });
  const [quality, setQuality] = useState<Quality>('out_of_frame');
  const [cue, setCue] = useState('Move into the frame');
  const [inferenceMs, setInferenceMs] = useState(0);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelError, setModelError] = useState('');
  const [appState, setAppState] = useState(AppState.currentState);
  const isFocused = useIsFocused();
  const [remainingMs, setRemainingMs] = useState(0);
  const [message, setMessage] = useState('');
  const socketRef = useRef<Socket | null>(null);
  const nonceRef = useRef(params.sessionNonce ?? '');
  const sequenceRef = useRef(1);
  const pendingRef = useRef<PendingEvent[]>([]);
  const clockOffsetRef = useRef(0);
  const startPerfRef = useRef(0);
  const endPerfRef = useRef(0);
  const disconnectedAtRef = useRef<number | null>(null);
  const lastServerSeqRef = useRef(0);
  const finishedRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        const diagnostics = JSON.parse(getPoseLandmarker().diagnostics()) as { modelLoaded?: boolean; lastError?: string };
        setModelLoaded(Boolean(diagnostics.modelLoaded));
        setModelError(diagnostics.modelLoaded ? '' : diagnostics.lastError ?? 'Loading local pose model');
      } catch {
        setModelLoaded(false);
        setModelError('Native pose tracking is unavailable. Rebuild the development client.');
      }
    }, 500);
    return () => clearInterval(timer);
  }, []);

  const openResults = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    router.replace({ pathname: '/online-results', params: { matchId } });
  }, [matchId]);

  const applySnapshot = useCallback((next: MatchSnapshot) => {
    setSnapshot(next);
    if (next.sessionNonce) nonceRef.current = next.sessionNonce;
    sequenceRef.current = Math.max(1, next.nextSeq || 1);
    const own = next.participants.find((participant) => participant.is_self);
    const first = next.participants[0];
    if (first) {
      setServerScores({ player1: first.score_player_1 ?? 0, player2: first.score_player_2 ?? 0 });
      const offset = Date.parse(next.serverTime) - performance.now();
      clockOffsetRef.current = offset;
      if (first.state === 'COMPLETED' || first.state === 'VOIDED') { openResults(); return; }
      if (first.state === 'CANCELLED') { setPhase('cancelled'); return; }
      if (first.state === 'COUNTDOWN' && first.start_at && first.end_at) {
        startPerfRef.current = Date.parse(first.start_at) - offset;
        endPerfRef.current = Date.parse(first.end_at) - offset;
        setPhase('countdown');
      } else if (first.state === 'ACTIVE' && first.start_at && first.end_at) {
        startPerfRef.current = Date.parse(first.start_at) - offset;
        endPerfRef.current = Date.parse(first.end_at) - offset;
        setPhase('active');
      } else setPhase('waiting');
    }
    if (own) setLocalReps(own.accepted_count);
  }, [openResults]);

  const sendPending = useCallback(() => {
    const socket = socketRef.current;
    if (!socket?.connected || !nonceRef.current) return;
    const now = performance.now();
    pendingRef.current = pendingRef.current.filter((item) => now - item.createdAt <= 3_000);
    for (const item of [...pendingRef.current]) {
      const payload = { ...item.payload, sessionNonce: nonceRef.current };
      socket.timeout(2_000).emit('match.rep', payload, (timeoutError: Error | null, response: { ok?: boolean; status?: string; error?: { message?: string } }) => {
        if (timeoutError) return;
        pendingRef.current = pendingRef.current.filter((queued) => queued.payload.eventId !== payload.eventId);
        if (!response?.ok) setMessage(response?.error?.message ?? 'A rep could not be confirmed by the server.');
      });
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: Socket | null = null;
    const connect = async () => {
      if (!matchId) { setMessage('This match link is missing its lobby identifier.'); setPhase('cancelled'); return; }
      try {
        socket = await createAuthenticatedSocket();
        if (disposed) { socket.close(); return; }
        socketRef.current = socket;
        socket.on('connect', () => {
          setConnected(true);
          disconnectedAtRef.current = null;
          setMessage('');
          socket?.emit('match.resume', { protocolVersion: 1, matchId, lastServerSeq: lastServerSeqRef.current },
            (ack: { ok?: boolean; snapshot?: MatchSnapshot; error?: { message?: string } }) => {
              if (ack?.snapshot) { applySnapshot(ack.snapshot); sendPending(); }
              else if (!ack?.ok) setMessage(ack?.error?.message ?? 'Could not reconnect to the match.');
            });
        });
        socket.on('disconnect', () => {
          setConnected(false);
          disconnectedAtRef.current = performance.now();
          setMessage('Reconnecting. The server round clock continues.');
        });
        socket.on('connect_error', (error) => {
          setConnected(false);
          setMessage(error.message === 'AUTH_EXPIRED' ? 'Your sign-in expired. Return to the app and sign in again.' : 'Connection lost. Reconnecting…');
        });
        socket.on('match.snapshot', (value: MatchSnapshot & { serverSeq?: number }) => {
          if (value.serverSeq) lastServerSeqRef.current = Math.max(lastServerSeqRef.current, value.serverSeq);
          applySnapshot(value);
          sendPending();
        });
        socket.on('match.found', () => {
          setMessage('Your friend joined the lobby. Both players can check camera readiness.');
          socket?.emit('match.resume', { protocolVersion: 1, matchId, lastServerSeq: lastServerSeqRef.current },
            (ack: { ok?: boolean; snapshot?: MatchSnapshot; error?: { message?: string } }) => {
              if (ack?.snapshot) applySnapshot(ack.snapshot);
              else if (!ack?.ok) setMessage(ack?.error?.message ?? 'Could not refresh the friend lobby.');
            });
        });
        socket.on('match.countdown', (event: { startAt: string; endAt: string; serverSeq?: number }) => {
          if (event.serverSeq) lastServerSeqRef.current = Math.max(lastServerSeqRef.current, event.serverSeq);
          startPerfRef.current = Date.parse(event.startAt) - clockOffsetRef.current;
          endPerfRef.current = Date.parse(event.endAt) - clockOffsetRef.current;
          setPhase('countdown'); setMessage('');
        });
        socket.on('match.score', (event: { player1: number; player2: number; serverSeq?: number }) => {
          if (event.serverSeq) lastServerSeqRef.current = Math.max(lastServerSeqRef.current, event.serverSeq);
          setServerScores({ player1: event.player1, player2: event.player2 });
          setMessage('');
        });
        socket.on('match.settled', (event: { serverSeq?: number }) => {
          if (event.serverSeq) lastServerSeqRef.current = Math.max(lastServerSeqRef.current, event.serverSeq);
          openResults();
        });
        socket.on('match.ended', (event: { result?: { status?: string; state?: string; reason?: string }; serverSeq?: number }) => {
          if (event.serverSeq) lastServerSeqRef.current = Math.max(lastServerSeqRef.current, event.serverSeq);
          if (event.result?.status === 'cancelled' || event.result?.state === 'CANCELLED') {
            setPhase('cancelled'); setMessage(event.result?.reason === 'ready_timeout'
              ? 'The lobby timed out before both players were ready.' : 'The lobby closed before the round started.');
          }
          else openResults();
        });
        socket.connect();
      } catch (error) {
        if (!disposed) { setPhase('cancelled'); setMessage(error instanceof Error ? error.message : 'Online match service is unavailable.'); }
      }
    };
    void connect();
    return () => { disposed = true; socket?.removeAllListeners(); socket?.close(); socketRef.current = null; };
  }, [applySnapshot, matchId, openResults, sendPending]);

  useEffect(() => {
    if (phase !== 'waiting' || !matchId) return;
    let live = true;
    const refresh = async () => {
      try {
        const next = await (await import('../src/api')).apiRequest<MatchSnapshot>(`/v1/matches/${matchId}`);
        if (live) applySnapshot(next);
      } catch { /* Socket reconnect will provide the same snapshot. */ }
    };
    const timer = setInterval(() => void refresh(), 3_000);
    return () => { live = false; clearInterval(timer); };
  }, [applySnapshot, matchId, phase]);

  useEffect(() => {
    if (phase !== 'countdown' && phase !== 'active' && phase !== 'settling') return;
    const timer = setInterval(() => {
      const now = performance.now();
      if (endPerfRef.current > 0) setRemainingMs(Math.max(0, endPerfRef.current - now));
      if (phase === 'countdown' && now >= startPerfRef.current) setPhase('active');
      if ((phase === 'active' || phase === 'countdown') && endPerfRef.current > 0 && now >= endPerfRef.current) setPhase('settling');
    }, 50);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'settling') return;
    let live = true;
    const poll = async () => {
      try {
        const next = await (await import('../src/api')).apiRequest<MatchSnapshot>(`/v1/matches/${matchId}`);
        if (live) applySnapshot(next);
      } catch { /* The result remains pending and the socket continues to reconnect. */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2_000);
    return () => { live = false; clearInterval(timer); };
  }, [applySnapshot, matchId, phase]);

  useEffect(() => {
    if (!connected || phase !== 'active' || appState !== 'active' || !isFocused) return;
    const socket = socketRef.current;
    const timer = setInterval(() => socket?.emit('match.heartbeat', { protocolVersion: 1, matchId, requestId: randomUuid() }), 5_000);
    return () => clearInterval(timer);
  }, [appState, connected, isFocused, matchId, phase]);

  const ready = () => {
    const socket = socketRef.current;
    if (!socket?.connected || !snapshot || !modelLoaded || quality !== 'ready' || !calibrationIsCurrent()) return;
    socket.emit('match.ready', { protocolVersion: 1, matchId, sessionNonce: nonceRef.current,
      modelVersion: 'google-pose-landmarker-lite-float16', requestId: randomUuid() },
      (response: { ok?: boolean; state?: string; error?: { message?: string } }) => {
        if (!response?.ok) setMessage(response?.error?.message ?? 'Could not mark camera ready.');
        else setMessage(response.state === 'COUNTDOWN' ? 'Both cameras are ready. Starting in five seconds.' : 'You are ready. Waiting for the other player.');
      });
  };

  function calibrationIsCurrent() {
    const setupAt = Number(params.setupConfirmedAtMs ?? 0);
    const setupFresh = setupAt > 0 && Date.now() - setupAt <= 60_000;
    if (exercise !== 'pull_up') return setupFresh;
    return setupFresh && calibration.current !== undefined && Date.now() - calibration.current.calibratedAtMs <= 60_000;
  }

  const onRep = useCallback((count: number, _timestampMs: number, observation?: LocalRepObservation) => {
    setLocalReps(count);
    if (!observation || phase !== 'active') return;
    const event: RepEvent = {
      protocolVersion: 1, eventId: randomUuid(), matchId, sessionNonce: nonceRef.current,
      seq: sequenceRef.current++, exercise, ruleVersion: RULE_VERSION[exercise], modelVersion: 'google-pose-landmarker-lite-float16',
      cycleStartMs: Math.max(0, Math.round(observation.cycleStartMs)), cycleEndMs: Math.max(1, Math.round(observation.cycleEndMs)),
      minElbowDeg: observation.minElbowDeg, maxElbowDeg: observation.maxElbowDeg,
      minimumRequiredVisibility: observation.minimumRequiredVisibility, trackingGapMs: observation.trackingGapMs, qualityFlags: [],
    };
    pendingRef.current.push({ payload: event, createdAt: performance.now() });
    if (pendingRef.current.length > 15) pendingRef.current.shift();
    sendPending();
  }, [exercise, matchId, phase, sendPending]);

  const leave = () => Alert.alert(phase === 'active' || phase === 'settling' ? 'Leave and forfeit?' : 'Leave this lobby?',
    phase === 'active' || phase === 'settling' ? 'Leaving now ends your participation. The server will settle the result.' : 'Leaving cancels this waiting lobby.', [
      { text: 'Stay', style: 'cancel' }, { text: 'Leave', style: 'destructive', onPress: () => {
        const socket = socketRef.current;
        if (socket?.connected) socket.emit('match.leave', { protocolVersion: 1, matchId, requestId: randomUuid() }, () => router.replace('/(tabs)'));
        else router.replace('/(tabs)');
      } },
    ]);

  const own = snapshot?.participants.find((participant) => participant.is_self);
  const opponent = snapshot?.participants.find((participant) => !participant.is_self);
  const score1 = serverScores.player1;
  const score2 = serverScores.player2;
  const ownConfirmed = own?.slot === 1 ? score1 : score2;
  const trackingLabel = quality === 'ready' ? cue : quality === 'low_confidence' ? 'More light needed — key joints are unclear'
    : quality === 'occluded' ? 'A required joint is hidden — get back in frame' : 'Tracking paused — get back in frame';
  const shouldRunCamera = isFocused && appState === 'active' && phase !== 'loading' && phase !== 'settling' && phase !== 'cancelled';
  const canCount = phase === 'active' && connected && (disconnectedAtRef.current === null || performance.now() - disconnectedAtRef.current <= 3_000);
  const timeLabel = phase === 'countdown' ? `${Math.max(1, Math.ceil((startPerfRef.current - performance.now()) / 1000))}`
    : `${Math.floor(Math.max(0, remainingMs) / 60_000)}:${String(Math.ceil((Math.max(0, remainingMs) % 60_000) / 1000)).padStart(2, '0')}`;

  return <Page contentStyle={styles.page}>
    <View style={styles.top}>
      <View style={{ flex: 1, gap: 3 }}><Eyebrow>{mode === 'friend' ? 'FRIEND MATCH · UNRANKED' : 'RANKED MATCH'}</Eyebrow>
        <TextBlock variant="section">{phase === 'waiting' ? 'Check your camera.' : phase === 'countdown' ? 'Get ready.'
          : phase === 'active' ? 'Your round.' : phase === 'settling' ? 'Confirming result.' : phase === 'reconnecting' ? 'Reconnecting.' : 'Preparing match.'}</TextBlock></View>
      {phase === 'countdown' || phase === 'active' || phase === 'settling' ? <TextBlock variant="display" style={styles.timer}>{timeLabel}</TextBlock> : null}
    </View>
    <Card style={styles.scoreboard}>
      <View style={styles.player}><TextBlock variant="caption">YOU {own?.slot === 1 ? '(P1)' : own?.slot === 2 ? '(P2)' : ''}</TextBlock>
        <TextBlock variant="display">{ownConfirmed}</TextBlock><TextBlock variant="caption">{localReps > ownConfirmed ? `${localReps - ownConfirmed} provisional` : 'confirmed'}</TextBlock></View>
      <TextBlock variant="section" style={{ color: theme.secondary }}>VS</TextBlock>
      <View style={styles.player}><TextBlock variant="caption">{opponent?.display_name_snapshot ?? 'Waiting for player'}</TextBlock>
        <TextBlock variant="display">{opponent?.slot === 1 ? score1 : opponent?.slot === 2 ? score2 : 0}</TextBlock>
        <TextBlock variant="caption">{connected ? 'server score' : 'last confirmed · reconnecting'}</TextBlock></View>
    </Card>
    <PoseCamera facing={facing} active={shouldRunCamera} exercise={exercise} counting={canCount} roundDurationMs={45_000}
      pullUpCalibration={calibration.current} onRep={onRep} onTracking={(status) => {
        setQuality(status.quality); setCue(status.cue); setInferenceMs(status.inferenceMs);
      }} />
    <View style={styles.status}>
      <View style={[styles.dot, { backgroundColor: connected && quality === 'ready' && modelLoaded ? theme.primary : theme.warning }]} />
      <View style={{ flex: 1, gap: 3 }}><TextBlock variant="label">{!connected ? 'Connection paused' : modelError ? 'Pose model unavailable' : quality === 'ready' ? 'Tracking ready' : 'Tracking paused'}</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>{!connected ? 'The server clock continues while reconnecting.' : modelError || trackingLabel}</TextBlock></View>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>{inferenceMs > 0 ? `${Math.round(inferenceMs)} ms` : ''}</TextBlock>
    </View>
    {phase === 'waiting' ? <Card style={{ gap: 8 }}>
      <TextBlock variant="label">{opponent ? 'Opponent is in the lobby' : mode === 'friend' ? 'Share your invite code so your friend can join.' : 'Match reserved. Confirm readiness to start the server countdown.'}</TextBlock>
      {!calibrationIsCurrent() ? <TextBlock variant="caption" style={{ color: theme.warning }}>Setup expired. Recalibrate before readiness.</TextBlock> : null}
      <ActionButton title={!connected ? 'Connecting…' : !modelLoaded ? 'Loading local pose model' : quality !== 'ready' ? 'Move into camera frame' : !calibrationIsCurrent() ? 'Recalibrate setup' : 'I’m ready'}
        disabled={!connected || !modelLoaded || quality !== 'ready'}
        onPress={() => calibrationIsCurrent() ? ready() : router.replace({ pathname: '/setup', params: {
          exercise, mode: mode === 'ranked' ? 'ranked_existing' : 'friend_existing', matchId,
          sessionNonce: nonceRef.current, facing,
        } })} />
    </Card> : null}
    {phase === 'countdown' ? <TextBlock accessibilityLiveRegion="polite" variant="title" style={{ textAlign: 'center', color: theme.tealText }}>{timeLabel}</TextBlock> : null}
    {phase === 'settling' ? <TextBlock style={{ color: theme.secondary }}>The server is settling the result. You can stay here while it confirms.</TextBlock> : null}
    {message ? <TextBlock accessibilityLiveRegion="polite" style={{ color: theme.secondary }}>{message}</TextBlock> : null}
    {phase === 'active' || phase === 'waiting' || phase === 'countdown' ? <ActionButton title="Leave match" tone="quiet" onPress={leave} /> : null}
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, gap: 12 }, top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  timer: { fontVariant: ['tabular-nums'], fontSize: 34 }, scoreboard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  player: { flex: 1, alignItems: 'center', gap: 2 }, status: { flexDirection: 'row', alignItems: 'center', gap: 8 }, dot: { width: 9, height: 9, borderRadius: 5 } });
