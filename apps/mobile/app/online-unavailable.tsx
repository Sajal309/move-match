import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import type { Exercise } from '@move-match/rep-engine';

export default function OnlineUnavailableScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string; action?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  return <Page contentStyle={styles.page}>
    <View style={styles.heading}><Eyebrow>ONLINE PLAY</Eyebrow><TextBlock variant="title">Online matches are not connected yet.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>This build has no configured matchmaking service. There are no sample opponents or simulated scores.</TextBlock></View>
    <Card>
      <TextBlock variant="section">You can still practice</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Camera setup, app-standard repetition counting and local practice history work without an account or network connection once the native development build is installed.</TextBlock>
    </Card>
    <TextBlock variant="caption" style={{ color: theme.secondary }}>Friend invites and ranked quick match require a configured API, Supabase authentication, persistent Postgres and Redis services. Ranked pull-ups also remain disabled until separate tracking evaluation is complete.</TextBlock>
    <ActionButton title="Practice this movement" onPress={() => router.replace({ pathname: '/setup', params: { exercise } })} />
    <ActionButton title="Sign in" tone="secondary" onPress={() => router.push({ pathname: '/auth', params: { action: params.action ?? 'online', exercise } })} />
    <ActionButton title="Back to Play" tone="quiet" onPress={() => router.back()} />
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, justifyContent: 'center' }, heading: { gap: 8 } });
