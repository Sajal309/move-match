import React, { useState } from 'react';
import { router } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { Page, TextBlock, ActionButton, Card, Eyebrow } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { palette, spacing } from '@move-match/design-tokens';

export default function WelcomeScreen() {
  const { theme } = useAppTheme();
  const [isAdult, setIsAdult] = useState<boolean | null>(null);
  return <Page contentStyle={styles.content}>
    <View style={styles.brandRow}>
      <View style={[styles.brandMark, { backgroundColor: theme.primary }]}><View style={[styles.brandMarkDot, { backgroundColor: theme.primaryText }]} /></View>
      <TextBlock variant="label" style={styles.wordmark}>MOVE / MATCH</TextBlock>
    </View>
    <View style={styles.hero}>
      <Eyebrow>SHORT ROUNDS. REAL REPS.</Eyebrow>
      <TextBlock variant="display">Make your next rep a match.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Pick a movement. Find your match. Make every rep count.</TextBlock>
    </View>
    <Card style={{ backgroundColor: theme.tint, borderColor: theme.border }}>
      <TextBlock variant="section">Your camera stays yours</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Pose tracking runs on this device. The other player sees your score and avatar, never your camera or microphone.</TextBlock>
    </Card>
    <View style={styles.ageBox}>
      <TextBlock variant="label">MOVE / MATCH is designed for adults 18 and older.</TextBlock>
      <View style={styles.ageActions}>
        <ActionButton title={isAdult === true ? '✓  I’m 18 or older' : 'I’m 18 or older'} tone={isAdult === true ? 'secondary' : 'quiet'} onPress={() => setIsAdult(true)} style={styles.ageButton} />
        <ActionButton title={isAdult === false ? '✓  Under 18' : 'Under 18'} tone={isAdult === false ? 'secondary' : 'quiet'} onPress={() => setIsAdult(false)} style={styles.ageButton} />
      </View>
      <TextBlock variant="caption" style={{ color: theme.secondary }}>Under 18? You can browse. Online accounts and matches are unavailable.</TextBlock>
    </View>
    <View style={styles.actions}>
      <ActionButton title="Try practice" onPress={() => router.push('/(tabs)')} />
      <ActionButton title="Sign in" tone="quiet" onPress={() => router.push('/auth')} />
      <ActionButton title="Read privacy details" tone="quiet" onPress={() => router.push('/privacy')} />
    </View>
    <TextBlock variant="caption" style={{ color: theme.secondary, textAlign: 'center' }}>
      You can browse without creating an account. We ask for camera access only when you open a practice setup.
    </TextBlock>
  </Page>;
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', paddingTop: 36, paddingBottom: 40, gap: spacing.xl },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 31, height: 31, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  brandMarkDot: { width: 9, height: 9, borderRadius: 5 },
  wordmark: { letterSpacing: 1.2 },
  hero: { gap: spacing.md, maxWidth: 420 },
  ageBox: { gap: 8 },
  ageActions: { flexDirection: 'row', gap: 8 },
  ageButton: { flex: 1, paddingHorizontal: 8 },
  actions: { gap: 8 },
});
