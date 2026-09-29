import React, { useState } from 'react';
import { Alert, StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { authConfigured, requestEmailCode, setAdultEligibility, syncAdultProfile, verifyEmailCode } from '../src/account';

export default function AuthScreen() {
  const { theme } = useAppTheme();
  const params = useLocalSearchParams<{ action?: string; exercise?: string }>();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [adult, setAdult] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const sendCode = async () => {
    if (!adult) { setError('Online accounts are available to adults 18 and older.'); return; }
    if (!acceptedPrivacy) { setError('Review the privacy and camera details before continuing.'); return; }
    if (!email.includes('@')) { setError('Enter a valid email address.'); return; }
    setBusy(true); setError('');
    try {
      await setAdultEligibility('confirmed');
      await requestEmailCode(email);
      setCodeSent(true);
      setInfo('Check your inbox for a one-time sign-in code.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not send a code. Try again.'); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the six-digit code from your email.'); return; }
    setBusy(true); setError(''); setInfo('');
    try {
      await verifyEmailCode(email, code);
      try { await syncAdultProfile(); setInfo('Your adult account profile is ready.'); }
      catch (reason) { setInfo(`Email verified and securely saved on this device. Online profile setup is not reachable yet: ${reason instanceof Error ? reason.message : 'service unavailable'}`); setVerified(true); return; }
      setVerified(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That code did not work. Request another and try again.'); }
    finally { setBusy(false); }
  };

  return <Page contentStyle={styles.page}>
    <View style={styles.heading}><Eyebrow>EMAIL SIGN IN</Eyebrow><TextBlock variant="title">Keep your account yours.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Use a one-time code. There is no password to reuse. Online matches will require an eligible adult account.</TextBlock></View>
    {!authConfigured ? <Card style={{ backgroundColor: theme.tint }}>
      <TextBlock variant="section">Authentication is not configured</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Add the Supabase project URL and publishable key to the mobile environment. These are client settings only; never put a service-role key in the app.</TextBlock>
    </Card> : null}
    {verified ? <Card>
      <TextBlock variant="section">Email verified</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>{info || 'Your account is ready. Online matches are still unavailable in this build.'}</TextBlock>
      <ActionButton title="Continue" onPress={() => params.action
        ? params.action === 'friend'
          ? router.replace({ pathname: '/friend', params: { exercise: params.exercise } })
          : params.action === 'quick_match'
            ? router.replace({ pathname: '/setup', params: { mode: 'ranked', exercise: params.exercise } })
            : router.replace({ pathname: '/online-unavailable', params: { action: params.action, exercise: params.exercise } })
        : router.replace('/(tabs)')} />
    </Card> : <View style={styles.form}>
      <TextBlock variant="label">Email address</TextBlock>
      <TextInput accessibilityLabel="Email address" autoCapitalize="none" autoComplete="email" keyboardType="email-address"
        value={email} onChangeText={setEmail} editable={!codeSent && !busy}
        placeholder="you@example.com" placeholderTextColor={theme.secondary}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]} />
      {!codeSent ? <>
        <ActionButton title={adult ? '✓  I’m 18 or older' : 'Confirm I’m 18 or older'} tone={adult ? 'secondary' : 'quiet'} onPress={() => setAdult((value) => !value)} />
        <ActionButton title="Read privacy and camera details" tone="quiet" onPress={() => router.push('/privacy')} />
        <ActionButton title={acceptedPrivacy ? '✓  I reviewed privacy details' : 'I have reviewed privacy details'} tone={acceptedPrivacy ? 'secondary' : 'quiet'} onPress={() => setAcceptedPrivacy((value) => !value)} />
        <TextBlock variant="caption" style={{ color: theme.secondary }}>We ask for an adult eligibility confirmation, not your full date of birth. Under 18? Close this screen; browsing and local practice remain available.</TextBlock>
        <ActionButton title={busy ? 'Sending…' : 'Send one-time code'} disabled={busy || !authConfigured} onPress={() => void sendCode()} />
      </> : <>
        <TextBlock variant="label">Six-digit email code</TextBlock>
        <TextInput accessibilityLabel="Six-digit email code" keyboardType="number-pad" autoComplete="one-time-code" maxLength={6}
          value={code} onChangeText={setCode} editable={!busy}
          placeholder="000000" placeholderTextColor={theme.secondary}
          style={[styles.input, styles.code, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]} />
        <ActionButton title={busy ? 'Verifying…' : 'Verify and continue'} disabled={busy} onPress={() => void verify()} />
        <ActionButton title="Send a new code" tone="quiet" disabled={busy} onPress={() => { setCodeSent(false); setInfo(''); }} />
      </>}
    </View>}
    {info ? <TextBlock accessibilityLiveRegion="polite" style={{ color: theme.secondary }}>{info}</TextBlock> : null}
    {error ? <TextBlock accessibilityRole="alert" style={{ color: theme.danger }}>{error}</TextBlock> : null}
    <ActionButton title="Continue without an account" tone="quiet" onPress={() => router.replace('/(tabs)')} />
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, justifyContent: 'center' }, heading: { gap: 8 }, form: { gap: 10 },
  input: { minHeight: 52, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 16 }, code: { fontSize: 22, letterSpacing: 5, textAlign: 'center' } });
