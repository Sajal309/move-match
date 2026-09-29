import React from 'react';
import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useAppTheme } from '../../src/theme';

function TabGlyph({ label, focused, color }: { label: string; focused: boolean; color: string }) {
  return <Text style={{ color, fontSize: 19, fontWeight: focused ? '800' : '500' }}>{label}</Text>;
}

export default function TabLayout() {
  const { theme } = useAppTheme();
  return <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: theme.text,
    tabBarInactiveTintColor: theme.secondary, tabBarStyle: { backgroundColor: theme.surface,
      borderTopColor: theme.border, height: 64, paddingBottom: 8, paddingTop: 6 },
    tabBarLabelStyle: { fontSize: 11, fontWeight: '700' }, }}>
    <Tabs.Screen name="index" options={{ title: 'Play', tabBarIcon: ({ focused, color }) => <TabGlyph label="●" focused={focused} color={String(color)} /> }} />
    <Tabs.Screen name="leaderboard" options={{ title: 'Leaderboard', tabBarIcon: ({ focused, color }) => <TabGlyph label="↗" focused={focused} color={String(color)} /> }} />
    <Tabs.Screen name="you" options={{ title: 'You', tabBarIcon: ({ focused, color }) => <TabGlyph label="○" focused={focused} color={String(color)} /> }} />
  </Tabs>;
}
