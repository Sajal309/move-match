import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Page, TextBlock, Card, ActionButton, Eyebrow } from '../../src/ui';
import { MovementArt } from '../../src/MovementArt';
import { useAppTheme } from '../../src/theme';
import { apiRequest } from '../../src/api';
import { currentAccount } from '../../src/account';
import type { Exercise } from '@move-match/rep-engine';

type LeaderboardRow = { rank: number; displayName: string; avatarId: string; rating: number; played: number; isSelf: boolean; updatedAt: string };
type Board = { season: { id: string; name: string } | null; rows: LeaderboardRow[]; ownRank: number | null; cachedAt: string };
type Progress = { ratings: Array<{ exercise: Exercise; rating: number; played: number; eligible: boolean }> };

export default function LeaderboardScreen() {
  const { theme } = useAppTheme();
  const [exercise, setExercise] = useState<Exercise>('push_up');
  const [board, setBoard] = useState<Board | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const account = await currentAccount();
      setSignedIn(Boolean(account));
      if (!account) { setBoard(null); setProgress(null); return; }
      const [nextBoard, nextProgress] = await Promise.all([
        apiRequest<Board>(`/v1/leaderboards?exercise=${exercise}`),
        apiRequest<Progress>('/v1/me/progress'),
      ]);
      setBoard(nextBoard); setProgress(nextProgress);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Leaderboard is unavailable right now.');
    } finally { setLoading(false); }
  }, [exercise]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const ownRating = progress?.ratings.find((item) => item.exercise === exercise);

  return <Page>
    <View style={{ gap: 8 }}><Eyebrow>SEASON LEADERBOARD</Eyebrow><TextBlock variant="title">Progress, exercise by exercise.</TextBlock></View>
    <View style={styles.selector}>
      <ActionButton title="Push-ups" tone={exercise === 'push_up' ? 'secondary' : 'quiet'} onPress={() => setExercise('push_up')} style={styles.selectButton} />
      <ActionButton title="Pull-ups" tone={exercise === 'pull_up' ? 'secondary' : 'quiet'} onPress={() => setExercise('pull_up')} style={styles.selectButton} />
    </View>
    {board?.season ? <Card style={styles.seasonCard}>
      <View style={{ flex: 1, gap: 3 }}><TextBlock variant="label">{board.season.name.toUpperCase()}</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>Eight-week season · separate {exercise === 'push_up' ? 'push-up' : 'pull-up'} rating</TextBlock></View>
      {ownRating ? <View style={{ alignItems: 'flex-end' }}><TextBlock variant="section">{ownRating.rating}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>{ownRating.eligible ? `Rank #${board.ownRank ?? '—'}` : `${ownRating.played} of 5 placements`}</TextBlock></View> : null}
    </Card> : null}
    {loading ? <Card><TextBlock variant="section">Loading season standings…</TextBlock></Card> : null}
    {!loading && !signedIn ? <Card style={styles.empty}>
      <MovementArt exercise={exercise} /><TextBlock variant="section" style={{ textAlign: 'center' }}>Sign in to see your season board.</TextBlock>
      <TextBlock style={{ color: theme.secondary, textAlign: 'center' }}>Rankings appear when the online service is connected. Practice remains available without an account.</TextBlock>
      <ActionButton title="Sign in" onPress={() => router.push('/auth')} />
    </Card> : null}
    {!loading && signedIn && error ? <Card style={styles.empty}>
      <MovementArt exercise={exercise} /><TextBlock variant="section" style={{ textAlign: 'center' }}>Leaderboard unavailable</TextBlock>
      <TextBlock accessibilityRole="alert" style={{ color: theme.secondary, textAlign: 'center' }}>{error}</TextBlock>
      <ActionButton title="Try again" onPress={() => void load()} />
    </Card> : null}
    {!loading && !error && board && !board.season ? <Card style={styles.empty}>
      <MovementArt exercise={exercise} /><TextBlock variant="section" style={{ textAlign: 'center' }}>Between seasons</TextBlock>
      <TextBlock style={{ color: theme.secondary, textAlign: 'center' }}>The next eight-week season has not opened yet. No ratings are shown as current.</TextBlock>
    </Card> : null}
    {!loading && !error && board?.season && board.rows.length === 0 ? <Card style={styles.empty}>
      <MovementArt exercise={exercise} /><TextBlock variant="section" style={{ textAlign: 'center' }}>No placed players yet</TextBlock>
      <TextBlock style={{ color: theme.secondary, textAlign: 'center' }}>{ownRating ? 'Complete 5 ranked matches against at least 3 different opponents to qualify for the board.' : 'Complete ranked matches to begin your placement.'}</TextBlock>
    </Card> : null}
    {!loading && board?.rows.length ? <Card style={styles.rows}>
      <View style={styles.tableHeader}><TextBlock variant="caption" style={{ color: theme.secondary }}>RANK · PLAYER</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>RATING · PLAYED</TextBlock></View>
      {board.rows.map((row) => <View key={`${row.rank}-${row.displayName}-${row.rating}`} style={[styles.row, { borderTopColor: theme.border, backgroundColor: row.isSelf ? theme.tint : 'transparent' }]}>
        <View style={styles.player}><TextBlock variant="label" style={{ width: 34 }}>#{row.rank}</TextBlock><View style={[styles.avatar, { backgroundColor: theme.tint }]}><TextBlock variant="label">{row.avatarId.slice(-2).toUpperCase()}</TextBlock></View>
          <View style={{ flex: 1 }}><TextBlock variant="label">{row.displayName}{row.isSelf ? ' · YOU' : ''}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>{row.played} ranked matches</TextBlock></View></View>
        <View style={{ alignItems: 'flex-end' }}><TextBlock variant="label">{row.rating}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>rating</TextBlock></View>
      </View>)}
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Standings fetched {new Date(board.cachedAt).toLocaleString()}. Equal ratings share a rank.</TextBlock>
    </Card> : null}
    {signedIn ? <ActionButton title="Refresh standings" tone="quiet" disabled={loading} onPress={() => void load()} /> : null}
  </Page>;
}

const styles = StyleSheet.create({ selector: { flexDirection: 'row', gap: 8 }, selectButton: { flex: 1 },
  seasonCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  empty: { alignItems: 'center', paddingVertical: 30, gap: 14 }, rows: { gap: 0 }, tableHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingBottom: 10 },
  row: { borderTopWidth: 1, paddingVertical: 11, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  player: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 }, avatar: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, });
