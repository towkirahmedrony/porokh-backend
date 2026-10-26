import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import { createCorsOptions } from './config/cors';

// রাউট ইম্পোর্ট
import authRoutes from './features/auth/auth.routes';
import profileRoutes from './features/profile/profile.routes'; 
import adminProfileRoutes from './features/profile/profile.admin.routes';
import usersAdminRoutes from './features/users/users.admin.routes';
import contentRoutes from './features/content/content.routes'; 
import communityAdminRoutes from './features/community/community.admin.routes';
import communityUserRoutes from './features/community/community.user.routes';
import dashboardAdminRoutes from './features/dashboard/dashboard.admin.routes';
import mediaRoutes from './features/media/media.routes';
import enterpriseRoutes from './features/enterprise/enterprise.routes';
import leaderboardRoutes from './features/leaderboard/leaderboard.routes';
import groupRoutes from './features/groups/groups.routes';
import groupAdminRoutes from './features/groups/groups.admin.routes';
import groupBattleRoutes from './features/groups/groupBattles.routes';
import groupInternalRoutes from './features/groups/groups.internal.routes';
import { GROUP_ERROR_CODES } from './features/groups/groups.errors';

// এক্সাম, সিস্টেম, ফাইন্যান্স, নোটিফিকেশন এবং হিস্ট্রি রাউট ইম্পোর্ট
import { ExamUserRoutes } from './features/exams/exams.user.routes';
import { ExamAdminRoutes } from './features/exams/exams.admin.routes';
import examBookmarkRoutes from './features/exams/exam.bookmark.routes';
import systemRoutes from './features/system/system.routes'; 
import { financeRoutes } from './features/finance/finance.routes';
import notificationRoutes from './features/notifications/notifications.routes';
import notificationsAdminRoutes from './features/notifications/notifications.admin.routes'; 
import historyRoutes from './features/history/history.routes'; 

// মনিটাইজেশন, প্রগ্রেস, এআই, গ্রোথ, কন্টাক্ট, রিপোর্ট এবং রেফারেল রাউট ইম্পোর্ট
import monetizationRoutes from './features/monetization/monetization.routes';
import marketplaceRoutes from './features/monetization/marketplace.routes';
import progressRoutes from './features/progress/progress.routes'; 
import aiRoutes from './features/ai/ai.routes'; 
import growthRoutes from './features/growth/streak.routes'; 
import referralRoutes from './features/referral/referral.routes';
import { contactRoutes } from './features/contact/contact.routes';
import reportRoutes from './features/reports/reports.routes'; 
import { accessRoutes } from './features/access/access.routes';

// অ্যাপ-বিল্ডার রাউট ইম্পোর্ট (system থেকে মুভ করা কনফিগারেশনের জন্য)
import appBuilderRoutes from './features/app-builder/app-builder.routes';

dotenv.config();

const app: Application = express();

// 🚀 [FIX]: প্রক্সি সার্ভার থেকে আসল ইউজারের আইপি রিসিভ করার জন্য এনাবল করা হলো
// Render terminates TLS in front of the app, so exactly one proxy hop is
// trusted. Trusting an arbitrary chain (`true`) would let a client spoof the
// left-most X-Forwarded-For entry and defeat IP rate limiting.
app.set('trust proxy', 1);

app.use(
  cors(
    createCorsOptions({
      clientUrl: process.env.CLIENT_URL,
      nodeEnv: process.env.NODE_ENV,
    })
  )
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Health Check Route
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: 'ParaPoth API is running perfectly!'
  });
});

// Application Routes (Standard API v1)
app.use('/api/v1/auth', authRoutes); 
app.use('/api/v1/profiles', profileRoutes);

// 🛠️ Content & Institutions Fix
app.use('/api/v1/content', contentRoutes);
app.use('/api/v1/admin/content', contentRoutes);
app.use('/api/v1/institutions', contentRoutes); // Frontend compatibility

// 🛠️ Community Admin & User (flagged-chats, overview fix)
app.use('/api/v1/community/admin', communityAdminRoutes);
app.use('/api/v1/community/user', communityUserRoutes);
app.use('/api/v1/community', communityAdminRoutes); // Frontend compatibility for Admin panel calls

// 🛠️ Admin Dashboard (stats fix)
app.use('/api/v1/admin/dashboard', dashboardAdminRoutes);

app.use('/api/v1/media', mediaRoutes);
app.use('/api/v1/enterprise', enterpriseRoutes);

// 🛠️ Enterprise Reports (reports fix)
app.use('/api/v1/enterprise/reports', reportRoutes);
app.use('/api/v1/reports', reportRoutes); // Retain original route

app.use('/api/v1/leaderboard', leaderboardRoutes);

// 🏠 Groups: squads, communities, group battles and their leaderboards
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1/battles', groupBattleRoutes);
app.use('/api/v1/internal', groupInternalRoutes);
app.use('/internal', groupInternalRoutes);

// এক্সাম মডিউট রাউট
app.use('/api/v1/exams/user', ExamUserRoutes);
app.use('/api/v1/exams/admin', ExamAdminRoutes);
// Existing clients call POST /api/v1/exams/bookmark; keep that path stable.
app.use('/api/v1/exams/bookmark', examBookmarkRoutes);

// সিস্টেম, ফাইন্যান্স এবং অন্যান্য রাউট
app.use('/api/v1/system', systemRoutes); 
app.use('/api/v1/finance', financeRoutes); 
app.use('/api/v1/notifications/admin', notificationsAdminRoutes); 
app.use('/api/v1/notifications', notificationRoutes); 
app.use('/api/v1/monetization', monetizationRoutes); 
app.use('/api/v1/marketplace', marketplaceRoutes);
app.use('/api/v1/history', historyRoutes); 
app.use('/api/v1/progress', progressRoutes); 
app.use('/api/v1/ai', aiRoutes); 
app.use('/api/v1/growth', growthRoutes); 
app.use('/api/v1/referral', referralRoutes); 
app.use('/api/v1/contact', contactRoutes);
app.use('/api/v1/me/access', accessRoutes.userAccess);

// 🛠️ App Builder (configs, home-grids, daily_quote fix)
app.use('/api/v1/app-builder', appBuilderRoutes);

// Admin & Management Routes
app.use('/api/v1/admin/profile', adminProfileRoutes);
app.use('/api/v1/admin/users', usersAdminRoutes);
app.use('/api/v1/admin/groups', groupAdminRoutes);
app.use('/api/v1/admin/access', accessRoutes.adminAccess);

// Frontend Compatibility Routes 
app.use('/content', contentRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/enterprise', enterpriseRoutes);
app.use('/exams', ExamUserRoutes); 

// 404 Not Found Handler
app.use((req: Request, res: Response, next: NextFunction) => {
  res.status(404).json({
    success: false,
    message: 'API route not found'
  });
});

// Custom Error Interface for Type Safety (Removing 'any' type)
interface CustomError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
  errorCode?: string;
  details?: unknown;
}

/**
 * Machine-readable codes that clients are allowed to receive. Anything else
 * (for example a PostgREST code such as `23505` or `PGRST116`) stays internal.
 */
const EXPOSED_ERROR_CODES = new Set([
  'FREE_LIMIT_REACHED',
  'PREMIUM_REQUIRED',
  'ALREADY_ATTEMPTED',
  'PAYMENT_NOT_PENDING',
  'VALIDATION_FAILED',
  ...GROUP_ERROR_CODES,
]);

/**
 * A PostgREST error caused by a column/relation the code expects but the
 * connected database does not have. That is an operational state, so it is
 * reported as 503 (dependency unavailable) rather than an opaque 500.
 */
const isSchemaDriftError = (err: CustomError): boolean =>
  err.code === '42703' ||
  err.code === 'PGRST204' ||
  /column .* does not exist/i.test(err.message ?? '') ||
  /could not find the '.*' column/i.test(err.message ?? '');

// Global Error Handler
app.use((err: CustomError, req: Request, res: Response, next: NextFunction) => {
  const schemaDrift = isSchemaDriftError(err);
  const statusCode = err.status || err.statusCode || (schemaDrift ? 503 : 500);

  // Server-side failures were previously silent, which made production
  // incidents undiagnosable. Log the route and error only: never headers,
  // bodies, tokens or answer payloads.
  if (statusCode >= 500) {
    console.error('[api:error]', {
      method: req.method,
      path: req.originalUrl,
      status: statusCode,
      message: err.message
    });
  }

  // 4xx messages are intentionally actionable for the client; 5xx details
  // (SQL text, stack traces, internal identifiers) must never reach students.
  const message =
    statusCode >= 500
      ? schemaDrift
        ? 'A required service dependency is not available'
        : 'Internal Server Error'
      : err.message || 'Request failed';

  // Clients gate the paywall and the "already attempted" result link on a
  // machine-readable code plus its details, so the documented codes are
  // forwarded at the top level. Every other error keeps the existing
  // `{success,message,data}` shape, and internal PostgREST codes are never
  // exposed. 5xx responses never carry application details.
  const candidateCode =
    typeof err.errorCode === 'string' ? err.errorCode : typeof err.code === 'string' ? err.code : undefined;
  const code =
    candidateCode && statusCode < 500 && EXPOSED_ERROR_CODES.has(candidateCode)
      ? candidateCode
      : undefined;
  const details =
    statusCode < 500 && err.details !== undefined ? err.details : undefined;

  res.status(statusCode).json({
    success: false,
    message,
    data: null,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {})
  });
});

export default app;
