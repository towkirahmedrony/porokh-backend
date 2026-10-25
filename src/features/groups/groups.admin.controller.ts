import { Request, Response } from 'express';
import { z } from 'zod';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { groupError } from './groups.errors';
import * as adminGroupsService from './groups.admin.service';

interface AuthRequest extends Request {
  user?: { id: string };
}

const requireActorId = (req: AuthRequest): string => {
  const actorId = req.user?.id;
  if (!actorId) throw groupError('AUTH_REQUIRED', 401);
  return actorId;
};

const parseWith = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw groupError('VALIDATION_FAILED', 400);
  return parsed.data;
};

const uuidSchema = z.string().uuid();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  q: z.string().max(50).optional(),
  type: z.enum(['squad', 'community']).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
  sort: z
    .enum(['created_at', 'updated_at', 'name', 'member_count', 'total_xp', 'group_level'])
    .optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});

const createGroupSchema = z.object({
  name: z.string().min(2).max(50),
  icon: z.string().max(16).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  groupType: z.enum(['squad', 'community']).optional(),
  maxMembers: z.number().int().min(2).max(500).optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  icon: z.string().max(16).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
  maxMembers: z.number().int().min(2).max(500).optional(),
  isActive: z.boolean().optional(),
  regenerateJoinCode: z.boolean().optional(),
});

const statusSchema = z.object({ isActive: z.boolean() });

const memberQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
  q: z.string().max(50).optional(),
  status: z.enum(['active', 'pending', 'invited', 'left', 'kicked']).optional(),
  role: z.enum(['admin', 'member']).optional(),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['admin', 'member']).optional(),
});

const memberRoleSchema = z.object({ role: z.enum(['admin', 'member']) });

const transferOwnerSchema = z.object({ userId: z.string().uuid() });

const userSearchSchema = z.object({
  q: z.string().max(50).optional(),
  groupId: z.string().uuid().optional(),
});

export const getGroups = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(listQuerySchema, req.query);
  const data = await adminGroupsService.listAdminGroups(query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Groups fetched',
    data,
  });
});

export const getGroupStats = catchAsync(async (_req: Request, res: Response) => {
  const data = await adminGroupsService.getAdminGroupStats();
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group statistics fetched',
    data,
  });
});

export const searchUsers = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(userSearchSchema, req.query);
  const data = await adminGroupsService.searchGroupUsers(query.q ?? '', query.groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Users fetched',
    data,
  });
});

export const createGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const body = parseWith(createGroupSchema, req.body);
  const data = await adminGroupsService.createAdminGroup(actorId, body);
  return sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Group created',
    data,
  });
});

export const getGroup = catchAsync(async (req: Request, res: Response) => {
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await adminGroupsService.getAdminGroupDetail(groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group fetched',
    data,
  });
});

export const updateGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(updateGroupSchema, req.body);
  const data = await adminGroupsService.updateAdminGroup(actorId, groupId, body);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group updated',
    data,
  });
});

export const setGroupStatus = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(statusSchema, req.body);
  const data = await adminGroupsService.setAdminGroupStatus(actorId, groupId, body.isActive);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: body.isActive ? 'Group activated' : 'Group archived',
    data,
  });
});

export const getGroupMembers = catchAsync(async (req: Request, res: Response) => {
  const groupId = parseWith(uuidSchema, req.params.id);
  const query = parseWith(memberQuerySchema, req.query);
  const data = await adminGroupsService.listAdminGroupMembers(groupId, query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group members fetched',
    data,
  });
});

export const addGroupMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(addMemberSchema, req.body);
  const data = await adminGroupsService.addAdminGroupMember(actorId, groupId, body);
  return sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Member added',
    data,
  });
});

export const updateGroupMemberRole = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const userId = parseWith(uuidSchema, req.params.userId);
  const body = parseWith(memberRoleSchema, req.body);
  const data = await adminGroupsService.setAdminGroupMemberRole(
    actorId,
    groupId,
    userId,
    body.role
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Member role updated',
    data,
  });
});

export const removeGroupMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const userId = parseWith(uuidSchema, req.params.userId);
  const data = await adminGroupsService.removeAdminGroupMember(actorId, groupId, userId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Member removed',
    data,
  });
});

export const transferGroupOwnership = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(transferOwnerSchema, req.body);
  const data = await adminGroupsService.transferAdminGroupOwnership(
    actorId,
    groupId,
    body.userId
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: data.transferred ? 'Ownership transferred' : 'User already owns the group',
    data,
  });
});
