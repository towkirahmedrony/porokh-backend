import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as SupportService from './support.service';
import {
  parseSupportAdminListQuery,
  parseSupportAssignment,
  parseSupportPriorityUpdate,
  parseSupportReply,
  parseSupportStatusUpdate,
  parseSupportTicketId,
} from './support.validation';

export const listTickets = catchAsync(async (req: Request, res: Response) => {
  const query = parseSupportAdminListQuery(req.query, req.user!.id);
  const result = await SupportService.listAllTickets(query, req.user!.id);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support tickets fetched successfully',
    data: result,
  });
});

export const getStats = catchAsync(async (_req: Request, res: Response) => {
  const stats = await SupportService.getSupportStats();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support metrics fetched successfully',
    data: stats,
  });
});

export const listAgents = catchAsync(async (_req: Request, res: Response) => {
  const agents = await SupportService.listSupportAgents();

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support agents fetched successfully',
    data: agents,
  });
});

export const getTicket = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const ticket = await SupportService.getAdminTicketDetail(ticketId);

  if (!ticket) {
    return sendResponse(res, {
      statusCode: 404,
      success: false,
      message: 'Support ticket not found',
      data: null,
    });
  }

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support ticket fetched successfully',
    data: ticket,
  });
});

export const replyToTicket = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const body = parseSupportReply(req.body);
  const ticket = await SupportService.addAdminReply(req.user!.id, ticketId, body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Reply sent successfully',
    data: ticket,
  });
});

export const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const status = parseSupportStatusUpdate(req.body);
  const ticket = await SupportService.setTicketStatus(req.user!.id, ticketId, status);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Ticket status updated',
    data: ticket,
  });
});

export const updatePriority = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const priority = parseSupportPriorityUpdate(req.body);
  const ticket = await SupportService.setTicketPriority(ticketId, priority);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Ticket priority updated',
    data: ticket,
  });
});

export const updateAssignment = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const assignedTo = parseSupportAssignment(req.body);
  const ticket = await SupportService.setTicketAssignment(ticketId, assignedTo);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: assignedTo ? 'Ticket assigned' : 'Ticket unassigned',
    data: ticket,
  });
});
