import React, { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { ActionButton, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';

export default function JoinFriendScreen() {
  const { theme } = useAppTheme();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const join = async () => {
    setBusy(true); setError('');
    try {
      const match = await apiRequest<{ matchId: string; sessionNonce: string; exercise: 'push_up' | 'pull_up' }>('/v1/invites/redeem', {
        method: 'POST', body: JSON.stringify({ code: code.trim().toUpperCase() }),
      });
      router.replace({ pathname: '/setup', params: { mode: 'friend_guest', matchId: match.matchId,
        sessionNonce: match.sessionNonce, exercise: match.exercise } });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not join this invite.'); }
    finally { setBusy(false); }
  };
  return <Page contentStyle={styles.page}>
    <View style={{ gap: 8 }}><Eyebrow>JOIN A FRIEND</Eyebrow><TextBlock variant="title">Enter the invite code.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Codes are single use and expire after 10 minutes. The invite identifies one unranked lobby.</TextBlock></View>
    <TextInput accessibilityLabel="8-character invite code" autoCapitalize="characters" autoCorrect={false} maxLength={12}
      value={code} onChangeText={(value) => setCode(value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase())} placeholder="ABCDEFGH"
      placeholderTextColor={theme.secondary} style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]} />
    {error ? <TextBlock accessibilityRole="alert" style={{ color: theme.danger }}>{error}</TextBlock> : null}
    <ActionButton title={busy ? 'Joining…' : 'Join lobby'} disabled={busy || code.length !== 8} onPress={() => void join()} />
    <TextBlock variant="caption" style={{ color: theme.secondary }}>If a code has expired or been used, ask your friend to create another invite.</TextBlock>
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1, justifyContent: 'center' }, input: { borderWidth: 1, borderRadius: 14,
  minHeight: 62, paddingHorizontal: 16, fontSize: 24, fontWeight: '800', letterSpacing: 5, textAlign: 'center' } });
