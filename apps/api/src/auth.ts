import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { pool } from './db.js';

export type AuthUser = { id: string; email?: string; claims: JWTPayload };
declare module 'fastify' {
  interface FastifyRequest { authUser: AuthUser | null }
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (jwks) return jwks;
  const endpoint = config.jwksUrl || `${config.supabaseUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  if (!config.supabaseUrl) throw new Error('Supabase URL is not configured');
  jwks = createRemoteJWKSet(new URL(endpoint), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
  return jwks;
}

export async function verifyAccessToken(token: string): Promise<AuthUser> {
  const issuer = config.issuer || `${config.supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const { payload } = await jwtVerify(token, getJwks(), {
    issuer,
    audience: config.audience,
    algorithms: ['ES256', 'RS256'],
    clockTolerance: 10,
  });
  if (typeof payload.sub !== 'string' || payload.role !== 'authenticated' || payload.is_anonymous === true) {
    throw new Error('Token is not an authenticated account session');
  }
  return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined, claims: payload };
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return reply.code(401).send({ code: 'AUTH_EXPIRED', message: 'Sign in to continue.', retryable: false, requestId: request.id });
  try { request.authUser = await verifyAccessToken(token); }
  catch {
    return reply.code(401).send({ code: 'AUTH_EXPIRED', message: 'Your sign-in expired. Sign in again to continue.', retryable: false, requestId: request.id });
  }
}

export async function requireActiveProfile(userId: string) {
  const { rows } = await pool.query<{ id: string; display_name: string; avatar_id: string; status: string; adult_confirmed_at: Date | null }>(
    'select id, display_name, avatar_id, status, adult_confirmed_at from public.profiles where id = $1', [userId],
  );
  const profile = rows[0];
  if (!profile || !profile.adult_confirmed_at || profile.status !== 'active') return null;
  return profile;
}

export function requireAuth(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw Object.assign(new Error('Sign in to continue.'), { statusCode: 401, code: 'AUTH_EXPIRED' });
  return request.authUser;
}
