import { Router, Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';

const db = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

const router = Router();
const OTP_TTL = 300;
const ONLINE_WINDOW_MS = 60_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function normalizePhone(raw: unknown): string | null {
  let p = String(raw ?? '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('01')) p = '88' + p;
  return /^8801[3-9]\d{8}$/.test(p) ? p : null;
}

function hashCode(userId: string, phone: string, code: string): string {
  const secret = process.env.OTP_HMAC_SECRET;
  if (!secret) throw new Error('OTP_HMAC_SECRET missing');
  return createHmac('sha256', secret).update(`${userId}:${phone}:${code}`).digest('hex');
}

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ ok: false, code: 'UNAUTHORIZED' });
  (req as any).userId = data.user.id;
  next();
}

function requireGateway(req: Request, res: Response, next: NextFunction) {
  const key = process.env.SMS_GATEWAY_KEY || '';
  const got = String(req.headers['x-gateway-key'] || '');
  const a = Buffer.from(got);
  const b = Buffer.from(key);
  if (!key || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false });
  }
  next();
}

async function gatewayOnline(): Promise<boolean> {
  const { data } = await db
    .from('sms_gateway_status')
    .select('last_seen_at')
    .eq('id', 1)
    .maybeSingle();
  return !!data && Date.now() - new Date(data.last_seen_at).getTime() < ONLINE_WINDOW_MS;
}

let lastBeat = 0;
async function beat() {
  if (Date.now() - lastBeat < 10_000) return;
  lastBeat = Date.now();
  await db.from('sms_gateway_status').upsert({ id: 1, last_seen_at: new Date().toISOString() });
}

const REQUEST_MAP: Record<string, [number, object]> = {
  ok: [200, { ok: true, expiresIn: OTP_TTL, resendAfter: 60 }],
  already_verified: [200, { ok: true, alreadyVerified: true }],
  cooldown: [429, { ok: false, code: 'COOLDOWN', retryAfter: 60 }],
  rate_limited: [429, { ok: false, code: 'RATE_LIMITED' }],
  phone_taken: [409, { ok: false, code: 'PHONE_TAKEN' }],
};

const VERIFY_MAP: Record<string, [number, object]> = {
  ok: [200, { ok: true }],
  invalid: [400, { ok: false, code: 'INVALID_CODE' }],
  expired: [410, { ok: false, code: 'EXPIRED' }],
  too_many: [429, { ok: false, code: 'TOO_MANY_ATTEMPTS' }],
  phone_taken: [409, { ok: false, code: 'PHONE_TAKEN' }],
};

// ইউজার: OTP চাওয়া
router.post('/otp/request', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ ok: false, code: 'INVALID_PHONE' });

    if (!(await gatewayOnline())) {
      return res.status(503).json({ ok: false, code: 'GATEWAY_OFFLINE', fallback: 'email' });
    }

    const code = String(randomInt(100000, 1000000));
    const body = `Porokh code: ${code} (valid 5 min). Do not share it.`;
    const { data, error } = await db.rpc('request_phone_otp', {
      p_user_id: userId,
      p_phone: phone,
      p_code_hash: hashCode(userId, phone, code),
      p_body: body,
      p_ttl_seconds: OTP_TTL,
    });
    if (error) return res.status(500).json({ ok: false, code: 'DB_ERROR' });

    const [status, payload] = REQUEST_MAP[data as string] ?? [500, { ok: false, code: 'UNKNOWN' }];
    return res.status(status).json(payload);
  } catch {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
});

// ইউজার: OTP মেলানো
router.post('/otp/verify', requireUser, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId as string;
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code ?? '').trim();
    if (!phone || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, code: 'INVALID_INPUT' });
    }
    const { data, error } = await db.rpc('verify_phone_otp', {
      p_user_id: userId,
      p_phone: phone,
      p_code_hash: hashCode(userId, phone, code),
    });
    if (error) return res.status(500).json({ ok: false, code: 'DB_ERROR' });

    const [status, payload] = VERIFY_MAP[data as string] ?? [500, { ok: false, code: 'UNKNOWN' }];
    return res.status(status).json(payload);
  } catch {
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR' });
  }
});

// ফোন: নতুন SMS জব নেওয়া (long-poll, সর্বোচ্চ ২৫ সেকেন্ড অপেক্ষা)
router.get('/gateway/pending', requireGateway, async (req: Request, res: Response) => {
  const waitSec = Math.min(Math.max(Number(req.query.wait) || 0, 0), 25);
  const deadline = Date.now() + waitSec * 1000;
  let closed = false;
  res.on('close', () => { closed = true; });
  try {
    await beat();
    while (!closed) {
      const { data, error } = await db.rpc('claim_pending_sms', { p_limit: 5 });
      if (error) return res.status(500).json({ ok: false });
      if ((data && data.length) || Date.now() >= deadline) return res.json(data ?? []);
      await sleep(1000);
    }
  } catch {
    if (!res.headersSent) res.status(500).json({ ok: false });
  }
});

// ফোন: পাঠানো হয়েছে কিনা জানানো
router.post('/gateway/ack', requireGateway, async (req: Request, res: Response) => {
  const id = String(req.body?.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ ok: false });
  await db.rpc('ack_sms', {
    p_id: id,
    p_ok: req.body?.ok === true,
    p_error: req.body?.error ? String(req.body.error) : null,
  });
  return res.json({ ok: true });
});

export default router;
