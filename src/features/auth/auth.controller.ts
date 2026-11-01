import { Request, Response } from 'express';
import { ADMIN_ROLES, authService } from './auth.service';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import crypto from 'crypto';

const isAdminRole = (role: string): boolean =>
  (ADMIN_ROLES as readonly string[]).includes(role);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

const readRegisterError = (message: string): { status: number; code: string } => {
  const normalized = message.toLowerCase();

  if (normalized.includes('already registered') || normalized.includes('already exists')) {
    return { status: 409, code: 'EMAIL_ALREADY_REGISTERED' };
  }
  if (normalized.includes('password')) {
    return { status: 400, code: 'WEAK_PASSWORD' };
  }
  if (normalized.includes('rate limit') || normalized.includes('too many')) {
    return { status: 429, code: 'RATE_LIMITED' };
  }

  return { status: 400, code: 'REGISTRATION_FAILED' };
};

const getClientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const realIp = req.headers['x-real-ip'];
  const cfIp = req.headers['cf-connecting-ip'];
  
  let ip = '';
  if (req.ips && req.ips.length > 0) ip = req.ips[0];
  else if (typeof forwarded === 'string') ip = forwarded.split(',')[0].trim();
  else if (Array.isArray(forwarded)) ip = forwarded[0];
  else if (realIp) ip = realIp as string;
  else if (cfIp) ip = cfIp as string;
  else ip = req.ip || req.socket.remoteAddress || '';

  if (ip.includes('::ffff:')) ip = ip.split(':').pop() || '';
  return ip;
};

export const authController = {
  async logout(req: Request, res: Response) {
    const accessToken = (req as any).accessToken as string | undefined;
    if (!accessToken) return res.status(401).json({ error: 'Unauthorized' });
    try {
      await authService.revokeApplicationSession(accessToken);
      return res.status(200).json({ success: true });
    } catch {
      return res.status(503).json({ error: 'Unable to revoke the application session' });
    }
  },

  async getProfile(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id; 
      if (!userId) return res.status(401).json({ error: 'Unauthorized user' });
      const profile = await authService.getProfile(userId);
      authService.updateLastActive(userId).catch(console.error);
      return res.status(200).json(profile);
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  },

  async getRoleAndPermissions(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      if (!userId) return res.status(401).json({ error: 'Unauthorized user' });
      const role = await authService.getUserRole(userId);
      const permissions = await authService.getUserPermissions(role);
      return res.status(200).json({ role, permissions });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  },

  async setup2FA(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;
      const email = (req as any).user?.email || 'admin@parapoth.com';
      if (!userId) return res.status(401).json({ error: 'Unauthorized user' });
      
      const secret = speakeasy.generateSecret({ name: `ParaPoth Admin (${email})` });
      if (!secret.otpauth_url) throw new Error("Failed to generate OTP Auth URL");
      
      const qrCodeImage = await QRCode.toDataURL(secret.otpauth_url);
      await authService.save2FASecret(userId, secret.base32);
      
      return res.status(200).json({ qrCode: qrCodeImage, setupKey: secret.base32, message: "Scan this QR code in Google Authenticator" });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  },

  /**
   * Public registration accepts credentials only. Name, username and academic
   * details are deliberately not read here: they are collected in onboarding
   * after the email is verified.
   */
  async register(req: Request, res: Response) {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const referredByCode =
      typeof req.body?.referred_by_code === 'string' && req.body.referred_by_code.trim()
        ? req.body.referred_by_code.trim()
        : null;

    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({
        success: false,
        code: 'VALIDATION_FAILED',
        message: 'Enter a valid email address',
      });
    }

    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        code: 'WEAK_PASSWORD',
        message: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters`,
      });
    }

    try {
      const { data, error } = await authService.registerWithEmail(
        email,
        password,
        referredByCode
      );

      if (error) {
        const mapped = readRegisterError(error.message ?? '');
        return res.status(mapped.status).json({
          success: false,
          code: mapped.code,
          message: 'Registration could not be completed',
        });
      }

      if (data.user?.identities && data.user.identities.length === 0) {
        return res.status(409).json({
          success: false,
          code: 'EMAIL_ALREADY_REGISTERED',
          message: 'An account with this email already exists',
        });
      }

      const session = data.session;
      return res.status(201).json({
        success: true,
        user: { id: data.user?.id ?? null, email: data.user?.email ?? email },
        requires_email_verification: !session,
        session: session
          ? {
              access_token: session.access_token,
              refresh_token: session.refresh_token,
              expires_at: session.expires_at,
              expires_in: session.expires_in,
              token_type: session.token_type,
            }
          : null,
      });
    } catch {
      return res.status(503).json({
        success: false,
        code: 'REGISTRATION_UNAVAILABLE',
        message: 'Registration is temporarily unavailable',
      });
    }
  },

  /**
   * Username login resolves email only inside the trusted backend, then uses
   * the same Supabase Auth password verification as email login. The response
   * never includes the resolved email or profile data.
   */
  async usernameLogin(req: Request, res: Response) {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!username || !password) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }

    try {
      const email = await authService.findActiveAccountEmailByUsername(username);
      if (!email) {
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
      }

      const auth = await authService.authenticateWithPassword(email, password);
      if (!auth?.session) {
        return res.status(401).json({ success: false, message: 'Invalid username or password' });
      }

      return res.status(200).json({
        success: true,
        session: {
          access_token: auth.session.access_token,
          refresh_token: auth.session.refresh_token,
          expires_at: auth.session.expires_at,
          expires_in: auth.session.expires_in,
          token_type: auth.session.token_type,
        },
      });
    } catch {
      return res.status(503).json({ success: false, message: 'Authentication is temporarily unavailable' });
    }
  },

  /**
   * Administrator login.
   *
   * Identity is established ONLY by real credentials verified against Supabase
   * Auth. A client-supplied user id, role or token is never accepted, and no
   * mock token is generated.
   */
  async adminLoginInit(req: Request, res: Response) {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }

      const auth = await authService.authenticateWithPassword(email, password);

      if (!auth) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const userId = auth.user.id;
      const role = await authService.getUserRole(userId);

      if (!isAdminRole(role)) {
        await authService.revokeSession(auth.session.access_token);
        return res.status(403).json({ error: 'Administrator access required' });
      }

      const adminProfile = await authService.getProfile(userId);
      const trustedDeviceToken = req.cookies?.['trusted_admin_device'];
      const twoFactorRequired =
        adminProfile?.is_2fa_enabled === true &&
        !(trustedDeviceToken && (await authService.isDeviceTrusted(userId, trustedDeviceToken)));

      if (twoFactorRequired) {
        // The password-verified session is revoked so it cannot be used before
        // the second factor is presented.
        await authService.revokeSession(auth.session.access_token);

        const challenge = await authService.createLoginChallenge(userId);

        return res.status(200).json({
          status: 'require_2fa',
          challenge,
          message: 'Please enter your 2FA code.',
        });
      }

      return res.status(200).json({
        token: auth.session.access_token,
        refresh_token: auth.session.refresh_token,
        expires_at: auth.session.expires_at,
        role,
        status: 'success',
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  },

  /**
   * Completes a pending administrator login by verifying a TOTP code against a
   * server-issued, single-use challenge. Identity comes from the stored
   * challenge, never from the request body.
   */
  async verify2FA(req: Request, res: Response) {
    try {
      const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
      const totp = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      const trustDevice = req.body?.trustDevice === true;
      const ipAddress = getClientIp(req);

      if (!challenge || !totp) {
        return res.status(400).json({ error: 'Login challenge and 2FA token are required.' });
      }

      const userId = await authService.consumeLoginChallenge(challenge);

      if (!userId) {
        return res.status(401).json({ error: 'Invalid or expired login challenge.' });
      }

      const role = await authService.getUserRole(userId);

      if (!isAdminRole(role)) {
        return res.status(403).json({ error: 'Administrator access required' });
      }

      const secret = await authService.get2FASecret(userId);
      if (!secret) return res.status(400).json({ error: '2FA not configured for this account.' });

      const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token: totp, window: 1 });
      if (!isValid) return res.status(401).json({ error: 'Invalid 2FA code.' });

      const profile = await authService.getProfile(userId);
      const session = await authService.mintSessionForEmail(profile?.email ?? null);

      if (!session) {
        return res.status(503).json({ error: 'Unable to establish an authenticated session.' });
      }

      if (trustDevice) {
        const deviceToken = crypto.randomBytes(32).toString('hex');
        await authService.saveTrustedDevice(userId, deviceToken, ipAddress || 'unknown');
        res.cookie('trusted_admin_device', deviceToken, { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: true, sameSite: 'strict' });
      }

      return res.status(200).json({
        token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        role,
        status: 'success',
      });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  },

  /**
   * Records device metadata for the AUTHENTICATED caller. The user id is taken
   * from the verified session, not from the request body.
   */
  async saveDeviceInfo(req: Request, res: Response) {
    try {
      const userId = (req as any).user?.id;

      if (!userId) return res.status(401).json({ error: 'Unauthorized user' });

      const { device_name, os_or_browser, fcm_token } = req.body;

      await authService.saveUserDevice({
        user_id: userId,
        device_name,
        os_or_browser,
        fcm_token,
        ip_address: getClientIp(req)
      });

      return res.status(200).json({ success: true });
    } catch (error: any) {
      return res.status(500).json({ error: error.message });
    }
  }
};
