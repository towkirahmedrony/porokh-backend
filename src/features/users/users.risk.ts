/**
 * Account-sharing risk scoring.
 *
 * Every signal is derived from rows that actually exist (device registry and
 * the security audit trail) and carries the numbers that produced it, so an
 * operator can check the evidence. Nothing is inferred about intent: the levels
 * describe observable activity, not a verdict.
 *
 * Thresholds are intentionally conservative. A shared family phone or a student
 * switching between Wi-Fi and mobile data produces two devices or two IPs, which
 * is informational at most.
 */

export type RiskLevel = 'high' | 'medium' | 'info' | 'none';

export interface RiskDeviceRow {
  user_id: string;
  device_name?: string | null;
  platform?: string | null;
  os_or_browser?: string | null;
  ip_address?: string | null;
  last_active_at?: string | null;
  is_trusted?: boolean | null;
}

export interface RiskAuditRow {
  target_user_id: string | null;
  action: string;
  outcome: string;
  created_at: string;
}

export interface RiskSignal {
  code: string;
  level: Exclude<RiskLevel, 'none'>;
  label: string;
  detail: string;
}

export interface AccountRisk {
  user_id: string;
  level: RiskLevel;
  signals: RiskSignal[];
  active_devices_24h: number;
  active_devices_7d: number;
  distinct_ips_24h: number;
  untrusted_devices: number;
  last_active_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const within = (iso: string | null | undefined, since: number): boolean => {
  if (!iso) return false;
  const value = Date.parse(iso);
  return Number.isFinite(value) && value >= since;
};

const levelRank: Record<RiskLevel, number> = { none: 0, info: 1, medium: 2, high: 3 };

export const highestLevel = (signals: RiskSignal[]): RiskLevel =>
  signals.reduce<RiskLevel>(
    (level, signal) => (levelRank[signal.level] > levelRank[level] ? signal.level : level),
    'none'
  );

/**
 * Evaluates one account. `audits` may contain rows for several users; only the
 * matching target is considered, so callers can pass one grouped query result.
 */
export const evaluateAccountRisk = (
  userId: string,
  devices: RiskDeviceRow[],
  audits: RiskAuditRow[],
  now: number = Date.now()
): AccountRisk => {
  const since24h = now - DAY_MS;
  const since7d = now - 7 * DAY_MS;

  const own = devices.filter((device) => device.user_id === userId);
  const active24h = own.filter((device) => within(device.last_active_at, since24h));
  const active7d = own.filter((device) => within(device.last_active_at, since7d));

  const ips24h = new Set(
    active24h.map((device) => (device.ip_address || '').trim()).filter(Boolean)
  );

  const untrusted = own.filter((device) => device.is_trusted === false).length;

  const ownAudits = audits.filter((row) => row.target_user_id === userId);
  const denied24h = ownAudits.filter(
    (row) => row.outcome === 'denied' && within(row.created_at, since24h)
  );
  const revoked7d = ownAudits.filter(
    (row) => row.action === 'account.sessions_revoked' && within(row.created_at, since7d)
  );

  const signals: RiskSignal[] = [];

  if (active24h.length >= 5) {
    signals.push({
      code: 'CONCURRENT_DEVICES',
      level: 'high',
      label: `${active24h.length} devices active in the last 24 hours`,
      detail:
        'The device registry recorded active sessions from these devices within one day. Confirm with the user before acting.',
    });
  } else if (active24h.length >= 3) {
    signals.push({
      code: 'CONCURRENT_DEVICES',
      level: 'medium',
      label: `${active24h.length} devices active in the last 24 hours`,
      detail: 'More devices than a single-student pattern usually shows.',
    });
  }

  if (ips24h.size >= 5) {
    signals.push({
      code: 'DISTINCT_IPS',
      level: 'high',
      label: `${ips24h.size} distinct IP addresses in the last 24 hours`,
      detail: 'Devices reported different public IPs within one day.',
    });
  } else if (ips24h.size >= 3) {
    signals.push({
      code: 'DISTINCT_IPS',
      level: 'medium',
      label: `${ips24h.size} distinct IP addresses in the last 24 hours`,
      detail: 'Mobile networks and Wi-Fi can legitimately produce this.',
    });
  }

  if (denied24h.length > 0) {
    signals.push({
      code: 'DENIED_SECURITY_EVENTS',
      level: denied24h.length >= 3 ? 'high' : 'medium',
      label: `${denied24h.length} denied security event${denied24h.length === 1 ? '' : 's'} in the last 24 hours`,
      detail: 'The backend rejected protected operations for this account. This is a confirmed event.',
    });
  }

  if (untrusted >= 2) {
    signals.push({
      code: 'UNTRUSTED_DEVICES',
      level: 'info',
      label: `${untrusted} devices are not marked trusted`,
      detail: 'Informational: trust flags are set by the client and are not proof of misuse.',
    });
  }

  if (revoked7d.length > 0) {
    signals.push({
      code: 'SESSIONS_REVOKED_RECENTLY',
      level: 'info',
      label: 'Sessions were revoked in the last 7 days',
      detail: 'An administrator already ended this account’s sessions.',
    });
  }

  const lastActive = own
    .map((device) => device.last_active_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;

  return {
    user_id: userId,
    level: highestLevel(signals),
    signals,
    active_devices_24h: active24h.length,
    active_devices_7d: active7d.length,
    distinct_ips_24h: ips24h.size,
    untrusted_devices: untrusted,
    last_active_at: lastActive,
  };
};
