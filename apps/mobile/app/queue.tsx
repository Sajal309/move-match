import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import type { Socket } from 'socket.io-client';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { PoseCamera } from '../src/PoseCamera';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';
import { createAuthenticatedSocket, probeRankedNetwork } from '../src/network';
import type { Exercise } from '@move-match/rep-engine';
import { randomUuid } from '../src/ids';

type QueueEntry = { status: 'queued'; queueId: string } | { status: 'matched'; matchId: string; sessionNonce: string };
type MatchSnapshot = { matchId: string; sessionNonce?: string; participants: Array<{ exercise: Exercise; mode: string }> };

export default function QueueScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; facing?: string; calibration?: string; setupConfirmedAtMs?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const facing: 'front' | 'back' = params.facing === 'back' ? 'back' : exercise === 'pull_up' ? 'back' : 'front';
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState(AppState.currentState);
  const [connected, setConnected] = useState(false);
  const [quality, setQuality] = useState('Checking camera framing');
  const [elapsed, setElapsed] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('Calibrating your connection to the queue.');
  const socketRef = useRef<Socket | null>(null);
  const startedAt = useRef(0);
  const transitioning = useRef(false);
  const queueActive = useRef(false);
  const busyRef = useRef(false);
  const timeoutTriggered = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  const prepareMatch = useCallback(async (matchId: string) => {
    if (transitioning.current) return;
    transitioning.current = true;
    queueActive.current = false;
    setMessage('A player is available. Recheck your camera before confirming readiness.');
    try {
      const snapshot = await apiRequest<MatchSnapshot>(`/v1/matches/${matchId}`);
      const own = snapshot.participants.find((participant) => participant.mode === 'ranked');
      const nextExercise = own?.exercise ?? exercise;
      router.replace({ pathname: '/setup', params: { mode: 'ranked_existing', matchId,
        sessionNonce: snapshot.sessionNonce ?? '', exercise: nextExercise, facing } });
    } catch (reason) {
      transitioning.current = false;
      setError(reason instanceof Error ? reason.message : 'Could not load the reserved match.');
    }
  }, [exercise, facing]);

  const cancel = useCallback(async (reason: 'user' | 'timeout') => {
    if (busyRef.current || transitioning.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await apiRequest<{ status: string; matchId?: string }>('/v1/queue/current', { method: 'DELETE' });
      queueActive.current = false;
      if (response.status === 'reserved' && response.matchId) { await prepareMatch(response.matchId); return; }
      setWaiting(false);
      if (reason === 'timeout') setMessage('No compatible player arrived in 45 seconds. Try a friend challenge or practice.');
      else router.replace('/(tabs)');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not cancel the queue.'); }
    finally { busyRef.current = false; setBusy(false); }
  }, [prepareMatch]);

  useEffect(() => {
    let disposed = false;
    let socket: Socket | null = null;
    const begin = async () => {
      setBusy(true); setError('');
      try {
        setMessage('Checking round-trip delay and server clock…');
        await probeRankedNetwork();
        const response = await apiRequest<QueueEntry>('/v1/queue', { method: 'POST', body: JSON.stringify({ exercise }) });
        if (disposed) {
          if (response.status === 'queued') void apiRequest('/v1/queue/current', { method: 'DELETE' }).catch(() => undefined);
          else void apiRequest(`/v1/matches/${response.matchId}/leave`, { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined);
          return;
        }
        if (response.status === 'matched') { await prepareMatch(response.matchId); return; }
        queueActive.current = true;
        timeoutTriggered.current = false;
        startedAt.current = performance.now(); setWaiting(true); setBusy(false); setMessage('Searching for an eligible player. There is no simulated opponent.');
        socket = await createAuthenticatedSocket();
        if (disposed) { socket.close(); return; }
        socketRef.current = socket;
        socket.on('connect', () => { setConnected(true); setError(''); });
        socket.on('disconnect', () => setConnected(false));
        socket.on('connect_error', (reason) => { setConnected(false); setError(reason.message === 'AUTH_EXPIRED' ? 'Sign in again to continue.' : 'Queue connection lost. Reconnecting…'); });
        socket.on('match.found', (event: { matchId: string }) => { void prepareMatch(event.matchId); });
        socket.connect();
      } catch (reason) {
        if (!disposed) {
          if (queueActive.current) void apiRequest('/v1/queue/current', { method: 'DELETE' }).catch(() => undefined);
          queueActive.current = false;
          setError(reason instanceof Error ? reason.message : 'Quick match is unavailable.'); setBusy(false);
        }
      }
    };
    void begin();
    return () => {
      disposed = true;
      socket?.removeAllListeners(); socket?.close(); socketRef.current = null;
      if (queueActive.current && !transitioning.current) {
        queueActive.current = false;
        void apiRequest('/v1/queue/current', { method: 'DELETE' }).catch(() => undefined);
      }
    };
  }, [exercise, prepareMatch]);

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      const seconds = Math.floor((performance.now() - startedAt.current) / 1000);
      setElapsed(Math.min(45, seconds));
      if (seconds > 0 && seconds % 5 === 0) {
        if (connected) socketRef.current?.emit('queue.heartbeat', { protocolVersion: 1, requestId: randomUuid() },
          (response: { ok?: boolean }) => { if (response && !response.ok) setMessage('Queue reservation changed. Checking match status…'); });
        else void apiRequest<{ ok: boolean }>('/v1/queue/heartbeat', { method: 'POST', body: JSON.stringify({}) })
          .then((response) => { if (!response.ok) setMessage('Queue reservation changed. Checking match status…'); })
          .catch(() => setMessage('Connection paused. Reconnecting to the queue…'));
      }
      if (seconds >= 45 && !timeoutTriggered.current) { timeoutTriggered.current = true; void cancel('timeout'); }
    }, 1_000);
    return () => clearInterval(timer);
  }, [cancel, connected, waiting]);

  return <Page contentStyle={styles.page}>
    <View style={{ gap: 7 }}><Eyebrow>QUICK MATCH · {exercise === 'push_up' ? 'PUSH-UPS' : 'PULL-UPS'}</Eyebrow>
      <TextBlock variant="title">{waiting ? 'Finding a compatible player.' : 'Preparing quick match.'}</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>The queue matches exercise, rule version and supported protocol. It never substitutes a bot.</TextBlock></View>
    <PoseCamera facing={facing} active={isFocused && appState === 'active' && waiting} exercise={exercise}
      onTracking={(status) => setQuality(status.quality === 'ready' ? 'Camera tracking is available' : status.cue)} />
    <Card style={styles.queueCard}>
      <View style={{ flex: 1, gap: 4 }}><TextBlock variant="label">{connected ? 'QUEUE CONNECTED' : 'CONNECTING TO QUEUE'}</TextBlock>
        <TextBlock style={{ color: theme.secondary }}>{quality}</TextBlock></View>
      <TextBlock variant="display" style={styles.elapsed}>{`0:${String(elapsed).padStart(2, '0')}`}</TextBlock>
    </Card>
    {message ? <TextBlock accessibilityLiveRegion="polite" style={{ color: theme.secondary }}>{message}</TextBlock> : null}
    {error ? <TextBlock accessibilityRole="alert" style={{ color: theme.danger }}>{error}</TextBlock> : null}
    {waiting && elapsed >= 45 ? <ActionButton title="Practice instead" tone="secondary" onPress={() => router.replace({ pathname: '/setup', params: { exercise } })} /> : null}
    <ActionButton title={busy ? 'Working…' : waiting ? 'Cancel queue' : 'Back to Play'} tone={waiting ? 'secondary' : 'quiet'} disabled={busy} onPress={() => waiting ? void cancel('user') : router.replace('/(tabs)')} />
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, gap: 12 }, queueCard: { flexDirection: 'row', alignItems: 'center' }, elapsed: { fontVariant: ['tabular-nums'], fontSize: 34 } });
