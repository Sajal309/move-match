import React, { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { MovementArt } from '../src/MovementArt';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';
import type { Exercise } from '@move-match/rep-engine';

type ParticipantResult = {
  slot: number; is_self: boolean; is_winner: boolean; mode: 'friend' | 'ranked'; exercise: Exercise;
  display_name_snapshot: string; accepted_count: number; outcome: string | null; score_player_1: number | null;
  score_player_2: number | null; reason: string | null; settled_at: string | null;
  rating_before: number | null; rating_delta: number | null; rating_after: number | null; xp_awarded: number;
};
type MatchResult = { participants: ParticipantResult[] };

export default function OnlineResultsScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ matchId?: string }>();
  const [result, setResult] = useState<MatchResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    if (!params.matchId) { setError('This result link is missing its match identifier.'); return; }
    void apiRequest<MatchResult>(`/v1/matches/${params.matchId}`).then((value) => { if (live) setResult(value); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : 'Could not load the settled result.'); });
    return () => { live = false; };
  }, [params.matchId]);
  const own = result?.participants.find((player) => player.is_self);
  const opponent = result?.participants.find((player) => !player.is_self);
  const outcome = own?.outcome;
  const title = outcome === 'void' ? 'Round voided.' : outcome === 'draw' ? 'A draw.' : own?.is_winner ? 'You won this round.' : outcome ? 'Round complete.' : 'Confirming result…';
  const explanation = outcome === 'void' ? 'The server voided this match. It did not award rating or XP.'
    : outcome === 'forfeit' ? own?.is_winner ? 'Your opponent forfeited the match.' : 'This result was settled as a forfeit.'
      : own?.mode === 'friend' ? 'Friendly match · rating unchanged.' : outcome ? 'The server has settled the ranked result.'
        : 'The authoritative score has not arrived yet. You can return to Play; the result remains recoverable from match history.';
  const blockOpponent = () => {
    if (!params.matchId || !opponent) return;
    Alert.alert('Block this player?', 'They will not be paired with you or join your friend invites.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block player', style: 'destructive', onPress: () => void apiRequest(`/v1/matches/${params.matchId}/block-opponent`, { method: 'POST', body: '{}' })
        .then(() => Alert.alert('Player blocked', 'You can manage blocked players from the You tab.'))
        .catch((reason) => Alert.alert('Could not block player', reason instanceof Error ? reason.message : 'Try again later.')) },
    ]);
  };
  return <Page contentStyle={styles.page}>
    <View style={{ gap: 8 }}><Eyebrow>{own?.mode === 'friend' ? 'FRIEND MATCH' : 'MATCH RESULT'}</Eyebrow><TextBlock variant="display">{title}</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>{explanation}</TextBlock></View>
    {own ? <Card style={styles.card}>
      <MovementArt exercise={own.exercise} />
      <TextBlock variant="section">{own.exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'} · 45 seconds</TextBlock>
      <View style={styles.scoreRow}>
        <Score name="You" value={own.slot === 1 ? own.score_player_1 : own.score_player_2} theme={theme} />
        <TextBlock variant="section" style={{ color: theme.secondary }}>—</TextBlock>
        <Score name={opponent?.display_name_snapshot ?? 'Rival'} value={own.slot === 1 ? own.score_player_2 : own.score_player_1} theme={theme} />
      </View>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Accepted app-standard repetitions. No camera stream or full pose sequence was sent.</TextBlock>
      {own.mode === 'ranked' && own.rating_delta !== null ? <TextBlock variant="label">Rating {own.rating_before} → {own.rating_after} · {own.rating_delta > 0 ? '+' : ''}{own.rating_delta}</TextBlock> : null}
      {own.xp_awarded > 0 ? <TextBlock variant="label">+{own.xp_awarded} XP</TextBlock> : null}
      {own.reason ? <TextBlock variant="caption" style={{ color: theme.secondary }}>Result note: {own.reason.replaceAll('_', ' ')}</TextBlock> : null}
      {own.settled_at ? <TextBlock variant="caption" style={{ color: theme.secondary }}>Settled {new Date(own.settled_at).toLocaleString()}</TextBlock> : null}
      {opponent ? <>
        <ActionButton title="Report a concern" tone="quiet" onPress={() => router.push({ pathname: '/report', params: { matchId: params.matchId } })} />
        <ActionButton title="Block this player" tone="danger" onPress={blockOpponent} />
      </> : null}
    </Card> : <Card>
      <TextBlock variant="section">{error ? 'Result unavailable' : 'Loading result'}</TextBlock>
      <TextBlock style={{ color: error ? theme.danger : theme.secondary }}>{error || 'Contacting the match service…'}</TextBlock>
    </Card>}
    <ActionButton title="Back to Play" onPress={() => router.replace('/(tabs)')} />
    <ActionButton title="Practice again" tone="secondary" onPress={() => router.replace({ pathname: '/setup', params: { exercise: own?.exercise ?? 'push_up' } })} />
  </Page>;
}

function Score({ name, value, theme }: { name: string; value: number | null; theme: ReturnType<typeof useAppTheme>['theme'] }) {
  return <View style={styles.score}><TextBlock variant="caption" style={{ color: theme.secondary }}>{name}</TextBlock><TextBlock variant="display">{value ?? '—'}</TextBlock></View>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, justifyContent: 'center' }, card: { alignItems: 'center', gap: 12, paddingVertical: 24 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', alignSelf: 'stretch' }, score: { flex: 1, alignItems: 'center', gap: 4 } });
