import { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
      };
      /** Verified bearer token kept in request memory only for user-scoped RPCs. */
      accessToken?: string;
      /** Supabase session UUID decoded only after auth.getUser verifies the JWT. */
      authSessionId?: string;
      /**
       * Role resolved by `rbacGuard` from the `user_roles` table. It is always
       * server-derived; a role supplied in the request body is ignored.
       */
      userRole?: string;
      /**
       * Account state already read by `requireAuth`. Downstream authorization
       * reuses it instead of issuing a second `profiles` read for the same
       * request. It is set only from a verified token, never from the client.
       */
      authAccount?: {
        accountStatus: string | null;
        sessionsRevokedAt: string | null;
      };
    }
  }
}

export {};
