import { Request, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { createPublicSupabaseClient } from '../../config/publicSupabase';
import { groupError } from './groups.errors';
import * as groupsService from './groups.service';
import * as battleService from './groups.battle.service';
import { runGroupsTick } from '../../jobs/group.job';
import { isOffenseType, SLUG_PATTERN } from './groups.validation';

interface AuthRequest extends Request {
  user?: { id: string };
  accessToken?: string;
}

const getAuthContext = (req: AuthRequest) => {
  const userId = req.user?.id;
  const accessToken = req.accessToken;

  if (!userId || !accessToken) throw groupError('AUTH_REQUIRED', 401);

  return { userId, client: createUserSupabaseClient(accessToken) };
};

const parseWith = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw groupError('VALIDATION_FAILED', 400);
  }
  return parsed.data;
};

const uuidSchema = z.string().uuid();
const slugSchema = z.string().regex(SLUG_PATTERN);
const groupIdentifierSchema = z.union([uuidSchema, slugSchema]);
const messageIdSchema = z.string().uuid();

const createGroupSchema = z.object({
  name: z.string(),
  icon: z.string().max(16).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  groupType: z.enum(['squad', 'community']).optional(),
  maxMembers: z.number().int().min(2).max(500).nullable().optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
  slug: slugSchema.optional(),
});

const joinSchema = z.object({
  groupId: uuidSchema,
  joinCode: z.string().max(16).nullable().optional(),
});

const joinByCodeSchema = z.object({
  joinCode: z.string().min(1).max(16),
});

const updateGroupSchema = z.object({
  name: z.string().optional(),
  icon: z.string().max(16).nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  visibility: z.enum(['public', 'code', 'approval']).optional(),
  slug: slugSchema.optional(),
  maxMembers: z.number().int().min(2).max(500).optional(),
  regenerateJoinCode: z.boolean().optional(),
  disband: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const reviewSchema = z.object({ approve: z.boolean() });

const kickSchema = z.object({
  banHours: z.number().int().min(1).max(8760).nullable().optional(),
});

const messageSchema = z.object({
  content: z.string().min(1).max(500),
  messageType: z.enum(['text', 'emoji', 'question_share']).optional(),
  replyToId: uuidSchema.nullable().optional(),
});

const reportMessageSchema = z.object({
  offenseType: z.string().refine(isOffenseType, 'INVALID_OFFENSE_TYPE'),
  reason: z.string().max(200).nullable().optional(),
});

const createBattleSchema = z.object({
  title: z.string().min(2).max(100),
  subjectId: z.string().nullable().optional(),
  chapterId: z.string().nullable().optional(),
  questionCount: z.number().int().min(5).max(50),
  durationMinutes: z.number().int().min(1).max(180),
  startTime: z.string().nullable().optional(),
});

const submitBattleSchema = z.object({
  answers: z.record(z.union([z.string(), z.number(), z.null()])),
});

export const getPublicPreview = catchAsync(async (req: Request, res: Response) => {
  const identifier = parseWith(groupIdentifierSchema, req.params.identifier);
  const data = await groupsService.getGroupPreview(
    createPublicSupabaseClient(),
    identifier
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group preview fetched',
    data,
  });
});

export const getConfig = catchAsync(async (_req: Request, res: Response) => {
  const config = await groupsService.getGroupsConfig();
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group config fetched',
    data: config,
  });
});

export const getMyGroups = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const data = await groupsService.getMyGroups(client, userId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'My groups fetched',
    data,
  });
});

export const discover = catchAsync(async (req: AuthRequest, res: Response) => {
  const { client } = getAuthContext(req);
  const query = parseWith(
    z.object({
      type: z.enum(['squad', 'community']).optional(),
      q: z.string().max(50).optional(),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(50).optional(),
    }),
    req.query
  );

  const data = await groupsService.discoverGroups(client, query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Groups fetched',
    data,
  });
});

export const createGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const body = parseWith(createGroupSchema, req.body);
  const data = await groupsService.createGroup(client, userId, body);
  return sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Group created',
    data,
  });
});

export const joinGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const { client } = getAuthContext(req);
  const body = parseWith(joinSchema, req.body);
  const data = await groupsService.joinGroup(client, body.groupId, body.joinCode ?? null);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: data.result === 'pending' ? 'Join request sent' : 'Joined group',
    data,
  });
});

export const joinByCode = catchAsync(async (req: AuthRequest, res: Response) => {
  const { client } = getAuthContext(req);
  const body = parseWith(joinByCodeSchema, req.body);
  const data = await groupsService.joinGroupByCode(client, body.joinCode);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: data.result === 'pending' ? 'Join request sent' : 'Joined group',
    data,
  });
});

export const leaveGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const { client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await groupsService.leaveGroup(client, groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Left group',
    data,
  });
});

export const getGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const identifier = parseWith(groupIdentifierSchema, req.params.id);
  const data = await groupsService.getGroupDetail(client, userId, identifier);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group fetched',
    data,
  });
});

export const updateGroup = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(updateGroupSchema, req.body);
  const data = await groupsService.updateGroup(client, userId, groupId, body);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group updated',
    data,
  });
});

export const getJoinCode = catchAsync(async (req: AuthRequest, res: Response) => {
  const { client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await groupsService.getJoinCode(client, groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Join code fetched',
    data,
  });
});

export const getJoinRequests = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await groupsService.getJoinRequests(client, userId, groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Join requests fetched',
    data,
  });
});

export const reviewJoinRequest = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const targetUserId = parseWith(uuidSchema, req.params.userId);
  const body = parseWith(reviewSchema, req.body);
  const data = await groupsService.reviewJoinRequest(
    client,
    userId,
    groupId,
    targetUserId,
    body.approve
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Join request reviewed',
    data,
  });
});

export const kickMember = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const targetUserId = parseWith(uuidSchema, req.params.userId);
  const body = parseWith(kickSchema, req.body ?? {});
  const data = await groupsService.kickGroupMember(
    client,
    userId,
    groupId,
    targetUserId,
    body.banHours ?? null
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Member removed',
    data,
  });
});

export const getLeaderboard = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const query = parseWith(
    z.object({
      period: z.enum(['weekly', 'monthly', 'all_time']).default('weekly'),
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(50).optional(),
    }),
    req.query
  );

  const data = await groupsService.getGroupLeaderboard(client, userId, query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Group leaderboard fetched',
    data,
  });
});

export const getMessages = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const query = parseWith(
    z.object({
      before: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
    req.query
  );

  const data = await groupsService.listMessages(client, userId, groupId, query);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Messages fetched',
    data,
  });
});

export const postMessage = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(messageSchema, req.body);
  const data = await groupsService.createMessage(client, userId, groupId, body);
  return sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Message sent',
    data,
  });
});

export const deleteMessage = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const messageId = parseWith(messageIdSchema, req.params.messageId);
  const data = await groupsService.deleteMessage(client, userId, messageId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Message deleted',
    data,
  });
});

export const reportMessage = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const messageId = parseWith(messageIdSchema, req.params.messageId);
  const body = parseWith(reportMessageSchema, req.body);
  const data = await groupsService.reportMessage(
    client,
    userId,
    messageId,
    body.offenseType,
    body.reason ?? null
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Message reported',
    data,
  });
});

export const createBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(createBattleSchema, req.body);
  const data = await battleService.createBattle(client, userId, groupId, body);
  return sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Battle created',
    data,
  });
});

export const listBattles = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const groupId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.listGroupBattles(client, userId, groupId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battles fetched',
    data,
  });
});

export const getBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.getBattleDetail(client, userId, battleId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battle fetched',
    data,
  });
});

export const joinBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.joinBattle(client, userId, battleId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Joined battle',
    data,
  });
});

export const getBattleQuestions = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.getBattleQuestions(client, userId, battleId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battle questions fetched',
    data,
  });
});

export const submitBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const body = parseWith(submitBattleSchema, req.body);
  const data = await battleService.submitBattleAnswers(
    client,
    userId,
    battleId,
    body.answers as Record<string, unknown>
  );
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battle submitted',
    data,
  });
});

export const cancelBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.cancelBattle(client, userId, battleId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battle cancelled',
    data,
  });
});

export const finalizeBattle = catchAsync(async (req: AuthRequest, res: Response) => {
  const { userId, client } = getAuthContext(req);
  const battleId = parseWith(uuidSchema, req.params.id);
  const data = await battleService.finalizeBattle(client, userId, battleId);
  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Battle finalized',
    data,
  });
});

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

export const groupsTick = catchAsync(async (req: Request, res: Response) => {
  const configuredSecret = process.env.CRON_SECRET ?? '';

  if (!configuredSecret) {
    return res.status(503).json({
      success: false,
      message: 'CRON_SECRET is not configured',
      data: null,
    });
  }

  const headerSecret =
    req.header('x-cron-secret') ??
    (req.header('authorization')?.startsWith('Bearer ')
      ? req.header('authorization')?.slice('Bearer '.length)
      : '') ??
    '';

  if (!safeEqual(headerSecret, configuredSecret)) {
    return res.status(401).json({
      success: false,
      message: 'CRON_UNAUTHORIZED',
      data: null,
      code: 'CRON_UNAUTHORIZED',
    });
  }

  const data = await runGroupsTick();

  return sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Groups tick completed',
    data,
  });
});
