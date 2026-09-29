import * as SecureStore from 'expo-secure-store';

export type LocalPreferences = {
  haptics: boolean;
  spokenCount: boolean;
  analyticsOptIn: boolean;
  theme: 'system' | 'light' | 'dark';
  reducedMotion: boolean | null;
};

const KEY = 'move-match-preferences-v1';
const DEFAULTS: LocalPreferences = { haptics: true, spokenCount: false, analyticsOptIn: false, theme: 'system', reducedMotion: null };

export async function getPreferences(): Promise<LocalPreferences> {
  const stored = await SecureStore.getItemAsync(KEY);
  if (!stored) return DEFAULTS;
  try { return { ...DEFAULTS, ...JSON.parse(stored) } as LocalPreferences; }
  catch { return DEFAULTS; }
}

export async function updatePreferences(patch: Partial<LocalPreferences>) {
  const current = await getPreferences();
  const next = { ...current, ...patch };
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
  return next;
}
