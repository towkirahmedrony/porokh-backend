import { Request, Response } from 'express';
import catchAsync from '../../lib/utils/catchAsync';
import sendResponse from '../../lib/utils/response';
import * as SystemService from './system.service';
import speakeasy from 'speakeasy';
import nodemailer from 'nodemailer';
import { supabase } from '../../config/supabase';

// ... (requestAdminOTP code) ...
export const requestAdminOTP = catchAsync(async (req: Request, res: Response) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_PASSWORD }
  });

  const { data: adminProfile } = await supabase.from('profiles').select('email').eq('id', req.user!.id).single();
  const adminEmail = adminProfile?.email || (req as any).user?.email || process.env.SMTP_EMAIL;

  if (!adminEmail) {
    return res.status(400).json({ success: false, message: 'No valid admin email found to send OTP!' });
  }

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();

  await supabase.from('auth_otps').insert({
    otp_code: otpCode, phone_number: adminEmail, purpose: 'admin_emergency_action', expires_at: expiresAt, is_used: false
  });

  await transporter.sendMail({
    from: `"ParaPoth Admin" <${process.env.SMTP_EMAIL}>`,
    to: adminEmail, 
    subject: "Admin Action Authorization Code",
    text: `Your authorization code is: ${otpCode}\n\nIt will expire in 10 minutes. Please DO NOT share this code with anyone.`
  });

  sendResponse(res, { statusCode: 200, success: true, message: `OTP sent successfully to ${adminEmail}` });
});

// Home Grids
export const getHomeGrids = catchAsync(async (req: Request, res: Response) => {
  const grids = await SystemService.getActiveHomeGrids();
  sendResponse(res, { statusCode: 200, success: true, message: 'Home grids fetched successfully', data: grids });
});

export const upsertHomeGrid = catchAsync(async (req: Request, res: Response) => {
  const grid = await SystemService.upsertHomeGrid(req.body);
  await SystemService.createAuditLog(req.user!.id, 'UPSERT', 'home_grids', grid.id, req.body);
  sendResponse(res, { statusCode: 200, success: true, message: 'Grid updated successfully', data: grid });
});

export const deleteHomeGrid = catchAsync(async (req: Request, res: Response) => {
  await SystemService.deleteHomeGrid(req.params.id);
  await SystemService.createAuditLog(req.user!.id, 'DELETE', 'home_grids', req.params.id, null);
  sendResponse(res, { statusCode: 200, success: true, message: 'Grid deleted successfully', data: null });
});

export const reorderHomeGrids = catchAsync(async (req: Request, res: Response) => {
  await SystemService.reorderHomeGrids(req.body.grids);
  await SystemService.createAuditLog(req.user!.id, 'REORDER', 'home_grids', 'bulk_reorder', req.body.grids);
  sendResponse(res, { statusCode: 200, success: true, message: 'Grids reordered', data: null });
});

// App Configs & Theme
export const getAppConfigs = catchAsync(async (req: Request, res: Response) => {
  const { key } = req.params;
  
  if (key) {
    const config = await SystemService.getAppConfigByKey(key);
    if (!config) return sendResponse(res, { statusCode: 404, success: false, message: 'Config not found' });
    return sendResponse(res, { statusCode: 200, success: true, message: 'Config fetched', data: config });
  }

  const configs = await SystemService.getGlobalConfigs();
  sendResponse(res, { statusCode: 200, success: true, message: 'Configs fetched', data: configs });
});

export const updateAppConfig = catchAsync(async (req: Request, res: Response) => {
  const key = req.params.key || req.body.key;
  const valuePayload = { ...req.body };
  delete valuePayload.key;
  
  if (!key) return sendResponse(res, { statusCode: 400, success: false, message: 'Config key is required' });

  const config = await SystemService.upsertAppConfig(key, valuePayload);
  await SystemService.createAuditLog(req.user!.id, 'UPDATE', 'app_configs', key, valuePayload);
  sendResponse(res, { statusCode: 200, success: true, message: 'Config updated', data: config });
});

// New controller specifically for XP Rules
export const updateXPRules = catchAsync(async (req: Request, res: Response) => {
  const rules = req.body;
  const data = await SystemService.updateXPRules(rules);
  await SystemService.createAuditLog(req.user!.id, 'UPDATE', 'app_configs', 'xp_rules', rules);
  sendResponse(res, { statusCode: 200, success: true, message: 'XP rules updated successfully', data });
});

export const getThemeConfig = catchAsync(async (req: Request, res: Response) => {
  let theme = await SystemService.getGlobalThemeConfig();
  if (theme && theme.schedules && Array.isArray(theme.schedules)) {
    const now = new Date();
    const activeSchedules = theme.schedules.filter((s: any) => {
      if (!s.startDate || !s.endDate) return false;
      return now >= new Date(s.startDate) && now <= new Date(s.endDate);
    });

    if (activeSchedules.length > 0) {
      const activeSchedule = activeSchedules[0];
      if (activeSchedule.themeData) {
        theme.active_theme = activeSchedule.presetId;
        theme.colors = { ...theme.colors, ...activeSchedule.themeData.colors };
        theme.bgType = activeSchedule.themeData.bgType || 'color';
        theme.bgMediaUrl = activeSchedule.themeData.bgMediaUrl || '';
        theme.is_scheduled_override = true;
      }
    }
  }
  sendResponse(res, { statusCode: 200, success: true, message: 'Theme configuration fetched successfully', data: theme });
});

// Global Notice 
export const updateGlobalNotice = catchAsync(async (req: Request, res: Response) => {
  const notice = await SystemService.updateGlobalNotice(req.body);
  sendResponse(res, { statusCode: 200, success: true, message: 'Global notice updated successfully', data: notice });
});

export const getEmergencyFlags = catchAsync(async (req: Request, res: Response) => {
  const flags = await SystemService.getEmergencyFlags();
  sendResponse(res, { statusCode: 200, success: true, message: 'Flags fetched', data: flags });
});

export const createEmergencyFlag = catchAsync(async (req: Request, res: Response) => {
  const flag = await SystemService.createEmergencyFlag(req.body);
  await SystemService.createAuditLog(req.user!.id, 'CREATE', 'emergency_flags', flag.key, req.body);
  sendResponse(res, { statusCode: 201, success: true, message: 'Flag created', data: flag });
});

export const toggleEmergencyFlag = catchAsync(async (req: Request, res: Response) => {
  const { is_active, authCode } = req.body;
  const { data: adminProfile } = await supabase.from('profiles').select('email').eq('id', req.user!.id).single();
  const adminEmail = adminProfile?.email || (req as any).user?.email || process.env.SMTP_EMAIL;
  let isAuthorized = false;
  const adminTotpSecret = process.env.ADMIN_TOTP_SECRET || "JBSWY3DPEHPK3PXP"; 
  const isTotpValid = speakeasy.totp.verify({ secret: adminTotpSecret, encoding: 'base32', token: authCode, window: 1 });
  if (isTotpValid) {
    isAuthorized = true;
  } else {
    const { data: otpRecord } = await supabase.from('auth_otps').select('*').eq('phone_number', adminEmail).eq('otp_code', authCode).eq('purpose', 'admin_emergency_action').eq('is_used', false).gte('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1).single();
    if (otpRecord) {
      isAuthorized = true;
      await supabase.from('auth_otps').update({ is_used: true }).eq('id', otpRecord.id);
    }
  }
  if (!isAuthorized) return res.status(401).json({ success: false, message: 'Invalid Auth Code!' });
  const flag = await SystemService.toggleEmergencyFlag(req.params.key, is_active);
  await SystemService.createAuditLog(req.user!.id, is_active ? 'ACTIVATED' : 'DEACTIVATED', 'emergency_flags', req.params.key, { status: is_active });
  sendResponse(res, { statusCode: 200, success: true, message: 'Flag updated', data: flag });
});

export const getSupportTickets = catchAsync(async (req: Request, res: Response) => {
  const tickets = await SystemService.getSupportTickets();
  sendResponse(res, { statusCode: 200, success: true, message: 'Tickets fetched', data: tickets });
});

export const updateSupportTicket = catchAsync(async (req: Request, res: Response) => {
  const adminId = req.user!.id;
  const updates = { ...req.body };
  if (updates.status === 'resolved') updates.resolved_by = adminId;
  const ticket = await SystemService.updateSupportTicket(req.params.id, updates);
  await SystemService.createAuditLog(adminId, 'UPDATE', 'user_reports', req.params.id, updates);
  sendResponse(res, { statusCode: 200, success: true, message: 'Ticket updated', data: ticket });
});

export const getAuditLogs = catchAsync(async (req: Request, res: Response) => {
  const logs = await SystemService.getAuditLogs();
  sendResponse(res, { statusCode: 200, success: true, message: 'Logs fetched', data: logs });
});

export const getAdminAlerts = catchAsync(async (req: Request, res: Response) => {
  const alerts = await SystemService.getAdminAlerts();
  sendResponse(res, { statusCode: 200, success: true, message: 'Alerts fetched', data: alerts });
});

export const resolveAdminAlert = catchAsync(async (req: Request, res: Response) => {
  const adminId = req.user!.id;
  const alert = await SystemService.resolveAdminAlert(req.params.id, adminId);
  await SystemService.createAuditLog(adminId, 'RESOLVE', 'admin_alerts', req.params.id, { status: 'resolved' });
  sendResponse(res, { statusCode: 200, success: true, message: 'Alert resolved', data: alert });
});
