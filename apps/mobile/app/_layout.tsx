import 'react-native-gesture-handler';
import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppThemeProvider } from '../src/theme';
import { useAppTheme } from '../src/theme';

function AppRoutes() {
  const { theme, reducedMotion } = useAppTheme();
  return <>
    <StatusBar style={theme.background === '#102839' ? 'light' : 'dark'} />
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.background }, animation: reducedMotion ? 'none' : 'fade' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="setup" options={{ presentation: 'card' }} />
      <Stack.Screen name="practice" options={{ gestureEnabled: false }} />
      <Stack.Screen name="results" />
      <Stack.Screen name="privacy" />
      <Stack.Screen name="auth" />
      <Stack.Screen name="online-unavailable" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="friend" options={{ presentation: 'card' }} />
      <Stack.Screen name="join-friend" options={{ presentation: 'card' }} />
      <Stack.Screen name="friend-invite" options={{ presentation: 'card', gestureEnabled: false }} />
      <Stack.Screen name="queue" options={{ gestureEnabled: false }} />
      <Stack.Screen name="match" options={{ gestureEnabled: false }} />
      <Stack.Screen name="online-results" options={{ gestureEnabled: false }} />
      <Stack.Screen name="blocks" options={{ presentation: 'card' }} />
      <Stack.Screen name="report" options={{ presentation: 'card' }} />
    </Stack>
  </>;
}

export default function RootLayout() {
  return <AppThemeProvider><AppRoutes /></AppThemeProvider>;
}
