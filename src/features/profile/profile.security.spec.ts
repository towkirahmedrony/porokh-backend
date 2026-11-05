import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type Row = Record<string, any>;

const state: {
  profile: Row;
  lastUpdate: Row | null;
  lastUpdateId: string | null;
  updateCalls: number;
} = {
  profile: {
    id: 'user-1',
    full_name: 'Old Name',
    avatar_url: 'https://cdn.example.com/a.png',
    institution: 'School',
    class_level: 'HSC',
    total_xp: 100,
    coin_balance: 5,
    subscription_status: 'free',
    account_status: 'active',
    is_2fa_enabled: false,
    settings: { theme: 'dark', two_factor_secret: 'TOPSECRET' },
  },
  lastUpdate: null,
  lastUpdateId: null,
  updateCalls: 0,
};

const createProfilesBuilder = () => {
  const filters: Record<string, any> = {};
  let pendingUpdate: Row | null = null;
  let updateMode = false;

  const builder: any = {
    select: () => builder,
    update: (data: Row) => {
      pendingUpdate = data;
      updateMode = true;
      state.lastUpdate = data;
      state.updateCalls += 1;
      return builder;
    },
    eq: (column: string, value: any) => {
      filters[column] = value;
      if (updateMode && column === 'id') state.lastUpdateId = value;
      return builder;
    },
    in: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: () => builder,
    maybeSingle: async () => builder.resolve(),
    single: async () => builder.resolve(),
    resolve: () => {
      if (updateMode) {
        return {
          data: { ...state.profile, ...(pendingUpdate || {}) },
          error: null,
        };
      }

      return { data: { ...state.profile }, error: null };
    },
    then: (onFulfilled: any, onRejected: any) =>
      Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
  };

  return builder;
};

const fakeSupabase = {
  from: (table: string) => createProfilesBuilder(),
  auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  rpc: async () => ({ data: null, error: null }),
};

const fakeSupabaseAdmin = {
  from: (table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { value: { profile_completion: 50 } }, error: null }),
        single: async () => ({ data: { value: { profile_completion: 50 } }, error: null }),
      }),
    }),
  }),
  rpc: async () => ({ data: null, error: null }),
};

const require = createRequire(__filename);

const stubModule = (relativePath: string, exports: unknown) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  } as any;
};

stubModule('../../config/supabase', { supabase: fakeSupabase });
stubModule('../../config/supabaseAdmin', { supabaseAdmin: fakeSupabaseAdmin });

const { ProfileService } = require('./profile.service');
const {
  buildProfileUpdatePayload,
  ProfileValidationError,
} = require('./profile.validation');

beforeEach(() => {
  state.lastUpdate = null;
  state.lastUpdateId = null;
  state.updateCalls = 0;
});

test('editable profile fields are allowed and sensitive fields are dropped', () => {
  const payload = buildProfileUpdatePayload({
    full_name: '  New Name  ',
    bio: 'Hello',
    class_level: 'HSC',
    total_xp: 999999,
    coin_balance: 999999,
    subscription_status: 'premium',
    account_status: 'suspended',
    is_2fa_enabled: true,
    is_email_verified: true,
    settings: { theme: 'admin' },
    created_at: '2000-01-01T00:00:00.000Z',
    id: 'user-2',
    user_id: 'user-2',
  });

  assert.deepEqual(payload, {
    full_name: 'New Name',
    bio: 'Hello',
    class_level: 'HSC',
  });
});

test('self-service username updates normalize case and strip privileged fields', () => {
  const payload = buildProfileUpdatePayload({
    username: '  Towkir_7 ',
    account_status: 'active',
    role: 'super_admin',
  });

  assert.deepEqual(payload, { username: 'towkir_7' });
});

test('self-service username updates reject unsupported characters and lengths', () => {
  assert.throws(() => buildProfileUpdatePayload({ username: 'two-kir' }), ProfileValidationError);
  assert.throws(() => buildProfileUpdatePayload({ username: 'ab' }), ProfileValidationError);
});

test('a profile update cannot change XP, coins, subscription or account status', async () => {
  await ProfileService.updateProfile('user-1', {
    full_name: 'New Name',
    total_xp: 999999,
    coin_balance: 999999,
    subscription_status: 'premium',
    account_status: 'suspended',
    is_2fa_enabled: true,
  });

  assert.deepEqual(state.lastUpdate, { full_name: 'New Name' });
  assert.equal(state.lastUpdateId, 'user-1');
});

test('a sensitive-only payload performs no database update', async () => {
  await assert.rejects(
    ProfileService.updateProfile('user-1', {
      total_xp: 999999,
      coin_balance: 999999,
      subscription_status: 'premium',
    }),
    /No editable profile fields supplied/
  );

  assert.equal(state.updateCalls, 0);
  assert.equal(state.lastUpdate, null);
});

test('a different user id in the body cannot change the update target', async () => {
  await ProfileService.updateProfile('user-1', {
    id: 'user-2',
    user_id: 'user-2',
    full_name: 'Target Changed',
  });

  assert.equal(state.lastUpdateId, 'user-1');
  assert.deepEqual(state.lastUpdate, { full_name: 'Target Changed' });
});

test('malformed field values are rejected before any write', async () => {
  await assert.rejects(
    ProfileService.updateProfile('user-1', { date_of_birth: 'not-a-date' }),
    ProfileValidationError
  );

  await assert.rejects(
    ProfileService.updateProfile('user-1', { address: { nested: { deep: true } } }),
    ProfileValidationError
  );

  await assert.rejects(
    ProfileService.updateProfile('user-1', { full_name: '   ' }),
    ProfileValidationError
  );

  assert.equal(state.updateCalls, 0);
});

test('theme preference only accepts a plain safe string', async () => {
  const settings = await ProfileService.updateThemePreference('user-1', 'light');
  assert.equal(settings.theme, 'light');
  assert.equal('two_factor_secret' in settings, false);

  await assert.rejects(
    ProfileService.updateThemePreference('user-1', { theme: 'dark' }),
    ProfileValidationError
  );
});

test('profile reads never expose the stored two-factor secret', async () => {
  const profile = await ProfileService.getProfileById('user-1');
  assert.equal('two_factor_secret' in (profile.settings as Row), false);
  assert.equal((profile.settings as Row).theme, 'dark');
});
