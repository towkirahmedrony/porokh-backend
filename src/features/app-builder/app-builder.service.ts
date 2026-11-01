import { supabaseAdmin } from '../../config/supabaseAdmin';
import type { PublicConfigKey } from './app-builder.validation';
import { Language, localizeRecords } from '../../lib/utils/language';

export const AppBuilderService = {
  // ================== APP CONFIGS (Generic) ==================
  async getAllConfigs() {
    const { data, error } = await supabaseAdmin
      .from('app_configs')
      .select('*');
    
    if (error) throw error;
    return data || [];
  },

  async getConfig(key: string) {
    const { data, error } = await supabaseAdmin
      .from('app_configs')
      .select('*')
      .eq('key', key)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error; // Ignore Not Found error
    return data || { value: null };
  },

  /**
   * Public read model: only an allowlisted key and its value are returned, so
   * maintenance fields, internal metadata and private records stay admin-only.
   */
  async getPublicConfig(key: PublicConfigKey) {
    const { data, error } = await supabaseAdmin
      .from('app_configs')
      .select('key, value, maintenance_message, maintenance_message_en')
      .eq('key', key)
      .maybeSingle();

    if (error) throw error;

    return data || { key, value: null };
  },

  async saveConfig(key: string, value: any) {
    const { data, error } = await supabaseAdmin
      .from('app_configs')
      .upsert({ key, value })
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },

  // ================== HOME GRIDS ==================
  async getHomeGrids(language: Language = 'bn', activeOnly = false) {
    let query = supabaseAdmin
      .from('home_grids')
      .select('*, title_en')
      .order('serial_order', { ascending: true });

    if (activeOnly) {
      query = query.eq('is_active', true);
    }

    const { data, error } = await query;
    
    if (error) throw error;
    return localizeRecords(data, language, ['title']);
  },

  async saveHomeGrid(gridData: any) {
    const { data, error } = await supabaseAdmin
      .from('home_grids')
      .upsert(gridData)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },

  async reorderHomeGrids(grids: any[]) {
    for (const grid of grids) {
      const { error } = await supabaseAdmin
        .from('home_grids')
        .update({ serial_order: grid.serial_order })
        .eq('id', grid.id);

      if (error) throw error;
    }

    return true;
  },

  async deleteHomeGrid(id: string) {
    const { error } = await supabaseAdmin
      .from('home_grids')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    return true;
  },

  // ================== BANNERS ==================
  async getBanners(language: Language = 'bn') {
    const { data, error } = await supabaseAdmin
      .from('home_banners')
      .select('id, title, title_en, description, description_en, button_text, button_text_en, image_url, action_link, action_type, sequence, is_active, target_rules, start_date, end_date, created_at')
      .order('sequence', { ascending: true });
    
    if (error) throw error;
    return localizeRecords(data, language, ['title', 'description', 'button_text']);
  },

  async createBanner(bannerData: any) {
    const { data, error } = await supabaseAdmin
      .from('home_banners')
      .insert(bannerData)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },

  async updateBanner(id: string, updates: any) {
    const { data, error } = await supabaseAdmin
      .from('home_banners')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  },

  async deleteBanner(id: string) {
    const { error } = await supabaseAdmin
      .from('home_banners')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    return true;
  },

  // ================== LEAGUES & LEVELS ==================
  async getLevels() {
    const { data, error } = await supabaseAdmin
      .from('levels_master')
      .select('*')
      .order('min_xp', { ascending: true });
    
    if (error) throw error;
    return data;
  },

  async updateLevels(levels: any[]) {
    // Copy instead of mutating the caller payload; empty ids are omitted so the
    // database can generate them for new rows.
    const formattedLevels = levels.map((level) => {
      const { id, ...rest } = level;
      return id ? { id, ...rest } : rest;
    });

    const { data, error } = await supabaseAdmin
      .from('levels_master')
      .upsert(formattedLevels, { onConflict: 'id' })
      .select();
    
    if (error) throw error;
    return data;
  }
};
