import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';
import { currentAccount } from '../src/account';

type BlockedPlayer = { userId: string; displayName: string; avatarId: string; createdAt: string };

export default function BlocksScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<BlockedPlayer[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const account = await currentAccount(); setSignedIn(Boolean(account));
      if (!account) { setItems([]); return; }
      const result = await apiRequest<{ items: BlockedPlayer[] }>('/v1/blocks'); setItems(result.items);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load your block list.'); }
    finally { setLoading(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const unblock = (player: BlockedPlayer) => Alert.alert('Unblock this player?', `${player.displayName} may appear in future queues and invites.`, [
    { text: 'Keep blocked', style: 'cancel' },
    { text: 'Unblock', onPress: () => void apiRequest(`/v1/blocks/${player.userId}`, { method: 'DELETE' }).then(load)
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not unblock this player.')) },
  ]);
  return <Page>
    <View style={{ gap: 7 }}><Eyebrow>SAFETY</Eyebrow><TextBlock variant="title">Blocked players</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Blocked players cannot be paired with you or join your friend invites. Blocking does not change a settled result.</TextBlock></View>
    {!signedIn && !loading ? <Card><TextBlock variant="section">Sign in to manage blocks.</TextBlock><ActionButton title="Sign in" onPress={() => router.push('/auth')} /></Card> : null}
    {loading ? <Card><TextBlock variant="section">Loading your block list…</TextBlock></Card> : null}
    {!loading && error ? <Card><TextBlock accessibilityRole="alert" style={{ color: theme.danger }}>{error}</TextBlock><ActionButton title="Try again" tone="secondary" onPress={() => void load()} /></Card> : null}
    {!loading && signedIn && !error && items.length === 0 ? <Card><TextBlock variant="section">No blocked players</TextBlock><TextBlock style={{ color: theme.secondary }}>You can block an opponent from a match result.</TextBlock></Card> : null}
    {items.map((player) => <Card key={player.userId} style={styles.item}>
      <View style={{ flex: 1, gap: 3 }}><TextBlock variant="label">{player.displayName}</TextBlock><TextBlock variant="caption" style={{ color: theme.secondary }}>Blocked {new Date(player.createdAt).toLocaleDateString()}</TextBlock></View>
      <ActionButton title="Unblock" tone="quiet" onPress={() => unblock(player)} />
    </Card>)}
  </Page>;
}

const styles = StyleSheet.create({ item: { flexDirection: 'row', alignItems: 'center', gap: 8 } });
