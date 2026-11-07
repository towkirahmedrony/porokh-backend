import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as SupportService from './support.service';
import {
  parseCreateSupportTicket,
  parseSupportListQuery,
  parseSupportReply,
  parseSupportTicketId,
} from './support.validation';

export const createTicket = catchAsync(async (req: Request, res: Response) => {
  const input = parseCreateSupportTicket(req.body);
  const ticket = await SupportService.createSupportTicket(req.user!.id, input);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Support request submitted successfully',
    data: ticket,
  });
});

export const listTickets = catchAsync(async (req: Request, res: Response) => {
  const query = parseSupportListQuery(req.query);
  const result = await SupportService.listStudentTickets(req.user!.id, query);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support requests fetched successfully',
    data: result,
  });
});

export const getTicket = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const ticket = await SupportService.getStudentTicketDetail(req.user!.id, ticketId);

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
  const ticket = await SupportService.addStudentReply(req.user!.id, ticketId, body);

  sendResponse(res, {
    statusCode: 201,
    success: true,
    message: 'Reply sent successfully',
    data: ticket,
  });
});

export const reopenTicket = catchAsync(async (req: Request, res: Response) => {
  const ticketId = parseSupportTicketId(req.params.id);
  const ticket = await SupportService.reopenStudentTicket(req.user!.id, ticketId);

  sendResponse(res, {
    statusCode: 200,
    success: true,
    message: 'Support ticket reopened',
    data: ticket,
  });
});
