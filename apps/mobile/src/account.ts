import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { API_URL } from './endpoints';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
export const authConfigured = Boolean(url && key);

const secureStorage = {
  getItem: (name: string) => SecureStore.getItemAsync(name),
  setItem: (name: string, value: string) => SecureStore.setItemAsync(name, value),
  removeItem: (name: string) => SecureStore.deleteItemAsync(name),
};

export const supabase: SupabaseClient | null = authConfigured
  ? createClient(url, key, {
      auth: {
        storage: secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

if (supabase) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase?.auth.startAutoRefresh();
    else void supabase?.auth.stopAutoRefresh();
  });
}

const ADULT_GATE = 'move-match-adult-gate-v1';
export async function setAdultEligibility(value: 'confirmed' | 'underage') {
  await SecureStore.setItemAsync(ADULT_GATE, value);
}
export async function getAdultEligibility(): Promise<'confirmed' | 'underage' | null> {
  const value = await SecureStore.getItemAsync(ADULT_GATE);
  return value === 'confirmed' || value === 'underage' ? value : null;
}

export async function requestEmailCode(email: string) {
  if (!supabase) throw new Error('Email sign-in is unavailable until Supabase client settings are added.');
  const { error } = await supabase.auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { shouldCreateUser: true } });
  if (error) throw error;
}

export async function verifyEmailCode(email: string, token: string) {
  if (!supabase) throw new Error('Email sign-in is unavailable until Supabase client settings are added.');
  const { data, error } = await supabase.auth.verifyOtp({ email: email.trim().toLowerCase(), token: token.trim(), type: 'email' });
  if (error) throw error;
  if (!data.session) throw new Error('Email verification did not create a session. Request a new code and try again.');
  return data.session;
}

export async function signOut() {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export async function currentAccount() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

export async function syncAdultProfile() {
  const session = await supabase?.auth.getSession();
  const accessToken = session?.data.session?.access_token;
  if (!accessToken) throw new Error('Your sign-in expired. Sign in again to continue.');
  if (!API_URL) throw new Error('Online profile service is not configured. Practice still works offline.');
  const response = await fetch(`${API_URL}/v1/me`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ adultConfirmed: true, consentVersion: 'mvp-2026-09-25' }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? `Profile setup failed (${response.status}).`);
  }
}
