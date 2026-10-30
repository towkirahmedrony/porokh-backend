import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import logger from '../../lib/utils/logger';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export type SubmissionPerformanceTrace = {
  requestId: string;
  startedAt: number;
  phases: Record<string, number>;
  supabaseOperations: Array<{ name: string; durationMs: number }>;
};

declare global {
  namespace Express {
    interface Request {
      submissionRequestId?: string;
      submissionPerformance?: SubmissionPerformanceTrace;
    }
  }
}

const roundMs = (value: number): number => Math.round(value * 100) / 100;

export const resolveSubmissionRequestId = (incoming: unknown): string => {
  if (typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)) return incoming;
  return randomUUID();
};

/** Adds correlation to every POST /submit response, including rate-limited ones. */
export const submissionRequestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const requestId = resolveSubmissionRequestId(req.header('x-request-id'));
  req.submissionRequestId = requestId;
  req.submissionPerformance = {
    requestId,
    startedAt: performance.now(),
    phases: {},
    supabaseOperations: [],
  };
  res.setHeader('x-request-id', requestId);
  next();
};

/**
 * Attach the completion logger only after the existing rate limiter passes.
 * The request-local trace already includes authentication timing, but this
 * keeps logs to one compact summary for accepted requests instead of
 * amplifying a burst of rejected traffic.
 */
export const submissionPerformanceMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const trace: SubmissionPerformanceTrace = req.submissionPerformance ?? {
    requestId: req.submissionRequestId ?? randomUUID(),
    startedAt: performance.now(),
    phases: {},
    supabaseOperations: [],
  };
  req.submissionPerformance = trace;

  res.once('finish', () => {
    const event = {
      event: 'exam_submission_timing',
      request_id: trace.requestId,
      status_code: res.statusCode,
      total_backend_ms: roundMs(performance.now() - trace.startedAt),
      phases_ms: Object.fromEntries(
        Object.entries(trace.phases).map(([name, value]) => [name, roundMs(value)])
      ),
      supabase_operations: trace.supabaseOperations.map(({ name, durationMs }) => ({
        name,
        duration_ms: roundMs(durationMs),
      })),
    };

    // Deliberately omit request bodies, answers, user IDs, tokens, and database
    // values. A single structured record per accepted submission is searchable.
    logger.info(`[exam-submission-timing] ${JSON.stringify(event)}`);
  });

  next();
};

const addPhaseDuration = (
  trace: SubmissionPerformanceTrace | undefined,
  name: string,
  elapsed: number
): void => {
  if (!trace) return;
  trace.phases[name] = (trace.phases[name] ?? 0) + elapsed;
};

export const measureSubmissionPhase = async <T>(
  trace: SubmissionPerformanceTrace | undefined,
  name: string,
  operation: () => Promise<T> | PromiseLike<T>
): Promise<T> => {
  if (!trace) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    addPhaseDuration(trace, name, performance.now() - startedAt);
  }
};

export const measureSubmissionPhaseSync = <T>(
  trace: SubmissionPerformanceTrace | undefined,
  name: string,
  operation: () => T
): T => {
  if (!trace) return operation();
  const startedAt = performance.now();
  try {
    return operation();
  } finally {
    addPhaseDuration(trace, name, performance.now() - startedAt);
  }
};

/** Time one named Supabase/Auth operation; names must never contain query data. */
export const measureSupabaseOperation = async <T>(
  trace: SubmissionPerformanceTrace | undefined,
  name: string,
  operation: () => Promise<T> | PromiseLike<T>
): Promise<T> => {
  if (!trace) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    trace.supabaseOperations.push({
      name,
      durationMs: performance.now() - startedAt,
    });
  }
};

export const beginSubmissionPhase = (
  trace: SubmissionPerformanceTrace | undefined,
  name: string
): (() => void) => {
  if (!trace) return () => undefined;
  const startedAt = performance.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    addPhaseDuration(trace, name, performance.now() - startedAt);
  };
};
