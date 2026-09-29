import React, { useState } from 'react';
import { Alert, Linking, Share, StyleSheet, Switch, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { currentAccount, signOut } from '../src/account';
import { API_URL, apiRequest } from '../src/api';
import { getPreferences, updatePreferences, LocalPreferences } from '../src/preferences';

export default function SettingsScreen() {
  const { theme, mode, setMode, reducedMotionOverride, setReducedMotionOverride } = useAppTheme();
  const [preferences, setPreferences] = useState<LocalPreferences | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useFocusEffect(React.useCallback(() => {
    let alive = true;
    void getPreferences().then((value) => { if (alive) setPreferences(value); });
    void currentAccount().then((user) => { if (alive) setSignedIn(Boolean(user)); });
    return () => { alive = false; };
  }, []));

  const change = async (patch: Partial<LocalPreferences>) => {
    const next = await updatePreferences(patch);
    setPreferences(next);
    if (patch.theme) setMode(patch.theme);
    if (Object.prototype.hasOwnProperty.call(patch, 'reducedMotion')) setReducedMotionOverride(patch.reducedMotion ?? null);
    if (Object.prototype.hasOwnProperty.call(patch, 'analyticsOptIn') && signedIn) {
      try { await apiRequest('/v1/me', { method: 'PATCH', body: JSON.stringify({ analyticsOptIn: next.analyticsOptIn }) }); }
      catch (error) { setMessage(`Saved on this device. Account sync is unavailable: ${error instanceof Error ? error.message : 'try again later.'}`); }
    }
  };
  const exportData = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await apiRequest<{ status?: string; data?: unknown }>('/v1/me/export', { method: 'POST', body: JSON.stringify({}) });
      if (result.status === 'ready' && result.data) {
        await Share.share({ title: 'MOVE / MATCH data export', message: JSON.stringify(result.data, null, 2) });
        setMessage('Your account export was shared using the system share sheet.');
      } else setMessage('The service did not return an export file.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not request an export.'); }
    finally { setBusy(false); }
  };
  const deleteAccount = () => Alert.alert('Request account deletion?',
    'This starts deletion of your online profile and match-linked personal data. The request cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete account', style: 'destructive', onPress: () => {
        setBusy(true);
        void apiRequest<{ status?: string }>('/v1/me', { method: 'DELETE', body: JSON.stringify({ confirmation: 'DELETE' }) })
          .then(async () => { await signOut(); setSignedIn(false); setMessage('Deletion request accepted. You are signed out.'); })
          .catch((error) => setMessage(error instanceof Error ? error.message : 'Could not request deletion.'))
          .finally(() => setBusy(false));
      } },
    ]);
  const signOutNow = async () => {
    setBusy(true);
    try { await signOut(); setSignedIn(false); setMessage('You are signed out. Local practice history remains on this device.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not sign out.'); }
    finally { setBusy(false); }
  };

  return <Page>
    <View style={styles.heading}><Eyebrow>SETTINGS</Eyebrow><TextBlock variant="title">Make it yours.</TextBlock></View>
    <Card>
      <TextBlock variant="section">Appearance</TextBlock>
      <View style={styles.row}>
        {(['system', 'light', 'dark'] as const).map((value) => <ActionButton key={value}
          title={`${mode === value ? '✓ ' : ''}${value[0].toUpperCase()}${value.slice(1)}`}
          tone={mode === value ? 'secondary' : 'quiet'} style={styles.choice} onPress={() => void change({ theme: value })} />)}
      </View>
      <View style={styles.preferenceRow}><View style={styles.preferenceText}><TextBlock variant="label">Reduced motion</TextBlock>
        <TextBlock variant="caption" style={{ color: theme.secondary }}>System default{reducedMotionOverride === null ? ' · active' : ''}</TextBlock></View>
        <ActionButton title={reducedMotionOverride === null ? 'System' : reducedMotionOverride ? 'On' : 'Off'} tone="quiet" onPress={() => {
          const next = reducedMotionOverride === null ? true : reducedMotionOverride ? false : null;
          void change({ reducedMotion: next });
        }} />
      </View>
    </Card>
    <Card>
      <TextBlock variant="section">Practice feedback</TextBlock>
      {preferences ? <>
        <Preference label="Haptic cue every 5 reps" description="A short vibration for practice milestones." value={preferences.haptics} theme={theme}
          onChange={(value) => void change({ haptics: value })} />
        <Preference label="Spoken rep count" description="Announce practice reps at useful intervals." value={preferences.spokenCount} theme={theme}
          onChange={(value) => void change({ spokenCount: value })} />
        <Preference label="Allow anonymous usage analytics" description="Off by default. No camera or pose data is included; analytics collection is not connected in this build." value={preferences.analyticsOptIn} theme={theme}
          onChange={(value) => void change({ analyticsOptIn: value })} />
      </> : <TextBlock variant="caption" style={{ color: theme.secondary }}>Loading preferences…</TextBlock>}
    </Card>
    <Card>
      <TextBlock variant="section">Account and privacy</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>{signedIn ? 'Email account connected · credentials stored with the platform secure storage.' : 'Guest mode · local practice history stays on this device.'}</TextBlock>
      {signedIn ? <>
        <ActionButton title={busy ? 'Working…' : 'Export my data'} tone="secondary" disabled={busy} onPress={() => void exportData()} />
        <ActionButton title={busy ? 'Working…' : 'Delete account'} tone="danger" disabled={busy} onPress={deleteAccount} />
        <ActionButton title={busy ? 'Working…' : 'Sign out'} tone="quiet" disabled={busy} onPress={() => void signOutNow()} />
      </> : <ActionButton title="Sign in" tone="secondary" onPress={() => router.push('/auth')} />}
      <ActionButton title="Privacy and camera details" tone="quiet" onPress={() => router.push('/privacy')} />
      <ActionButton title="Blocked players" tone="quiet" onPress={() => router.push('/blocks')} />
      {signedIn && API_URL ? <ActionButton title="External account deletion request page" tone="quiet" onPress={() => void Linking.openURL(`${API_URL}/account-deletion`)
        .catch(() => setMessage('Could not open the deletion request page.'))} /> : null}
      <ActionButton title="Clear local practice history" tone="quiet" onPress={() => Alert.alert('Clear local history?', 'This removes practice sessions stored on this phone.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Clear history', style: 'destructive', onPress: async () => {
          const { clearPracticeHistory } = await import('../src/storage');
          await clearPracticeHistory(); setMessage('Local practice history cleared.');
        } },
      ])} />
    </Card>
    {message ? <TextBlock accessibilityLiveRegion="polite" style={{ color: theme.secondary }}>{message}</TextBlock> : null}
    <TextBlock variant="caption" style={{ color: theme.secondary }}>Reports, blocks, export and deletion requests use the online service when it is configured. Publisher support details and the public deletion page still require setup before release.</TextBlock>
  </Page>;
}

function Preference({ label, description, value, theme, onChange }: {
  label: string; description: string; value: boolean; theme: ReturnType<typeof useAppTheme>['theme']; onChange: (value: boolean) => void;
}) {
  return <View style={styles.preferenceRow}>
    <View style={styles.preferenceText}><TextBlock variant="label">{label}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>{description}</TextBlock></View>
    <Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: theme.primary }} />
  </View>;
}

const styles = StyleSheet.create({ heading: { gap: 8 }, row: { flexDirection: 'row', gap: 5 }, choice: { flex: 1, paddingHorizontal: 4, minHeight: 46 },
  preferenceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 }, preferenceText: { flex: 1, gap: 3 } });
