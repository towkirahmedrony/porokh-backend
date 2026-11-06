import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { PERMISSIONS } from '../../middlewares/authorization';
import { parseDashboardRange } from './dashboard.metrics';
import * as dashboardService from './dashboard.admin.service';
import { withDashboardCache } from './dashboard.cache';
import type { DashboardCapabilities } from './dashboard.types';

/**
 * The overview and health payloads also carry capability flags, so the admin
 * UI can hide surfaces this admin may not open. The flags are derived from the
 * verified role on the server; the client never decides access on its own.
 */
const OVERVIEW_TTL_MS = 30_000;
const ANALYTICS_TTL_MS = 30_000;
const HEALTH_TTL_MS = 15_000;
const ACTIVITY_TTL_MS = 10_000;

type DashboardRequest = Request & { userRole?: string; accessToken?: string };

const roleOf = (req: Request): string => (req as DashboardRequest).userRole ?? 'unknown';

const queryString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const resolveCapabilities = async (req: Request): Promise<DashboardCapabilities> => {
  const role = roleOf(req);
  const token = (req as DashboardRequest).accessToken;
  let auditLogs = role === 'super_admin';

  if (!auditLogs && token) {
    try {
      const { data, error } = await createUserSupabaseClient(token).rpc('has_permission', {
        p_action: PERMISSIONS.AUDIT_LOGS_READ,
      });
      auditLogs = !error && data === true;
    } catch {
      auditLogs = false;
    }
  }

  return {
    auditLogs,
    securityAlerts: role === 'super_admin',
    finance: role === 'admin' || role === 'super_admin',
  };
};

export const getOverview = catchAsync(async (req: Request, res: Response) => {
  const range = parseDashboardRange(queryString(req.query.from), queryString(req.query.to));
  const capabilities = await resolveCapabilities(req);
  const role = roleOf(req);

  const data = await withDashboardCache(
    `overview:${role}:${range.fromIso}:${range.toIso}`,
    OVERVIEW_TTL_MS,
    () => dashboardService.getOverview(range, capabilities)
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Dashboard overview fetched successfully',
    data,
  });
});

export const getAnalytics = catchAsync(async (req: Request, res: Response) => {
  const range = parseDashboardRange(queryString(req.query.from), queryString(req.query.to));
  const role = roleOf(req);

  const data = await withDashboardCache(
    `analytics:${role}:${range.fromIso}:${range.toIso}`,
    ANALYTICS_TTL_MS,
    () => dashboardService.getAnalytics(range)
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Dashboard analytics fetched successfully',
    data,
  });
});

export const getHealth = catchAsync(async (req: Request, res: Response) => {
  const role = roleOf(req);

  const data = await withDashboardCache(`health:${role}`, HEALTH_TTL_MS, () =>
    dashboardService.getHealth(role)
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Dashboard health fetched successfully',
    data,
  });
});

export const getActivity = catchAsync(async (req: Request, res: Response) => {
  const limit = Number.parseInt(queryString(req.query.limit) ?? '10', 10) || 10;
  const offset = Number.parseInt(queryString(req.query.offset) ?? '0', 10) || 0;

  const data = await withDashboardCache(`activity:${limit}:${offset}`, ACTIVITY_TTL_MS, () =>
    dashboardService.getActivity(limit, offset)
  );

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Recent admin activity fetched successfully',
    data,
  });
});
