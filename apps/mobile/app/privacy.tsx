import React from 'react';
import { Linking } from 'react-native';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { API_URL } from '../src/api';

export default function PrivacyScreen() {
  const { theme } = useAppTheme();
  return <Page>
    <View style={styles.heading}><Eyebrow>PRIVACY AND SAFETY</Eyebrow><TextBlock variant="title">Your movement stays on your device.</TextBlock></View>
    <Card>
      <TextBlock variant="section">Camera and pose tracking</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>The practice camera feeds the bundled pose model on your phone. The app does not record or upload camera video, audio or the full landmark stream. Local practice stores only the exercise, accepted count, duration, completion time and rule version in the app’s private database.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>The bundled model is downloaded as part of the app build. Camera access is requested only when you enter camera setup or practice. No microphone, contacts, location or photo-library permission is requested.</TextBlock>
    </Card>
    <Card>
      <TextBlock variant="section">If online play is enabled</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>An online account uses email one-time codes. A match service would receive numeric repetition summaries and timing needed to settle a score; the rival sees your display name, avatar and score, never your camera stream. Public privacy, legal, retention and account-deletion pages still need publisher review before any public release.</TextBlock>
    </Card>
    <Card style={{ backgroundColor: theme.tint }}>
      <TextBlock variant="section">Publisher policy pages are not configured</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>The service includes a public account-deletion request page, but the publisher still needs to configure a support email and deploy the service. This explanation is not a substitute for the final publisher-approved legal documents.</TextBlock>
    </Card>
    {API_URL ? <ActionButton title="Open external account-deletion page" tone="quiet" onPress={() => void Linking.openURL(`${API_URL}/account-deletion`)} /> : null}
    <ActionButton title="Account settings" tone="secondary" onPress={() => router.push('/settings')} />
    <ActionButton title="Back" tone="quiet" onPress={() => router.back()} />
  </Page>;
}

const styles = StyleSheet.create({ heading: { gap: 8 } });
