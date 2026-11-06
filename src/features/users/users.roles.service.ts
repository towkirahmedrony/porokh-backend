import { supabase } from '../../config/supabase';
import { createUserSupabaseClient } from '../../config/userSupabase';
import { CANONICAL_ROLES, isCanonicalRole } from '../../middlewares/authorization';
import { isUuid } from '../../lib/utils/search';
import { UsersAdminError, type RolesOverview } from './users.admin.types';

/**
 * Role metadata for the admin surface.
 *
 * The permission model itself is not redefined here: assignments run through
 * public.assign_user_role() and permissions come from public.role_permissions,
 * which is what has_permission() reads. This module only presents that data.
 */
const ROLE_META: Record<string, { label: string; description: string; required_permission: string | null }> = {
  super_admin: {
    label: 'Super Admin',
    description: 'Full platform control, including assigning Admin and Super Admin roles.',
    required_permission: 'roles.assign.super_admin',
  },
  admin: {
    label: 'Admin',
    description: 'Platform administration, including moderator, editor and teacher roles.',
    required_permission: 'roles.assign.admin',
  },
  moderator: {
    label: 'Moderator',
    description: 'Reviews and acts on moderation reports.',
    required_permission: 'roles.assign.staff',
  },
  editor: {
    label: 'Editor',
    description: 'Manages question content.',
    required_permission: 'roles.assign.staff',
  },
  teacher: {
    label: 'Teacher',
    description: 'Creates and manages question content.',
    required_permission: 'roles.assign.staff',
  },
  student: {
    label: 'Student',
    description: 'Default role for every learner account.',
    required_permission: 'roles.assign.staff',
  },
};

interface PermissionRow {
  id: number;
  action: string;
  description: string | null;
}

const readPermissions = async (): Promise<PermissionRow[]> => {
  const { data, error } = await supabase.from('permissions').select('id, action, description').order('action');
  if (error) {
    console.error('[users] permissions unavailable:', error.message);
    throw new UsersAdminError('Role data is temporarily unavailable', 503);
  }
  return (data ?? []) as PermissionRow[];
};

const readActorRole = async (actorId: string): Promise<string | null> => {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', actorId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[users] actor role unavailable:', error.message);
    throw new UsersAdminError('Role data is temporarily unavailable', 503);
  }
  return (data as any)?.role ?? null;
};

/** Roles, their permissions and how many active users hold each. */
export const getRolesOverview = async (actorId: string): Promise<RolesOverview> => {
  const [permissions, mappings, assignments, actorRole] = await Promise.all([
    readPermissions(),
    supabase.from('role_permissions').select('role, permission_id'),
    supabase.from('user_roles').select('role').eq('is_active', true).limit(50_000),
    readActorRole(actorId),
  ]);

  if (mappings.error) {
    console.error('[users] role permissions unavailable:', mappings.error.message);
    throw new UsersAdminError('Role data is temporarily unavailable', 503);
  }
  if (assignments.error) {
    console.error('[users] role assignments unavailable:', assignments.error.message);
    throw new UsersAdminError('Role data is temporarily unavailable', 503);
  }

  const actionById = new Map(permissions.map((permission) => [permission.id, permission.action]));
  const actionsByRole = new Map<string, Set<string>>();
  (mappings.data ?? []).forEach((row: any) => {
    const action = actionById.get(Number(row.permission_id));
    if (!action) return;
    const set = actionsByRole.get(String(row.role)) ?? new Set<string>();
    set.add(action);
    actionsByRole.set(String(row.role), set);
  });

  const countByRole = new Map<string, number>();
  (assignments.data ?? []).forEach((row: any) => {
    const role = String(row.role);
    countByRole.set(role, (countByRole.get(role) ?? 0) + 1);
  });

  const actorPermissions =
    actorRole === 'super_admin'
      ? permissions.map((permission) => permission.action)
      : [...(actionsByRole.get(actorRole ?? '') ?? new Set<string>())];

  return {
    actor: { role: actorRole, permissions: actorPermissions },
    roles: CANONICAL_ROLES.map((role) => ({
      role,
      label: ROLE_META[role].label,
      description: ROLE_META[role].description,
      users: countByRole.get(role) ?? 0,
      permissions: [...(actionsByRole.get(role) ?? new Set<string>())].sort(),
      required_permission: ROLE_META[role].required_permission,
    })),
    permissions: permissions.map((permission) => ({
      action: permission.action,
      description: permission.description,
      roles: CANONICAL_ROLES.filter((role) => actionsByRole.get(role)?.has(permission.action)),
    })),
  };
};

interface RpcError {
  code?: string;
  message?: string;
}

const RPC_MESSAGES: Record<string, { message: string; status: number }> = {
  '42501': { message: 'Your role does not permit this change', status: 403 },
  '23514': { message: 'This change would remove the last active Super Admin', status: 409 },
  '22023': { message: 'That role assignment is not valid', status: 400 },
  P0002: { message: 'User not found', status: 404 },
};

/**
 * Assigns a role.
 *
 * The write goes through public.assign_user_role(), which derives the actor from
 * auth.uid(): the backend passes the caller's own token, so the RPC — not this
 * function — decides whether the transition is allowed. Self-changes, privilege
 * escalation and losing the last Super Admin are rejected there.
 */
export const assignUserRole = async (
  targetUserId: string,
  role: string,
  isActive: boolean,
  accessToken: string
) => {
  if (!isUuid(targetUserId)) throw new UsersAdminError('User not found', 404);
  if (!isCanonicalRole(role)) {
    throw new UsersAdminError(`role must be one of ${CANONICAL_ROLES.join(', ')}`);
  }

  const client = createUserSupabaseClient(accessToken);
  const { data, error } = await client.rpc('assign_user_role', {
    p_target_user_id: targetUserId,
    p_role: role,
    p_is_active: isActive,
  });

  if (error) {
    const known = RPC_MESSAGES[error.code ?? ''];
    if (known) throw new UsersAdminError(known.message, known.status);

    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')) {
      throw new UsersAdminError('Role management is not available on this database yet', 503);
    }

    const raised = (error.message ?? '').trim();
    if (raised && raised.length < 200 && !/^[A-Z_]+$/.test(raised)) {
      throw new UsersAdminError(raised, 400);
    }

    console.error('[users] role assignment failed:', error.code ?? 'unknown');
    throw new UsersAdminError('The role could not be changed', 500);
  }

  return data as { user_id: string; role: string; is_active: boolean } | null;
};

/** Recent role, permission and account-status changes with actor/target names. */
export const getRoleAudit = async (limit = 50) => {
  const { data, error } = await supabase
    .from('security_audit_logs')
    .select('id, actor_user_id, target_user_id, action, resource_type, resource_id, old_values, new_values, outcome, created_at')
    .or('action.like.roles.%,action.like.account.%')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[users] role audit unavailable:', error.message);
    throw new UsersAdminError('Audit history is temporarily unavailable', 503);
  }

  const events = data ?? [];
  const ids = [
    ...new Set(
      events
        .flatMap((event: any) => [event.actor_user_id, event.target_user_id])
        .filter((value): value is string => Boolean(value))
    ),
  ];

  let names = new Map<string, { full_name: string | null; email: string | null }>();

  if (ids.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', ids);
    names = new Map(
      (profiles ?? []).map((profile: any) => [
        String(profile.id),
        { full_name: profile.full_name ?? null, email: profile.email ?? null },
      ])
    );
  }

  return events.map((event: any) => ({
    ...event,
    actor: event.actor_user_id ? names.get(String(event.actor_user_id)) ?? null : null,
    target: event.target_user_id ? names.get(String(event.target_user_id)) ?? null : null,
  }));
};
