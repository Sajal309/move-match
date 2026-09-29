import { supabase } from './account';
import { API_URL } from './endpoints';

export { API_URL };
export const apiConfigured = Boolean(API_URL);

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('MOVE / MATCH online services are not configured.');
  const session = await supabase?.auth.getSession();
  const token = session?.data.session?.access_token;
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(8_000),
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new Error(error.message ?? `${error.code ?? 'SERVICE_ERROR'} (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
