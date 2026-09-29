import React, { useEffect, useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';
import type { Exercise } from '@move-match/rep-engine';
import { randomUuid } from '../src/ids';

type Invite = { matchId: string; inviteCode: string; expiresInSeconds: number; sessionNonce: string; exercise: Exercise };

export default function FriendInviteScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; calibration?: string; facing?: string; setupConfirmedAtMs?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(600);
  const [idempotencyKey] = useState(() => randomUuid());
  useEffect(() => {
    let active = true;
    setBusy(true);
    void apiRequest<Invite>('/v1/invites', { method: 'POST', body: JSON.stringify({ exercise, idempotencyKey }) })
      .then((created) => { if (active) { setInvite(created); setRemainingSeconds(created.expiresInSeconds); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not create an invite.'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [exercise, idempotencyKey]);
  useEffect(() => {
    if (!invite || remainingSeconds <= 0) return;
    const id = setInterval(() => setRemainingSeconds((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(id);
  }, [invite, remainingSeconds > 0]);
  const share = async () => {
    if (!invite) return;
    await Share.share({ title: 'MOVE / MATCH friend challenge', message: `Join my unranked MOVE / MATCH ${exercise === 'push_up' ? 'push-up' : 'pull-up'} round. Enter code ${invite.inviteCode} in the app. This code expires in 10 minutes.` });
  };
  const openLobby = () => {
    if (!invite) return;
    router.replace({ pathname: '/match', params: { matchId: invite.matchId, sessionNonce: invite.sessionNonce,
      exercise, mode: 'friend', calibration: params.calibration ?? '', facing: params.facing ?? 'front',
      setupConfirmedAtMs: params.setupConfirmedAtMs ?? '0' } });
  };
  const cancel = async () => {
    if (invite) await apiRequest(`/v1/matches/${invite.matchId}/leave`, { method: 'POST', body: JSON.stringify({}) }).catch(() => undefined);
    router.replace('/(tabs)');
  };
  return <Page contentStyle={styles.page}>
    <View style={{ gap: 8 }}><Eyebrow>FRIEND INVITE · UNRANKED</Eyebrow><TextBlock variant="title">Invite one training partner.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>This match leaves rating unchanged. The other player must enter this code in MOVE / MATCH.</TextBlock></View>
    {invite ? <Card style={styles.inviteCard}>
      <TextBlock variant="label">SINGLE-USE CODE</TextBlock>
      <TextBlock accessibilityLabel={`Invite code ${invite.inviteCode.split('').join(' ')}`} variant="display" style={styles.code}>{invite.inviteCode}</TextBlock>
      <TextBlock variant="label" style={{ color: remainingSeconds > 0 ? theme.tealText : theme.danger }}>
        {remainingSeconds > 0 ? `Expires in ${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}` : 'Invite expired'}</TextBlock>
      <ActionButton title="Share invite code" onPress={() => void share()} />
      <TextBlock variant="caption" style={{ color: theme.secondary, textAlign: 'center' }}>A universal link needs the final app domain, which has not been configured. Share the code, then have your friend enter it in the app.</TextBlock>
    </Card> : <Card>
      <TextBlock variant="section">{busy ? 'Creating invite…' : 'Invite unavailable'}</TextBlock>
      <TextBlock accessibilityRole={error ? 'alert' : undefined} style={{ color: error ? theme.danger : theme.secondary }}>{error || 'Connecting to the friend challenge service.'}</TextBlock>
    </Card>}
    <ActionButton title="Open camera lobby" disabled={!invite || remainingSeconds <= 0} onPress={openLobby} />
    <ActionButton title="Cancel invite" tone="quiet" onPress={() => void cancel()} />
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, justifyContent: 'center' }, inviteCard: { alignItems: 'center', paddingVertical: 26, gap: 12 },
  code: { letterSpacing: 4, fontSize: 34, fontVariant: ['tabular-nums'] } });
