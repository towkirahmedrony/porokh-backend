import { supabaseAdmin } from '../../config/supabaseAdmin';
import { notifyReferralBonus } from '../notifications/notifications.service';

export class ReferralService {
  static async getStats(userId: string) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('referral_code')
      .eq('id', userId)
      .single();

    if (profileErr) throw profileErr;

    const { count, error: countErr } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('referred_by', userId);

    if (countErr) throw countErr;

    const { data: txs, error: txErr } = await supabaseAdmin
      .from('coin_transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('transaction_type', 'referral_bonus');

    if (txErr) throw txErr;

    const totalEarned = txs?.reduce((sum, tx) => sum + (tx.amount || 0), 0) || 0;

    return {
      referralCode: profile?.referral_code || 'GENERATE',
      totalReferrals: count || 0,
      totalEarned: totalEarned,
      currency: 'Coins'
    };
  }

  static async getHistory(userId: string) {
    const { data: configData, error: configError } = await supabaseAdmin
      .from('app_configs')
      .select('value')
      .eq('key', 'xp_rules')
      .single();

    let currentBonus = 200;
    if (!configError && configData?.value) {
      const rules = configData.value as any;
      // এখানে আপডেট করা হয়েছে: referral_bonus_referrer ব্যবহার করা হলো
      if (rules.referral_bonus_referrer) currentBonus = Number(rules.referral_bonus_referrer);
    }

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, avatar_url, created_at, account_status')
      .eq('referred_by', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    return (data || []).map((user: any) => ({
      user: {
        id: user.id,
        full_name: user.full_name || 'Unknown User',
        avatar_url: user.avatar_url,
        joined_at: user.created_at,
        status: user.account_status === 'active' ? 'active' : 'pending',
      },
      bonus_amount: currentBonus,
    }));
  }

  static async redeemCode(userId: string, code: string) {
    if (!code) throw new Error("Referral code is required");
    
    const { error } = await supabaseAdmin.rpc('apply_referral_code', {
      p_user_id: userId,
      p_referral_code: code.trim().toUpperCase()
    });

    if (error) {
      throw new Error(error.message || "Failed to apply referral code.");
    }

    await ReferralService.notifyReferrer(userId);

    return { success: true, message: "Referral applied successfully!" };
  }

  private static async notifyReferrer(referredUserId: string) {
    try {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('referred_by')
        .eq('id', referredUserId)
        .maybeSingle();

      const referrerId = profile?.referred_by as string | null;
      if (!referrerId) return;

      const { data: configData } = await supabaseAdmin
        .from('app_configs')
        .select('value')
        .eq('key', 'xp_rules')
        .maybeSingle();

      const rules = (configData?.value as Record<string, any> | null) ?? {};
      const amount = Number(rules.referral_bonus_referrer ?? 200) || 200;

      await notifyReferralBonus(referrerId, amount, referredUserId);
    } catch (error) {
      console.error(
        '[referral] referrer notification failed:',
        error instanceof Error ? error.message : 'unknown error'
      );
    }
  }

  // নতুন ফাংশন: অটোমেটিক রেফারেল প্রসেস করার জন্য
  static async processAutoReferral(userId: string, referredByCode: string) {
    try {
      // চেক করুন ইউজার ইতোমধ্যে রেফার্ড কিনা
      const { data: profile, error: profileErr } = await supabaseAdmin
        .from('profiles')
        .select('referred_by')
        .eq('id', userId)
        .single();

      if (profileErr) throw profileErr;

      // যদি আগে থেকেই referred_by থাকে, তার মানে রিডিম করা হয়ে গেছে
      if (profile.referred_by) {
        return { success: false, message: 'Already referred' };
      }

      // ডাটাবেজ ফাংশন কল করে রিডিম করা
      const { error } = await supabaseAdmin.rpc('apply_referral_code', {
        p_user_id: userId,
        p_referral_code: referredByCode.trim().toUpperCase()
      });

      if (error) throw error;

      // মেটাডেটা থেকে কোড মুছে ফেলা যেন বারবার ট্রাই না করে
      await supabaseAdmin.auth.admin.updateUserById(userId, {
        user_metadata: { referred_by_code: null }
      });

      await ReferralService.notifyReferrer(userId);

      return { success: true };
    } catch (error) {
      console.error('Process auto referral failed:', error);
      return { success: false, error };
    }
  }
}
