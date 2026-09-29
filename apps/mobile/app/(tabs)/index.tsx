import React, { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { Page, TextBlock, Card, ActionButton, Eyebrow } from '../../src/ui';
import { MovementArt } from '../../src/MovementArt';
import { useAppTheme } from '../../src/theme';
import { getPracticeHistory } from '../../src/storage';
import type { Exercise } from '@move-match/rep-engine';
import { authConfigured, currentAccount } from '../../src/account';
import { apiRequest } from '../../src/api';

type ServiceConfig = { flags: Record<string, boolean>; rules: Array<{ exercise: Exercise; enabled: boolean }>; season: { id: string; name: string } | null };

function MoveChoice({ exercise, title, description, best, selected, onSelect }: {
  exercise: Exercise; title: string; description: string; best: number; selected: boolean; onSelect: () => void;
}) {
  const { theme } = useAppTheme();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onSelect}
    style={[styles.moveCard, selected && { borderColor: theme.primary, borderWidth: 2 }]}> 
    <View style={[styles.moveCardInner, { backgroundColor: theme.surface, borderColor: selected ? theme.primary : theme.border }]}>
      <View style={styles.moveArt}><MovementArt exercise={exercise} /></View>
      <View style={styles.moveInfo}>
        <TextBlock variant="section">{title}</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>{description}</TextBlock>
        <TextBlock variant="label" style={{ marginTop: 4 }}>Local practice best  ·  {best}</TextBlock>
      </View>
      <TextBlock variant="title" style={{ color: selected ? theme.tealText : theme.secondary }}>{selected ? '✓' : '›'}</TextBlock>
    </View>
  </Pressable>;
}

export default function PlayHome() {
  const { theme } = useAppTheme();
  const [exercise, setExercise] = useState<Exercise>('push_up');
  const [bests, setBests] = useState<Record<Exercise, number>>({ push_up: 0, pull_up: 0 });
  const [weeklyDays, setWeeklyDays] = useState(0);
  const [signedIn, setSignedIn] = useState(false);
  const [serviceConfig, setServiceConfig] = useState<ServiceConfig | null>(null);
  useFocusEffect(useCallback(() => {
    let alive = true;
    void currentAccount().then((user) => { if (alive) setSignedIn(Boolean(user)); });
    void apiRequest<ServiceConfig>('/v1/config').then((value) => { if (alive) setServiceConfig(value); })
      .catch(() => { if (alive) setServiceConfig(null); });
    void getPracticeHistory().then((history) => {
      const next: Record<Exercise, number> = { push_up: 0, pull_up: 0 };
      for (const session of history) next[session.exercise] = Math.max(next[session.exercise], session.reps);
      const now = new Date();
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
      const activeDays = new Set(history.filter((session) => new Date(session.finishedAt) >= monday)
        .map((session) => session.finishedAt.slice(0, 10)));
      if (alive) { setBests(next); setWeeklyDays(Math.min(3, activeDays.size)); }
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []));

  const startOnline = async (action: 'friend' | 'quick_match') => {
    let config: ServiceConfig;
    try { config = await apiRequest<ServiceConfig>('/v1/config'); setServiceConfig(config); }
    catch { return router.push({ pathname: '/online-unavailable', params: { action, exercise } }); }
    const supportedRule = config.rules.some((rule) => rule.exercise === exercise && rule.enabled);
    const enabled = action === 'friend' ? config.flags.friend_matches_enabled && supportedRule
      : config.flags.quick_match_enabled && config.flags[`ranked_${exercise}_enabled`] && supportedRule && config.season !== null;
    if (!enabled) return router.push({ pathname: '/online-unavailable', params: { action, exercise } });
    if (!authConfigured) return router.push({ pathname: '/online-unavailable', params: { action, exercise } });
    const user = await currentAccount();
    if (!user) return router.push({ pathname: '/auth', params: { action, exercise } });
    if (action === 'friend') router.push({ pathname: '/friend', params: { exercise } });
    else router.push({ pathname: '/setup', params: { exercise, mode: 'ranked' } });
  };
  const supportedRule = serviceConfig?.rules.some((rule) => rule.exercise === exercise && rule.enabled) ?? false;
  const quickMatchAvailable = Boolean(serviceConfig?.flags.quick_match_enabled && serviceConfig?.flags[`ranked_${exercise}_enabled`] && supportedRule && serviceConfig?.season);

  return <Page>
    <View style={styles.topRow}>
      <View style={{ gap: 4 }}><Eyebrow>WELCOME BACK</Eyebrow><TextBlock variant="title">One good round?</TextBlock></View>
      <View style={[styles.levelBadge, { backgroundColor: theme.tint }]}><TextBlock variant="label">{signedIn ? 'ACCOUNT' : 'GUEST · LOCAL'}</TextBlock></View>
    </View>
    <Card style={styles.weekCard}>
      <View style={styles.weekRow}><TextBlock variant="label">LOCAL PRACTICE DAYS THIS WEEK</TextBlock><TextBlock variant="label" style={{ color: theme.tealText }}>{weeklyDays} of 3</TextBlock></View>
      <View style={[styles.progressTrack, { backgroundColor: theme.border }]}><View style={[styles.progressValue, { backgroundColor: theme.primary, width: `${Math.round(weeklyDays / 3 * 100)}%` }]} /></View>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Three separate practice days is a helpful weekly goal. This local count is not an online reward.</TextBlock>
    </Card>
    <View style={styles.sectionHeading}><TextBlock variant="section">Pick a movement</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>45 second round</TextBlock></View>
    <MoveChoice exercise="push_up" title="Push-ups" description="Standard floor push-ups" best={bests.push_up} selected={exercise === 'push_up'} onSelect={() => setExercise('push_up')} />
    <MoveChoice exercise="pull_up" title="Pull-ups" description="Unweighted, calibrated bar line" best={bests.pull_up} selected={exercise === 'pull_up'} onSelect={() => setExercise('pull_up')} />
    <View style={styles.actions}>
      <ActionButton title="Practice" onPress={() => router.push({ pathname: '/setup', params: { exercise } })} />
      <ActionButton title="Challenge a friend" tone="secondary" onPress={() => void startOnline('friend')} />
      <ActionButton title="Quick match" tone="quiet" onPress={() => void startOnline('quick_match')} />
    </View>
    <View style={[styles.availability, { borderColor: theme.border }]}>
      <View style={[styles.statusDot, { backgroundColor: quickMatchAvailable ? theme.primary : theme.warning }]} />
      <TextBlock variant="caption" style={{ color: theme.secondary }}>{quickMatchAvailable
        ? `Ranked ${exercise === 'push_up' ? 'push-ups' : 'pull-ups'} available · live queue supply changes` : 'Ranked unavailable for this movement · no sample players'}</TextBlock>
    </View>
  </Page>;
}

const styles = StyleSheet.create({
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  levelBadge: { paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999 },
  weekCard: { gap: 10 },
  weekRow: { flexDirection: 'row', justifyContent: 'space-between' },
  progressTrack: { height: 7, borderRadius: 6, overflow: 'hidden' },
  progressValue: { height: 7, borderRadius: 6 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: -8 },
  moveCard: { borderRadius: 16 },
  moveCardInner: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 12, borderWidth: 1, borderRadius: 16 },
  moveArt: { width: 98, height: 82, alignItems: 'center', justifyContent: 'center' },
  moveInfo: { flex: 1, gap: 2 },
  actions: { gap: 8, paddingTop: 2 },
  availability: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 12, padding: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});
