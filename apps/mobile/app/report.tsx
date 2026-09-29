import React, { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionButton, Card, Eyebrow, Page, TextBlock } from '../src/ui';
import { useAppTheme } from '../src/theme';
import { apiRequest } from '../src/api';

const categories = [
  ['offensive_name', 'Offensive display name'],
  ['suspected_cheating', 'Suspected cheating'],
  ['harassment', 'Harassment'],
  ['tracking_result', 'Tracking or result issue'],
] as const;
type Category = typeof categories[number][0];

export default function ReportScreen() {
  const { theme } = useAppTheme();
  const { matchId } = useLocalSearchParams<{ matchId?: string }>();
  const [category, setCategory] = useState<Category>('tracking_result');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try {
      await apiRequest('/v1/reports', { method: 'POST', body: JSON.stringify({ category,
        ...(matchId ? { matchId } : {}), ...(description.trim() ? { description: description.trim() } : {}) }) });
      setSubmitted(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not submit the report.'); }
    finally { setBusy(false); }
  };
  return <Page contentStyle={styles.page}>
    <View style={{ gap: 7 }}><Eyebrow>PLAYER SAFETY</Eyebrow><TextBlock variant="title">Report a concern.</TextBlock>
      <TextBlock style={{ color: theme.secondary }}>Reports are private and reviewed by the service team. Keep descriptions brief and limited to this experience.</TextBlock></View>
    {submitted ? <Card><TextBlock variant="section">Report submitted</TextBlock><TextBlock style={{ color: theme.secondary }}>Thanks. The report is in the service review queue.</TextBlock></Card> : <>
      <Card style={{ gap: 5 }}><TextBlock variant="section">What happened?</TextBlock>
        {categories.map(([value, label]) => <ActionButton key={value} title={`${category === value ? '✓  ' : ''}${label}`}
          tone={category === value ? 'secondary' : 'quiet'} onPress={() => setCategory(value)} />)}
      </Card>
      <TextInput accessibilityLabel="Optional report description" multiline maxLength={500} value={description} onChangeText={setDescription}
        placeholder="Optional details (up to 500 characters)" placeholderTextColor={theme.secondary}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.surface }]} />
      {error ? <TextBlock accessibilityRole="alert" style={{ color: theme.danger }}>{error}</TextBlock> : null}
      <ActionButton title={busy ? 'Submitting…' : 'Submit report'} disabled={busy} onPress={() => void submit()} />
    </>}
    <ActionButton title={submitted ? 'Done' : 'Cancel'} tone="quiet" onPress={() => submitted ? router.back() : router.back()} />
  </Page>;
}

const styles = StyleSheet.create({ page: { flexGrow: 1 }, input: { minHeight: 120, borderWidth: 1, borderRadius: 14, padding: 14, textAlignVertical: 'top', fontSize: 15, lineHeight: 22 } });
