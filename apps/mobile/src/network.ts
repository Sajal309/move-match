import { io, Socket } from 'socket.io-client';
import { supabase } from './account';
import { API_URL } from './endpoints';

export function apiBaseUrl() { return API_URL; }

export type NetworkProbe = { medianRttMs: number; clockOffsetMs: number; clockOffsetUncertaintyMs: number };

export async function probeRankedNetwork(): Promise<NetworkProbe> {
  const baseUrl = apiBaseUrl();
  if (!baseUrl) throw new Error('Ranked play needs a configured match service. You can still practice or challenge a friend later.');
  const samples: Array<{ rtt: number; offset: number }> = [];
  for (let index = 0; index < 5; index += 1) {
    const startedAt = performance.now();
    const wallStartedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/health/live`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new Error('Could not reach the match service. Check your connection, or choose practice.');
    }
    const receivedAt = performance.now();
    const wallReceivedAt = Date.now();
    if (!response.ok) throw new Error('The match service did not respond. You can practice while it recovers.');
    const body = await response.json() as { time?: string };
    const serverAt = Date.parse(body.time ?? '');
    if (!Number.isFinite(serverAt)) throw new Error('The match service clock is unavailable. Choose practice or try again.');
    samples.push({ rtt: receivedAt - startedAt, offset: serverAt - ((wallStartedAt + wallReceivedAt) / 2) });
  }
  const sortedRtt = samples.map((sample) => sample.rtt).sort((a, b) => a - b);
  const sortedOffsets = samples.map((sample) => sample.offset).sort((a, b) => a - b);
  const medianRttMs = sortedRtt[2];
  const clockOffsetMs = sortedOffsets[2];
  const bestRttOffset = samples.slice().sort((a, b) => a.rtt - b.rtt)[0].offset;
  const clockOffsetUncertaintyMs = Math.max(sortedRtt[0] / 2, Math.max(...sortedOffsets.map((offset) => Math.abs(offset - bestRttOffset))));
  if (medianRttMs > 300 || clockOffsetUncertaintyMs > 100) {
    throw new Error(`This connection is too unstable for ranked play (${Math.round(medianRttMs)} ms RTT, ±${Math.round(clockOffsetUncertaintyMs)} ms clock estimate). Try again later or practice.`);
  }
  return { medianRttMs, clockOffsetMs, clockOffsetUncertaintyMs };
}

export async function createAuthenticatedSocket(): Promise<Socket> {
  const baseUrl = apiBaseUrl();
  const client = supabase;
  if (!baseUrl || !client) throw new Error('Online play needs configured API and email sign-in settings.');
  return io(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    auth: (callback) => {
      void client.auth.getSession().then(({ data, error }) => {
        callback({ accessToken: error ? '' : data.session?.access_token ?? '' });
      });
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    timeout: 8_000,
  });
}
