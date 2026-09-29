import { Server as SocketServer, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server as HttpServer } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { requireActiveProfile, verifyAccessToken } from './auth.js';
import { pool, redis, transaction } from './db.js';
import { AppError, asAppError } from './errors.js';
import { acceptRep, heartbeatMatch, heartbeatQueue, leaveMatch, matchSnapshot, readyMatch } from './matches.js';

type SocketUser = { id: string };
type ClientSocket = Socket & { data: { user?: SocketUser } };
let ioRef: SocketServer | null = null;
let subscriber: Redis | null = null;

function room(matchId: string) { return `match:${matchId}`; }
function userRoom(userId: string) { return `user:${userId}`; }
function eventId(data: Record<string, unknown>) {
  return typeof data.requestId === 'string' ? data.requestId : undefined;
}
function failAck(error: unknown, requestId?: string) {
  const appError = asAppError(error);
  return { ok: false, error: { code: appError.code, message: appError.message, retryable: appError.retryable }, requestId };
}

export async function attachRealtime(server: HttpServer, logger: FastifyBaseLogger) {
  if (redis.status === 'wait') await redis.connect();
  subscriber = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: 2 });
  await subscriber.connect();
  ioRef = new SocketServer(server, {
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: 8 * 1024,
    pingInterval: 5_000,
    pingTimeout: 10_000,
    cors: { origin: false },
    adapter: createAdapter(redis, subscriber),
  });

  ioRef.use(async (socket, next) => {
    const typed = socket as ClientSocket;
    const header = socket.handshake.headers.authorization;
    const token = typeof socket.handshake.auth?.accessToken === 'string' ? socket.handshake.auth.accessToken
      : typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token
        : header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return next(new Error('AUTH_EXPIRED'));
    try {
      const user = await verifyAccessToken(token);
      const profile = await requireActiveProfile(user.id);
      if (!profile) return next(new Error('FORBIDDEN'));
      typed.data.user = { id: user.id };
      next();
    } catch { next(new Error('AUTH_EXPIRED')); }
  });

  ioRef.on('connection', (rawSocket) => {
    const socket = rawSocket as ClientSocket;
    const userId = socket.data.user!.id;
    void socket.join(userRoom(userId));
    socket.emit('session.accepted', { protocolVersion: 1, userId, serverTime: new Date().toISOString() });

    socket.on('match.resume', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        const input = z.object({ protocolVersion: z.literal(1), matchId: z.string().uuid(), lastServerSeq: z.number().int().nonnegative().optional() }).parse(raw);
        const snapshot = await matchSnapshot(userId, input.matchId, true);
        await socket.join(room(input.matchId));
        await heartbeatMatch(userId, input.matchId);
        ack?.({ ok: true, snapshot, requestId });
        socket.emit('match.snapshot', { protocolVersion: 1, ...snapshot });
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('match.ready', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        const input = z.object({ protocolVersion: z.literal(1), matchId: z.string().uuid(), sessionNonce: z.string().min(24).max(160), modelVersion: z.string().max(120), requestId: z.string().uuid().optional() }).parse(raw);
        if (input.modelVersion !== 'google-pose-landmarker-lite-float16') throw new AppError('Update the app before joining this match.', 409, 'RULE_UNSUPPORTED');
        await socket.join(room(input.matchId));
        const result = await readyMatch(userId, input.matchId, input.sessionNonce);
        ack?.({ ok: true, ...result, requestId });
        if (result.state === 'CANCELLED') {
          const serverSeq = await redis.incr(`match-seq:${input.matchId}`);
          ioRef?.to(room(input.matchId)).emit('match.ended', { protocolVersion: 1, matchId: input.matchId, result, serverSeq,
            serverTime: new Date().toISOString() });
        } else if (result.state === 'COUNTDOWN') {
          const serverSeq = await redis.incr(`match-seq:${input.matchId}`);
          ioRef?.to(room(input.matchId)).emit('match.countdown', { protocolVersion: 1, matchId: input.matchId,
            startAt: result.startAt, endAt: result.endAt, serverSeq });
        }
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('match.rep', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        const result = await acceptRep(userId, raw);
        ack?.({ ok: true, ...result, requestId });
        if (result.status === 'accepted' && 'slot' in result) {
          const matchId = typeof raw === 'object' && raw !== null ? (raw as { matchId?: string }).matchId : undefined;
          if (!matchId) return;
          const { rows } = await pool.query<{ slot: number; accepted_count: number }>(
            'select slot, accepted_count from public.match_participants where match_id = $1 order by slot', [matchId]);
          const scores = { player1: rows.find((item) => item.slot === 1)?.accepted_count ?? 0, player2: rows.find((item) => item.slot === 2)?.accepted_count ?? 0 };
          const serverSeq = await redis.incr(`match-seq:${matchId}`);
          ioRef?.to(room(matchId)).emit('match.score', { protocolVersion: 1, matchId, ...scores, eventId: result.eventId,
            provisional: false, serverTime: new Date().toISOString(), serverSeq });
        }
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('match.heartbeat', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        const input = z.object({ protocolVersion: z.literal(1), matchId: z.string().uuid(), requestId: z.string().uuid().optional() }).parse(raw);
        const result = await heartbeatMatch(userId, input.matchId);
        ack?.({ ...result, requestId });
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('queue.heartbeat', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        z.object({ protocolVersion: z.literal(1), requestId: z.string().uuid().optional() }).parse(raw);
        const result = await heartbeatQueue(userId);
        ack?.({ ...result, requestId });
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('match.leave', async (raw: unknown, ack?: (value: unknown) => void) => {
      const requestId = typeof raw === 'object' && raw !== null ? eventId(raw as Record<string, unknown>) : undefined;
      try {
        const input = z.object({ protocolVersion: z.literal(1), matchId: z.string().uuid(), requestId: z.string().uuid().optional() }).parse(raw);
        const result = await leaveMatch(userId, input.matchId);
        ack?.({ ok: true, result, requestId });
        ioRef?.to(room(input.matchId)).emit('match.ended', { protocolVersion: 1, matchId: input.matchId, result,
          serverTime: new Date().toISOString() });
      } catch (error) { ack?.(failAck(error, requestId)); }
    });

    socket.on('disconnect', () => {
      void pool.query("update public.match_participants set last_seen_at = now(), connection_state = 'disconnected' where user_id = $1 and match_id in (select id from public.matches where state in ('COUNTDOWN','ACTIVE'))", [userId])
        .catch((error) => logger.warn({ error, userId }, 'could not record socket disconnect'));
    });
  });

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message) as { type: string; matchId: string; users: string[] };
      if (event.type === 'match.found') for (const userId of event.users) ioRef?.to(userRoom(userId)).emit('match.found', { protocolVersion: 1, matchId: event.matchId });
    } catch (error) { logger.warn({ error }, 'invalid internal match event'); }
  });
  await subscriber.subscribe('match-events');
  logger.info('Socket.IO gateway ready; transport restricted to WebSocket');
}

export async function publishOutbox() {
  const io = ioRef;
  if (!io) return;
  await transaction(async (client) => {
    const { rows } = await client.query<{ id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown> }>(
      'select id, aggregate_id, event_type, payload from public.outbox where published_at is null order by created_at for update skip locked limit 50',
    );
    for (const row of rows) {
      if (row.event_type === 'match.settled') {
        const serverSeq = await redis.incr(`match-seq:${row.aggregate_id}`);
        io.to(room(row.aggregate_id)).emit('match.settled', { protocolVersion: 1, ...row.payload, serverSeq });
      }
      await client.query('update public.outbox set published_at = now() where id = $1', [row.id]);
    }
  });
}

export function disconnectUser(userId: string) {
  ioRef?.in(userRoom(userId)).disconnectSockets(true);
}

export async function notifyMatchEnded(matchId: string, result: unknown) {
  if (!ioRef) return;
  const serverSeq = await redis.incr(`match-seq:${matchId}`);
  ioRef.to(room(matchId)).emit('match.ended', { protocolVersion: 1, matchId, result,
    serverTime: new Date().toISOString(), serverSeq });
}
