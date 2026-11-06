import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as UsersAdminService from './users.admin.service';
import * as UsersRolesService from './users.roles.service';
import { parseDirectoryQuery, toCsv, MAX_EXPORT_ROWS } from './users.admin.query';
import { UsersAdminError } from './users.admin.types';

const actorOf = (req: Request): string => {
  const actorId = (req as any).user?.id;
  if (!actorId) throw new UsersAdminError('Administrator identity is required', 401);
  return actorId;
};

const tokenOf = (req: Request): string => {
  const token = (req as any).accessToken;
  if (!token) throw new UsersAdminError('Session unavailable', 401);
  return token;
};

export const getUsersList = catchAsync(async (req: Request, res: Response) => {
  const query = parseDirectoryQuery(req.query as Record<string, unknown>);
  const result = await UsersAdminService.listUsers(query);
  sendResponse(res, { statusCode: 200, success: true, message: 'Users retrieved successfully', data: result });
});

export const exportUsers = catchAsync(async (req: Request, res: Response) => {
  const query = parseDirectoryQuery(req.query as Record<string, unknown>);
  const rows = await UsersAdminService.listUsersForExport(query, MAX_EXPORT_ROWS);

  const csv = toCsv(
    [
      'id',
      'full_name',
      'email',
      'username',
      'phone_number',
      'account_status',
      'subscription_status',
      'role',
      'class_level',
      'institution',
      'total_xp',
      'coin_balance',
      'current_streak',
      'created_at',
      'last_active_at',
    ],
    rows.map((row) => [
      row.id,
      row.full_name,
      row.email,
      row.username,
      row.phone_number,
      row.account_status,
      row.access.subscription_status,
      row.role,
      row.class_level,
      row.institution,
      row.total_xp,
      row.coin_balance,
      row.current_streak,
      row.created_at,
      row.last_active_at,
    ])
  );

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="porokh-users-${stamp}.csv"`);
  res.status(200).send(csv);
});

export const getUser360 = catchAsync(async (req: Request, res: Response) => {
  const data = await UsersAdminService.getUser360Profile(req.params.userId);
  sendResponse(res, { statusCode: 200, success: true, message: 'User 360 profile retrieved successfully', data });
});

export const updateAccountStatus = catchAsync(async (req: Request, res: Response) => {
  const status = req.body?.status;
  const data = await UsersAdminService.setAccountStatus(
    actorOf(req),
    req.params.userId,
    status,
    tokenOf(req)
  );
  sendResponse(res, { statusCode: 200, success: true, message: 'Account status updated', data });
});

export const forceLogout = catchAsync(async (req: Request, res: Response) => {
  const data = await UsersAdminService.forceLogoutUser(actorOf(req), req.params.userId, tokenOf(req));
  sendResponse(res, { statusCode: 200, success: true, message: 'All sessions revoked', data });
});

export const adjustBalance = catchAsync(async (req: Request, res: Response) => {
  const amount = Number(req.body?.amount);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
  const data = await UsersAdminService.adjustCoinBalance(
    actorOf(req),
    req.params.userId,
    amount,
    reason
  );
  sendResponse(res, { statusCode: 200, success: true, message: 'Coin balance updated', data });
});

export const getRiskAccounts = catchAsync(async (_req: Request, res: Response) => {
  const data = await UsersAdminService.listRiskAccounts();
  sendResponse(res, { statusCode: 200, success: true, message: 'Risk data retrieved', data });
});

export const getRiskAccount = catchAsync(async (req: Request, res: Response) => {
  const data = await UsersAdminService.getAccountRiskDetail(req.params.userId);
  sendResponse(res, { statusCode: 200, success: true, message: 'Account risk detail retrieved', data });
});

export const getRoles = catchAsync(async (req: Request, res: Response) => {
  const data = await UsersRolesService.getRolesOverview(actorOf(req));
  sendResponse(res, { statusCode: 200, success: true, message: 'Roles retrieved', data });
});

export const assignRole = catchAsync(async (req: Request, res: Response) => {
  const role = typeof req.body?.role === 'string' ? req.body.role : '';
  const isActive = req.body?.is_active === undefined ? true : req.body.is_active === true;

  const data = await UsersRolesService.assignUserRole(req.params.userId, role, isActive, tokenOf(req));
  sendResponse(res, { statusCode: 200, success: true, message: 'User role updated', data });
});

export const getRoleAuditLog = catchAsync(async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const data = await UsersRolesService.getRoleAudit(limit);
  sendResponse(res, { statusCode: 200, success: true, message: 'Role audit history retrieved', data });
});
