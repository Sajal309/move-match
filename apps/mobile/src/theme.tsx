import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, useColorScheme } from 'react-native';
import { ColorScheme, Theme, themes } from '@move-match/design-tokens';
import { getPreferences, updatePreferences } from './preferences';

type ThemeMode = ColorScheme | 'system';
type ThemeContextValue = { theme: Theme; mode: ThemeMode; setMode: (mode: ThemeMode) => void;
  reducedMotion: boolean; reducedMotionOverride: boolean | null; setReducedMotionOverride: (value: boolean | null) => void };
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function AppThemeProvider({ children }: React.PropsWithChildren) {
  const system = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>('system');
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);
  const [reducedMotionOverride, setReducedMotionState] = useState<boolean | null>(null);
  useEffect(() => {
    void getPreferences().then((preferences) => {
      setMode(preferences.theme);
      setReducedMotionState(preferences.reducedMotion);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(setSystemReducedMotion);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystemReducedMotion);
    return () => subscription.remove();
  }, []);
  const setReducedMotionOverride = (value: boolean | null) => {
    setReducedMotionState(value);
    void updatePreferences({ reducedMotion: value });
  };
  const theme = themes[mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode];
  const value = useMemo(() => ({ theme, mode, setMode, reducedMotion: reducedMotionOverride ?? systemReducedMotion,
    reducedMotionOverride, setReducedMotionOverride }), [theme, mode, systemReducedMotion, reducedMotionOverride]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useAppTheme must be used inside AppThemeProvider');
  return value;
}
