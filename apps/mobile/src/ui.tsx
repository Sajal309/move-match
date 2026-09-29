import React from 'react';
import { Pressable, PressableProps, ScrollView, StyleSheet, Text, TextProps, View, ViewProps } from 'react-native';
import { SafeAreaView, Edge } from 'react-native-safe-area-context';
import { radius, spacing, touch } from '@move-match/design-tokens';
import { useAppTheme } from './theme';

export function Page({ children, scroll = true, edges = ['top', 'left', 'right'], contentStyle }: {
  children: React.ReactNode; scroll?: boolean; edges?: Edge[]; contentStyle?: ViewProps['style'];
}) {
  const { theme } = useAppTheme();
  return <SafeAreaView edges={edges} style={[styles.safe, { backgroundColor: theme.background }]}>
    {scroll ? <ScrollView contentContainerStyle={[styles.page, contentStyle]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView> : <View style={[styles.page, styles.fill, contentStyle]}>{children}</View>}
  </SafeAreaView>;
}

export function TextBlock({ variant = 'body', style, ...props }: TextProps & { variant?: 'display' | 'title' | 'section' | 'body' | 'label' | 'caption' }) {
  const { theme } = useAppTheme();
  return <Text accessibilityRole={variant === 'title' || variant === 'section' ? 'header' : undefined}
    {...props} style={[{ color: theme.text }, styles[variant], style]} />;
}

export function Card({ children, style, ...props }: ViewProps) {
  const { theme } = useAppTheme();
  return <View {...props} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }, style]}>{children}</View>;
}

export function ActionButton({ title, tone = 'primary', disabled, style, ...props }: Omit<PressableProps, 'children'> & {
  title: string; tone?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  const { theme } = useAppTheme();
  const palette = tone === 'primary'
    ? { backgroundColor: theme.primary, borderColor: theme.primary, color: theme.primaryText }
    : tone === 'danger'
      ? { backgroundColor: theme.danger, borderColor: theme.danger, color: theme.surface }
      : tone === 'secondary'
        ? { backgroundColor: theme.tint, borderColor: theme.border, color: theme.text }
        : { backgroundColor: 'transparent', borderColor: 'transparent', color: theme.text };
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    {...props} style={(state) => [styles.button, { backgroundColor: palette.backgroundColor,
      borderColor: palette.borderColor, opacity: disabled ? 0.5 : state.pressed ? 0.82 : 1 },
      typeof style === 'function' ? style(state) : style]}>
    <Text style={[styles.buttonText, { color: palette.color }]}>{title}</Text>
  </Pressable>;
}

export function Eyebrow({ children }: React.PropsWithChildren) {
  const { theme } = useAppTheme();
  return <Text style={[styles.eyebrow, { color: theme.secondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  fill: { flex: 1 },
  page: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 32, gap: spacing.lg },
  card: { borderWidth: 1, borderRadius: radius.card, padding: spacing.lg, gap: spacing.sm },
  button: { minHeight: touch.button, borderWidth: 1, borderRadius: radius.button, paddingHorizontal: 18,
    alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 16, lineHeight: 22, fontWeight: '700', textAlign: 'center' },
  display: { fontSize: 36, lineHeight: 42, fontWeight: '800', letterSpacing: -0.8 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  section: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 24 },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 12, lineHeight: 16 },
  eyebrow: { fontSize: 12, lineHeight: 16, letterSpacing: 1.3, fontWeight: '800' },
});
