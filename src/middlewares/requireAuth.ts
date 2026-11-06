import { Request, Response, NextFunction } from 'express';
import { supabase } from '../config/supabase';
import sendResponse from '../lib/utils/response';
import jwt from 'jsonwebtoken';
import {
  beginSubmissionPhase,
  measureSupabaseOperation,
} from '../features/exams/examSubmissionPerformance';

export interface AccountState {
  accountStatus: string | null;
  sessionsRevokedAt: string | null;
}

/**
 * Reads the account state used to authorize a request.
 *
 * `sessions_revoked_at` is additive (see the users_access_hardening migration).
 * While it is absent the revocation check is skipped, but every other check
 * still applies: a missing column must never turn into an open door.
 */
const readAccountState = async (
  req: AuthReq,
  userId: string
): Promise<{ state: AccountState | null; errorCode: string | null }> => {
  const read = (columns: string) =>
    measureSupabaseOperation(req.submissionPerformance, 'profiles.read_account_status', () =>
      supabase.from('profiles').select(columns).eq('id', userId).maybeSingle()
    );

  const first = await read('account_status, sessions_revoked_at');

  if (!first.error) {
    return {
      state: {
        accountStatus: (first.data as any)?.account_status ?? null,
        sessionsRevokedAt: (first.data as any)?.sessions_revoked_at ?? null,
      },
      errorCode: null,
    };
  }

  // 42703 / PGRST204: the revocation column has not been migrated yet.
  if ((first.error as any).code !== '42703' && (first.error as any).code !== 'PGRST204') {
    return { state: null, errorCode: 'unavailable' };
  }

  console.warn('[auth] sessions_revoked_at is missing; session revocation is not enforced');
  const fallback = await read('account_status');
  if (fallback.error) return { state: null, errorCode: 'unavailable' };
  return {
    state: {
      accountStatus: (fallback.data as any)?.account_status ?? null,
      sessionsRevokedAt: null,
    },
    errorCode: null,
  };
};

interface AuthReq extends Request {
  user?: {
    id: string;
  };
  accessToken?: string;
  authSessionId?: string;
}

// export default সরিয়ে export const করা হলো (Named Export)
export const requireAuth = async (req: AuthReq, res: Response, next: NextFunction) => {
  const endAuthenticationPhase = beginSubmissionPhase(req.submissionPerformance, 'authentication');
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await measureSupabaseOperation(
      req.submissionPerformance,
      'auth.get_user',
      () => supabase.auth.getUser(token)
    );

    if (error || !user) {
      return sendResponse(res, { statusCode: 401, success: false, message: 'Unauthorized: Invalid or expired token' });
    }

    const { state: account, errorCode } = await readAccountState(req, user.id);

    if (errorCode || !account) {
      return sendResponse(res, { statusCode: 503, success: false, message: 'Account status could not be verified' });
    }

    if (account.accountStatus !== 'active') {
      return res.status(403).json({
        success: false,
        message: 'Account access is unavailable',
        data: null,
        code: 'ACCOUNT_SUSPENDED',
      });
    }

    const claims = jwt.decode(token);
    const issuedAt = claims && typeof claims === 'object' && typeof claims.iat === 'number'
      ? claims.iat
      : null;

    // A token issued at or before the last administrative revocation is dead,
    // even though its signature and expiry are still valid. The comparison is
    // inclusive because JWT `iat` has second precision: a token minted in the
    // same second as the revocation is treated as revoked.
    if (account.sessionsRevokedAt && issuedAt !== null) {
      const revokedAt = Date.parse(account.sessionsRevokedAt);
      if (Number.isFinite(revokedAt) && issuedAt * 1000 <= revokedAt) {
        return res.status(401).json({
          success: false,
          message: 'Unauthorized: Session revoked',
          data: null,
          code: 'SESSION_REVOKED',
        });
      }
    }

    req.user = { id: user.id };
    // Retain only in request memory so privileged RPCs can verify auth.uid()
    // independently in Postgres. Never persist or log this token.
    req.accessToken = token;
    req.authSessionId = claims && typeof claims === 'object' && typeof claims.session_id === 'string'
      ? claims.session_id
      : undefined;
    
    endAuthenticationPhase();
    next();
  } catch {
    console.error('Authentication verification failed');
    return sendResponse(res, { statusCode: 500, success: false, message: 'Internal Server Error during authentication' });
  } finally {
    endAuthenticationPhase();
  }
};
