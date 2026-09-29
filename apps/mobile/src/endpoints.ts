import { Platform } from 'react-native';

const configuredApiUrl = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

// The Android emulator reaches the host machine through 10.0.2.2. On iOS Simulator,
// localhost already resolves back to the Mac running the local API.
export const API_URL = Platform.OS === 'android'
  ? configuredApiUrl.replace(/^http:\/\/(localhost|127\.0\.0\.1)(?=:\d+|$)/, 'http://10.0.2.2')
  : configuredApiUrl;
