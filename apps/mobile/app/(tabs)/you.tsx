import React, { useCallback, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Page, TextBlock, Card, ActionButton, Eyebrow } from '../../src/ui';
import { useAppTheme } from '../../src/theme';
import { getPracticeHistory } from '../../src/storage';
import type { LocalPracticeSession } from '../../src/storage';
import { currentAccount } from '../../src/account';
import { apiRequest } from '../../src/api';
import type { Exercise } from '@move-match/rep-engine';

type Progress = { profile: { displayName: string; avatarId: string; totalXp: number; level: number } | null;
  ratings: Array<{ exercise: Exercise; rating: number; played: number; eligible: boolean; season: string }>;
  badges: Array<{ badgeKey: string; awardedAt: string }>; weeklyActiveDays: number };
type MatchHistoryItem = { matchId: string; mode: 'friend' | 'ranked'; exercise: Exercise; createdAt: string;
  outcome: string | null; scorePlayer1: number | null; scorePlayer2: number | null; mySlot: number; opponentName: string | null };

export default function YouScreen() {
  const { theme } = useAppTheme();
  const [sessions, setSessions] = useState<LocalPracticeSession[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [message, setMessage] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const refresh = useCallback(async () => {
    const [local] = await Promise.all([getPracticeHistory().catch(() => [] as LocalPracticeSession[])]);
    setSessions(local);
    const account = await currentAccount();
    setSignedIn(Boolean(account));
    if (!account) { setProgress(null); setMatches([]); return; }
    try {
      const [nextProgress, history] = await Promise.all([
        apiRequest<Progress>('/v1/me/progress'),
        apiRequest<{ items: MatchHistoryItem[] }>('/v1/me/history?limit=10'),
      ]);
      setProgress(nextProgress); setMatches(history.items); setNameDraft(nextProgress.profile?.displayName ?? ''); setMessage('');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Online profile is unavailable.'); }
  }, []);
  useFocusEffect(useCallback(() => {
    let alive = true;
    void refresh().catch(() => undefined);
    return () => { alive = false; };
  }, [refresh]));
  const totalReps = sessions.reduce((sum, session) => sum + session.reps, 0);
  const saveName = async () => {
    setSavingName(true); setMessage('');
    try {
      await apiRequest('/v1/me', { method: 'PATCH', body: JSON.stringify({ displayName: nameDraft }) });
      setEditingName(false); await refresh(); setMessage('Display name updated.');
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not update your display name.'); }
    finally { setSavingName(false); }
  };
  return <Page>
    <View style={styles.heading}><Eyebrow>YOUR SPACE</Eyebrow><TextBlock variant="title">Every session adds up.</TextBlock></View>
    <Card style={styles.profile}>
      <View style={[styles.avatar, { backgroundColor: theme.tint }]}><TextBlock variant="title">{progress?.profile?.avatarId.slice(-2).toUpperCase() ?? 'M'}</TextBlock></View>
      <View style={{ flex: 1, gap: 3 }}><TextBlock variant="section">{progress?.profile?.displayName ?? (signedIn ? 'Account connected' : 'Guest player')}</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>{signedIn ? 'Separate push-up and pull-up ratings' : 'Local practice · no rating'}</TextBlock></View>
      <TextBlock variant="label">{signedIn ? 'ONLINE' : 'LOCAL'}</TextBlock>
    </Card>
    {signedIn ? <>
      <Card style={styles.progressCard}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><TextBlock variant="section">Level {progress?.profile?.level ?? 1}</TextBlock><TextBlock variant="label">{progress?.profile?.totalXp ?? 0} XP</TextBlock></View>
        <View style={[styles.progressTrack, { backgroundColor: theme.border }]}><View style={[styles.progressFill, { backgroundColor: theme.primary, width: `${(progress?.profile?.totalXp ?? 0) % 100}%` }]} /></View>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>Next level in {100 - ((progress?.profile?.totalXp ?? 0) % 100)} XP · {progress?.weeklyActiveDays ?? 0} of 3 active days this UTC week</TextBlock>
      </Card>
      <Card style={styles.ratings}>
        <TextBlock variant="section">Season ratings</TextBlock>
        {(['push_up', 'pull_up'] as Exercise[]).map((exercise) => {
          const rating = progress?.ratings.find((entry) => entry.exercise === exercise);
          return <View key={exercise} style={[styles.ratingRow, { borderTopColor: theme.border }]}>
            <View style={{ flex: 1 }}><TextBlock variant="label">{exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'}</TextBlock>
              <TextBlock variant="caption" style={{ color: theme.secondary }}>{rating?.season ?? 'No active season'}</TextBlock></View>
            <View style={{ alignItems: 'flex-end' }}><TextBlock variant="label">{rating?.rating ?? '—'}</TextBlock>
              <TextBlock variant="caption" style={{ color: theme.secondary }}>{rating ? rating.eligible ? 'Placed' : `${rating.played} of 5 placements` : 'No ranked matches'}</TextBlock></View>
          </View>;
        })}
      </Card>
      <Card style={{ gap: 9 }}><TextBlock variant="section">Badges</TextBlock>
        {progress?.badges.length ? <View style={styles.badges}>{progress.badges.map((badge) => <View key={badge.badgeKey} style={[styles.badge, { backgroundColor: theme.tint }]}>
          <TextBlock variant="caption">{badge.badgeKey.replaceAll('_', ' ')}</TextBlock></View>)}</View>
          : <TextBlock style={{ color: theme.secondary }}>Earn badges through completed matches and weekly consistency.</TextBlock>}
      </Card>
      <Card style={{ gap: 8 }}><TextBlock variant="section">Display name</TextBlock>
        {editingName ? <><TextInput accessibilityLabel="Display name" value={nameDraft} onChangeText={setNameDraft} maxLength={20} autoCapitalize="words"
          placeholder="3–20 characters" placeholderTextColor={theme.secondary}
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]} />
          <ActionButton title={savingName ? 'Saving…' : 'Save display name'} disabled={savingName} onPress={() => void saveName()} />
          <ActionButton title="Cancel" tone="quiet" onPress={() => { setEditingName(false); setNameDraft(progress?.profile?.displayName ?? ''); }} /></>
          : <ActionButton title="Edit display name" tone="secondary" onPress={() => setEditingName(true)} />}
      </Card>
      <Card style={{ gap: 6 }}><TextBlock variant="section">Recent matches</TextBlock>
        {matches.length ? matches.slice(0, 8).map((match) => {
          const ownScore = match.mySlot === 1 ? match.scorePlayer1 : match.scorePlayer2;
          const rivalScore = match.mySlot === 1 ? match.scorePlayer2 : match.scorePlayer1;
          return <View key={match.matchId} style={[styles.historyRow, { borderTopColor: theme.border }]}>
            <View style={{ flex: 1 }}><TextBlock variant="label">{match.exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'} · {match.outcome?.replaceAll('_', ' ') ?? 'pending'}</TextBlock>
              <TextBlock variant="caption" style={{ color: theme.secondary }}>{match.opponentName ?? 'Practice partner'} · {new Date(match.createdAt).toLocaleDateString()} · {match.mode}</TextBlock></View>
            <TextBlock variant="label">{ownScore ?? '—'}–{rivalScore ?? '—'}</TextBlock>
          </View>;
        }) : <TextBlock style={{ color: theme.secondary }}>Settled friend and ranked matches will appear here.</TextBlock>}
      </Card>
    </> : null}
    <View style={styles.stats}>
      <Card style={styles.stat}><TextBlock variant="display">{sessions.length}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>LOCAL PRACTICE ROUNDS</TextBlock></Card>
      <Card style={styles.stat}><TextBlock variant="display">{totalReps}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>PRACTICE REPS</TextBlock></Card>
    </View>
    <Card style={{ gap: 8 }}><TextBlock variant="section">Recent practice</TextBlock>
      {sessions.length === 0 ? <TextBlock style={{ color: theme.secondary }}>Local practice history is saved only on this phone.</TextBlock> : sessions.slice(0, 8).map((item) =>
        <View key={item.id} style={[styles.historyRow, { borderTopColor: theme.border }]}>
          <View style={{ flex: 1 }}><TextBlock variant="label">{item.exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'} · {item.reps} reps</TextBlock>
            <TextBlock variant="caption" style={{ color: theme.secondary }}>{new Date(item.finishedAt).toLocaleDateString()} · {Math.round(item.durationMs / 1000)} sec</TextBlock></View>
          <TextBlock variant="caption" style={{ color: theme.secondary }}>{item.ruleVersion}</TextBlock>
        </View>)}
    </Card>
    {message ? <TextBlock accessibilityLiveRegion="polite" style={{ color: theme.secondary }}>{message}</TextBlock> : null}
    <ActionButton title="Blocked players" tone="secondary" onPress={() => router.push('/blocks')} />
    <ActionButton title="Settings" tone="secondary" onPress={() => router.push('/settings')} />
    <ActionButton title="Privacy and camera" tone="quiet" onPress={() => router.push('/privacy')} />
  </Page>;
}

const styles = StyleSheet.create({ heading: { gap: 8 }, profile: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  progressCard: { gap: 10 }, progressTrack: { height: 7, borderRadius: 6, overflow: 'hidden' }, progressFill: { height: 7, borderRadius: 6 },
  ratings: { gap: 8 }, ratingRow: { borderTopWidth: 1, paddingTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, badge: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
  input: { minHeight: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 },
  stats: { flexDirection: 'row', gap: 10 }, stat: { flex: 1, padding: 16, gap: 6 },
  historyRow: { borderTopWidth: 1, paddingTop: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }, });
