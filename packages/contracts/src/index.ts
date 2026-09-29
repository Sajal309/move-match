import { z } from 'zod';

export const ExerciseSchema = z.enum(['push_up', 'pull_up']);
export const ModeSchema = z.enum(['friend', 'ranked']);
export const MatchStateSchema = z.enum(['WAITING_READY', 'COUNTDOWN', 'ACTIVE', 'SETTLING', 'COMPLETED', 'CANCELLED', 'VOIDED']);

export const RepObservationSchema = z.object({
  protocolVersion: z.literal(1),
  eventId: z.string().uuid(),
  matchId: z.string().uuid(),
  sessionNonce: z.string().min(24).max(160),
  seq: z.number().int().positive().max(200),
  exercise: ExerciseSchema,
  ruleVersion: z.string().min(1).max(40),
  modelVersion: z.string().min(1).max(120),
  cycleStartMs: z.number().int().min(0).max(48_000),
  cycleEndMs: z.number().int().min(1).max(48_000),
  minElbowDeg: z.number().finite().min(0).max(180),
  maxElbowDeg: z.number().finite().min(0).max(180),
  minimumRequiredVisibility: z.number().finite().min(0).max(1),
  trackingGapMs: z.number().int().min(0).max(2_000),
  qualityFlags: z.array(z.string().min(1).max(40)).max(12),
}).superRefine((event, context) => {
  if (event.cycleEndMs <= event.cycleStartMs) context.addIssue({ code: z.ZodIssueCode.custom, message: 'cycleEndMs must follow cycleStartMs', path: ['cycleEndMs'] });
  if (event.maxElbowDeg < event.minElbowDeg) context.addIssue({ code: z.ZodIssueCode.custom, message: 'maxElbowDeg must be >= minElbowDeg', path: ['maxElbowDeg'] });
});

export const ErrorBodySchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean(), requestId: z.string() });
export type Exercise = z.infer<typeof ExerciseSchema>;
export type MatchMode = z.infer<typeof ModeSchema>;
export type MatchState = z.infer<typeof MatchStateSchema>;
export type RepObservation = z.infer<typeof RepObservationSchema>;

export const ERROR_CODES = {
  AUTH_EXPIRED: 'AUTH_EXPIRED', ALREADY_ACTIVE: 'ALREADY_ACTIVE', RULE_UNSUPPORTED: 'RULE_UNSUPPORTED',
  INVITE_EXPIRED: 'INVITE_EXPIRED', QUEUE_TIMEOUT: 'QUEUE_TIMEOUT', TRACKING_NOT_READY: 'TRACKING_NOT_READY',
  RATE_LIMITED: 'RATE_LIMITED', RESULT_PENDING: 'RESULT_PENDING', SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN', INVALID_REQUEST: 'INVALID_REQUEST',
} as const;
