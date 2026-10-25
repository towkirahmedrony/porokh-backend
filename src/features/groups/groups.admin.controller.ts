import { Request, Response } from 'express';
import { z } from 'zod';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { groupError } from './groups.errors';
import { SLUG_PATTERN } from './groups.validation';
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
const slugSchema = z.string().regex(SLUG_PATTERN);

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
  slug: slugSchema.optional(),
});

const updateGroupSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  icon: z.string().max(16).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
  slug: slugSchema.optional(),
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

const kickMemberSchema = z.object({
  banHours: z.number().int().min(1).max(8760).optional(),
});

const moderationQuerySchema = z.object({
  status: z.enum(['pending', 'reviewed', 'ignored', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

const moderationReasonSchema = z.object({
  reason: z.string().max(300).nullable().optional(),
});

const moderationBanSchema = z.object({
  banHours: z.number().int().min(1).max(8760).optional(),
});

const dictionaryCreateSchema = z.object({
  word: z.string().min(1).max(100),
  matchType: z.enum(['contains', 'exact']).optional(),
  autoDelete: z.boolean().optional(),
});

const dictionaryUpdateSchema = z.object({
  word: z.string().min(1).max(100).optional(),
  matchType: z.enum(['contains', 'exact']).optional(),
  autoDelete: z.boolean().optional(),
});

const settingKeySchema = z.enum([
  'group_squad_default_members',
  'group_squad_max_members',
  'group_community_max_members',
  'group_battle_participation_xp',
  'group_battle_winner_bonus_xp',
  'group_leaderboard_min_members',
]);

const settingsUpdateSchema = z
  .object({
    settings: z.record(settingKeySchema, z.number().int().min(1).max(500)),
  })
  .strict();

const leaderboardQuerySchema = z.object({
  period: z.enum(['weekly', 'monthly', 'all_time']).default('weekly'),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(50).optional(),
});

const groupMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.string().optional(),
});

const userSearchSchema = z.object({
  q: z.string().max(50).optional(),
  groupId: z.string().uuid().optional(),
});

export const getModerationQueue = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(moderationQuerySchema, req.query);
  const data = await adminGroupsService.listModerationQueue(query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Moderation queue fetched',
    data,
  });
});

export const ignoreModerationFlag = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const flagId = parseWith(uuidSchema, req.params.flagId);
  const data = await adminGroupsService.ignoreFlaggedMessage(actorId, flagId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Report ignored', data });
});

export const warnModerationFlag = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const flagId = parseWith(uuidSchema, req.params.flagId);
  const body = parseWith(moderationReasonSchema, req.body ?? {});
  const data = await adminGroupsService.warnFlaggedMessage(actorId, flagId, body.reason ?? null);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Warning issued', data });
});

export const deleteModerationFlag = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const flagId = parseWith(uuidSchema, req.params.flagId);
  const data = await adminGroupsService.deleteFlaggedMessage(actorId, flagId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Message deleted', data });
});

export const banModerationFlag = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const flagId = parseWith(uuidSchema, req.params.flagId);
  const body = parseWith(moderationBanSchema, req.body ?? {});
  const data = await adminGroupsService.banFlaggedSender(actorId, flagId, body.banHours ?? 24);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Sender banned', data });
});

export const getDictionary = catchAsync(async (_req: Request, res: Response) => {
  const data = await adminGroupsService.listDictionaryEntries();
  return sendResponse(res, { statusCode: 200, success: true, message: 'Dictionary fetched', data });
});

export const createDictionary = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const body = parseWith(dictionaryCreateSchema, req.body);
  const data = await adminGroupsService.createDictionaryEntry(actorId, body);
  return sendResponse(res, { statusCode: 201, success: true, message: 'Word added', data });
});

export const updateDictionary = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const entryId = parseWith(uuidSchema, req.params.entryId);
  const body = parseWith(dictionaryUpdateSchema, req.body);
  const data = await adminGroupsService.updateDictionaryEntry(actorId, entryId, body);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Word updated', data });
});

export const deleteDictionary = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const entryId = parseWith(uuidSchema, req.params.entryId);
  const data = await adminGroupsService.deleteDictionaryEntry(actorId, entryId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Word removed', data });
});

export const getSettings = catchAsync(async (_req: Request, res: Response) => {
  const data = await adminGroupsService.getAdminGroupSettings();
  return sendResponse(res, { statusCode: 200, success: true, message: 'Settings fetched', data });
});

export const updateSettings = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const body = parseWith(settingsUpdateSchema, req.body);
  const data = await adminGroupsService.updateAdminGroupSettings(actorId, body.settings);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Settings updated', data });
});

export const getLeaderboard = catchAsync(async (req: Request, res: Response) => {
  const query = parseWith(leaderboardQuerySchema, req.query);
  const data = await adminGroupsService.getAdminGroupLeaderboard(query);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Leaderboard fetched', data });
});

export const refreshLeaderboard = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const data = await adminGroupsService.refreshAdminGroupLeaderboard(actorId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Leaderboard refreshed', data });
});

export const getGroupMessages = catchAsync(async (req: Request, res: Response) => {
  const groupId = parseWith(uuidSchema, req.params.id);
  const query = parseWith(groupMessagesQuerySchema, req.query);
  const data = await adminGroupsService.getAdminGroupMessages(groupId, query);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Messages fetched', data });
});

export const deleteGroupMessage = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const messageId = parseWith(uuidSchema, req.params.messageId);
  const data = await adminGroupsService.adminDeleteGroupMessage(actorId, groupId, messageId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Message deleted', data });
});

export const getGroupFlags = catchAsync(async (req: Request, res: Response) => {
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await adminGroupsService.listAdminGroupFlags(groupId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Flags fetched', data });
});

export const cancelGroupBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const battleId = parseWith(uuidSchema, req.params.battleId);
  const data = await adminGroupsService.adminCancelGroupBattle(actorId, groupId, battleId);
  return sendResponse(res, { statusCode: 200, success: true, message: 'Battle cancelled', data });
});

export const kickGroupMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const actorId = requireActorId(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const userId = parseWith(uuidSchema, req.params.userId);
  const body = parseWith(kickMemberSchema, req.body ?? {});
  const data = await adminGroupsService.adminKickGroupMember(
    actorId,
    groupId,
    userId,
    body.banHours ?? 24
  );
  return sendResponse(res, { statusCode: 200, success: true, message: 'Member banned', data });
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
