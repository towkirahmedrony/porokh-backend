import { supabase } from '../../config/supabase';
import { 
  CreatePlanDTO, CreateCouponDTO, CreateAchievementDTO, 
  CreateQuestDTO, ManualOverrideDTO, CreateMarketplaceItemDTO 
} from './monetization.types';
import { Language, localizeRecords } from '../../lib/utils/language';

// ================= Plans =================
export const getPlans = async (language: Language = 'bn') => {
  const { data, error } = await supabase.from('subscription_plans')
    .select('id, name, name_en, features, features_en, duration_days, price, discounted_price, is_active, target_batches')
    .order('price', { ascending: true });
  if (error) throw error;
  return localizeRecords(data, language, ['name', 'features']);
};

export const createPlan = async (payload: CreatePlanDTO) => {
  const { data, error } = await supabase.from('subscription_plans').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const deletePlan = async (id: string) => {
  const { error } = await supabase.from('subscription_plans').delete().eq('id', id);
  if (error) throw error;
  return true;
};

// ================= Coupons =================
export const getCoupons = async () => {
  const { data, error } = await supabase.from('coupons').select('*').order('expires_at', { ascending: true });
  if (error) throw error;
  return data;
};

export const createCoupon = async (payload: CreateCouponDTO) => {
  const { data, error } = await supabase.from('coupons').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const deleteCoupon = async (code: string) => {
  const { error } = await supabase.from('coupons').delete().eq('code', code);
  if (error) throw error;
  return true;
};

// ================= Gamification =================
export const getAchievements = async () => {
  const { data, error } = await supabase.from('achievements_master').select('*');
  if (error) throw error;
  return data;
};

export const createAchievement = async (payload: CreateAchievementDTO) => {
  const { data, error } = await supabase.from('achievements_master').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const getQuests = async () => {
  const { data, error } = await supabase.from('daily_quests').select('*');
  if (error) throw error;
  return data;
};

export const createQuest = async (payload: CreateQuestDTO) => {
  const { data, error } = await supabase.from('daily_quests').insert(payload).select().single();
  if (error) throw error;
  return data;
};

// ================= Manual Override =================
/**
 * Resolves the target account by exact email or phone match.
 *
 * The previous implementation interpolated the identifier into a PostgREST
 * `or` filter, where a comma or parenthesis becomes filter syntax. Exact-match
 * queries keep the identifier as data.
 */
const findUserByIdentifier = async (identifier: string) => {
  const value = identifier.trim();
  if (!value) throw new Error('User not found');

  const byEmail = await supabase.from('profiles').select('id').eq('email', value).limit(1);
  if (!byEmail.error && byEmail.data && byEmail.data.length > 0) return byEmail.data[0];

  const byPhone = await supabase.from('profiles').select('id').eq('phone_number', value).limit(1);
  if (!byPhone.error && byPhone.data && byPhone.data.length > 0) return byPhone.data[0];

  return null;
};

export const grantManualSubscription = async (payload: ManualOverrideDTO) => {
  const user = await findUserByIdentifier(String(payload?.user_identifier ?? ''));

  if (!user) throw new Error('User not found');

  const { data: plan, error: planError } = await supabase
    .from('subscription_plans')
    .select('duration_days')
    .eq('id', payload.plan_id)
    .single();

  if (planError || !plan) throw new Error('Plan not found');

  const endDate = new Date();
  endDate.setDate(endDate.getDate() + plan.duration_days);

  const { data, error } = await supabase.from('user_subscriptions').insert({
    user_id: user.id,
    plan_id: payload.plan_id,
    start_date: new Date().toISOString(),
    end_date: endDate.toISOString(),
    status: 'active',
    auto_renewal: false
  }).select().single();

  if (error) throw error;
  
  await supabase.from('profiles').update({ subscription_status: 'premium' }).eq('id', user.id);

  return data;
};

// ================= Marketplace Items =================
export const getMarketplaceItems = async (language: Language = 'bn') => {
  const { data, error } = await supabase.from('marketplace_items')
    .select('id, title, title_en, description, description_en, features, features_en, item_type, price_coins, icon_url, is_active, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return localizeRecords(data, language, ['title', 'description', 'features']);
};

export const getActiveMarketplaceItems = async (language: Language = 'bn') => {
  const { data, error } = await supabase.from('marketplace_items')
    .select('id, title, title_en, description, description_en, features, features_en, item_type, price_coins, icon_url, is_active, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return localizeRecords(data, language, ['title', 'description', 'features']);
};

export const createMarketplaceItem = async (payload: CreateMarketplaceItemDTO) => {
  const { data, error } = await supabase.from('marketplace_items').insert(payload).select().single();
  if (error) throw error;
  return data;
};

export const updateMarketplaceItem = async (id: string, payload: Partial<CreateMarketplaceItemDTO>) => {
  const { data, error } = await supabase.from('marketplace_items').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
};

export const deleteMarketplaceItem = async (id: string) => {
  const { error } = await supabase.from('marketplace_items').delete().eq('id', id);
  if (error) throw error;
  return true;
};
