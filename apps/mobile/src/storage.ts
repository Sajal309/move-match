import * as SQLite from 'expo-sqlite';
import type { Exercise } from '@move-match/rep-engine';

export interface LocalPracticeSession {
  id: string;
  exercise: Exercise;
  reps: number;
  durationMs: number;
  finishedAt: string;
  ruleVersion: string;
}

let database: ReturnType<typeof SQLite.openDatabaseAsync> | undefined;
async function db() {
  database ??= SQLite.openDatabaseAsync('move-match.db');
  const connection = await database;
  await connection.execAsync(`CREATE TABLE IF NOT EXISTS practice_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    exercise TEXT NOT NULL CHECK (exercise IN ('push_up','pull_up')),
    reps INTEGER NOT NULL CHECK (reps >= 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    finished_at TEXT NOT NULL,
    rule_version TEXT NOT NULL
  );`);
  return connection;
}

export async function savePracticeSession(session: LocalPracticeSession) {
  const connection = await db();
  await connection.runAsync(
    'INSERT OR IGNORE INTO practice_sessions (id, exercise, reps, duration_ms, finished_at, rule_version) VALUES (?, ?, ?, ?, ?, ?)',
    session.id, session.exercise, session.reps, session.durationMs, session.finishedAt, session.ruleVersion,
  );
}

export async function getPracticeHistory(): Promise<LocalPracticeSession[]> {
  const connection = await db();
  return connection.getAllAsync<LocalPracticeSession>(
    'SELECT id, exercise, reps, duration_ms AS durationMs, finished_at AS finishedAt, rule_version AS ruleVersion FROM practice_sessions ORDER BY finished_at DESC LIMIT 50',
  );
}

export async function clearPracticeHistory() {
  const connection = await db();
  await connection.execAsync('DELETE FROM practice_sessions;');
}
