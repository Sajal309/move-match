import React from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import type { Exercise } from '@move-match/rep-engine';

export default function FriendScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ exercise?: string }>();
  const exercise: Exercise = params.exercise === 'pull_up' ? 'pull_up' : 'push_up';
  return <Page contentStyle={{ flexGrow: 1, justifyContent: 'center' }}>
    <Eyebrow>FRIEND CHALLENGE · UNRANKED</Eyebrow>
    <TextBlock variant="title">Make it a shared round.</TextBlock>
    <TextBlock style={{ color: theme.secondary }}>Friendly matches leave ratings unchanged. Both players set up their own camera and movement calibration.</TextBlock>
    <Card>
      <TextBlock variant="section">Create an invite</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Choose a movement, calibrate, then share a single-use code that expires after 10 minutes.</TextBlock>
      <ActionButton title={`Create invite · ${exercise === 'push_up' ? 'Push-ups' : 'Pull-ups'}`} onPress={() => router.push({ pathname: '/setup', params: { exercise, mode: 'friend_host' } })} />
    </Card>
    <Card>
      <TextBlock variant="section">Join a friend</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Enter the 8-character code your friend shared. You will calibrate before the round starts.</TextBlock>
      <ActionButton title="Enter invite code" tone="secondary" onPress={() => router.push('/join-friend')} />
    </Card>
  </Page>;
}
