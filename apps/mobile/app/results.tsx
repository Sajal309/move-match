import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { MovementArt } from '../src/MovementArt';
import type { Exercise } from '@move-match/rep-engine';
import { useAppTheme } from '../src/theme';

export default function ResultsScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; reps?: string; ruleVersion?: string; mode?: string; onlineSynced?: string; xpAwarded?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  const reps = Math.max(0, Number.parseInt(params.reps ?? '0', 10) || 0);
  const xpAwarded = Math.max(0, Number.parseInt(params.xpAwarded ?? '0', 10) || 0);
  return <Page contentStyle={styles.page}>
    <View style={styles.heading}><Eyebrow>OFFLINE PRACTICE · RESULT</Eyebrow><TextBlock variant="display">Round complete.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Your practice result is saved on this phone. No rating or online reward was applied.</TextBlock></View>
    <Card style={styles.resultCard}>
      <MovementArt exercise={exercise} />
      <TextBlock variant="section">{exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'}</TextBlock>
      <TextBlock accessibilityLabel={`${reps} app-standard repetitions`} variant="display" style={styles.score}>{reps}</TextBlock>
      <TextBlock variant="label">APP-STANDARD REPS · 45 SECONDS</TextBlock>
      <View style={[styles.divider, { backgroundColor: theme.border }]} />
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Counting rule: {params.ruleVersion ?? 'unavailable'}</TextBlock>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Pose estimates can miss valid repetitions or count an invalid one. The count is a practice aid, not a certified result.</TextBlock>
      {params.onlineSynced === 'true' ? <TextBlock variant="label">Practice synced to your account{xpAwarded > 0 ? ` · +${xpAwarded} XP` : ' · today’s practice XP already claimed'}</TextBlock>
        : <TextBlock variant="caption" style={{ color: theme.secondary }}>This round stays local. Sign in and sync a qualifying online session to earn the once-daily practice reward.</TextBlock>}
    </Card>
    <ActionButton title="Back to Play" onPress={() => router.replace('/(tabs)')} />
    <ActionButton title="Practice again" tone="secondary" onPress={() => router.replace({ pathname: '/setup', params: { exercise } })} />
  </Page>;
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: 'center' },
  heading: { gap: 8 },
  resultCard: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  score: { fontVariant: ['tabular-nums'] },
  divider: { alignSelf: 'stretch', height: 1, marginVertical: 8 },
});
