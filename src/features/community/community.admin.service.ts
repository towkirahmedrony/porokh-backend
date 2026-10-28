import { supabase } from '../../config/supabase';
import { notify } from '../notifications/notifications.service';

// টাইপ ইন্টারফেস ডিফাইন করা হলো
export interface AutoBanDictData {
  words: string[];
  autoDelete: boolean;
}

export const getGroupsOverview = async () => {
  const { data: groups, error: groupsErr } = await supabase
    .from('study_groups')
    .select('id, name, group_level, total_xp, current_streak')
    .order('total_xp', { ascending: false })
    .limit(10);
  if (groupsErr) throw new Error(`Failed to fetch groups: ${groupsErr.message}`);

  const { data: activeBattles, error: battlesErr } = await supabase
    .from('group_battles')
    .select('id, status, initiated_by')
    .eq('status', 'ongoing');
  if (battlesErr) throw new Error(`Failed to fetch battles: ${battlesErr.message}`);

  const { data: activeFocusSessions, error: focusErr } = await supabase
    .from('group_focus_sessions')
    .select('id, topic, started_by')
    .is('end_time', null);
  if (focusErr) throw new Error(`Failed to fetch focus sessions: ${focusErr.message}`);

  return {
    groups: groups || [],
    activeBattles: activeBattles || [],
    activeFocusSessions: activeFocusSessions || []
  };
};

export const getFlaggedChats = async () => {
  const { data, error } = await supabase
    .from('user_reports')
    .select(`
      id,
      type,
      description,
      created_at,
      group_chats!user_reports_target_message_id_fkey (
        id,
        content,
        meta_data,
        profiles!group_chats_sender_id_fkey ( full_name ),
        study_groups ( name )
      )
    `)
    .eq('type', 'chat_message')
    .eq('status', 'pending');

  if (error) throw new Error(`Failed to fetch flagged chats: ${error.message}`);

  return data.map((report: any) => ({
    id: report.group_chats?.id || 'Unknown',
    report_id: report.id,
    sender_name: report.group_chats?.profiles?.full_name || 'Unknown User',
    group_name: report.group_chats?.study_groups?.name || 'Unknown Group',
    content: report.group_chats?.content || 'Content Unavailable',
    offense_type: report.description || 'Inappropriate Content',
    time: report.created_at
  }));
};

export const executeModeration = async (messageId: string, action: string, adminId: string) => {
  const { data: message, error: fetchErr } = await supabase
    .from('group_chats')
    .select('id, sender_id, group_id')
    .eq('id', messageId)
    .single();
    
  if (fetchErr || !message) throw new Error('Message not found');

  if (action === 'warn') {
    await notify({
      userIds: message.sender_id,
      type: 'security',
      eventCode: 'community_warning',
      title: { bn: 'কমিউনিটি সতর্কতা', en: 'Community Warning' },
      body: {
        bn: 'স্টাডি গ্রুপে আপনার সাম্প্রতিক বার্তা কমিউনিটি নির্দেশনা লঙ্ঘন করেছে। অনুগ্রহ করে নিয়ম মেনে চলুন।',
        en: 'Your recent message in the study group violated community guidelines. Please adhere to the rules.',
      },
      channels: ['in_app'],
      actionLink: '/groups',
      metaData: { message_id: messageId },
    });
    await supabase.from('user_reports').update({ status: 'resolved', admin_reply: 'User warned' }).eq('target_message_id', messageId);
  } 
  else if (action === 'delete') {
    await supabase.from('group_chats').delete().eq('id', messageId);
    await supabase.from('user_reports').update({ status: 'resolved', admin_reply: 'Message deleted' }).eq('target_message_id', messageId);
  } 
  else if (action === 'ban') {
    await supabase.from('group_chats').delete().eq('id', messageId);
    
    const { error: banErr } = await supabase
      .from('group_members')
      .update({ status: 'left' })
      .match({ group_id: message.group_id, user_id: message.sender_id });
      
    if (banErr) throw new Error(`Failed to ban user from group: ${banErr.message}`);
    
    await supabase.from('profiles').update({ current_group_id: null }).eq('id', message.sender_id);
    await supabase.from('user_reports').update({ status: 'resolved', admin_reply: 'User banned' }).eq('target_message_id', messageId);
  }

  await supabase.from('audit_logs').insert({
    user_id: adminId,
    action: `chat_moderation_${action}`,
    target_table: 'group_chats',
    target_id: messageId,
    details: { sender_id: message.sender_id, group_id: message.group_id }
  });

  return { success: true, action };
};

export const getAutoBanDictionary = async (): Promise<AutoBanDictData> => {
  const { data, error } = await supabase
    .from('auto_ban_dictionary')
    .select('word, auto_delete');

  if (error) throw new Error(`Failed to fetch dictionary: ${error.message}`);
  
  if (!data || data.length === 0) return { words: [], autoDelete: false };
  
  return {
    words: data.map((d: any) => d.word),
    autoDelete: data[0].auto_delete || false
  };
};

export const updateAutoBanDictionary = async (dictData: AutoBanDictData) => {
  // Clear all existing dictionary entries
  const { error: deleteErr } = await supabase
    .from('auto_ban_dictionary')
    .delete()
    .not('id', 'is', null);

  if (deleteErr) throw new Error(`Failed to clear old dictionary: ${deleteErr.message}`);

  // Insert new words mapped to dictionary schema
  if (dictData.words.length > 0) {
    const payload = dictData.words.map(w => ({
      word: w.toLowerCase(),
      auto_delete: dictData.autoDelete
    }));

    const { error: insertErr } = await supabase
      .from('auto_ban_dictionary')
      .insert(payload);

    if (insertErr) throw new Error(`Failed to update dictionary: ${insertErr.message}`);
  }

  return dictData;
};

// =====================================
// NEW: API Services for LiveChatMonitor
// =====================================
export const getLiveChats = async (groupId?: string) => {
  let query = supabase
    .from('group_chats')
    .select(`
      id, 
      content, 
      created_at, 
      is_flagged,
      profiles!group_chats_sender_id_fkey (full_name),
      meta_data
    `) 
    .order('created_at', { ascending: false })
    .limit(50);

  if (groupId) {
    query = query.eq('group_id', groupId);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to fetch live chats: ${error.message}`);
  
  return data;
};

export const deleteLiveChatMessage = async (messageId: string, adminId: string) => {
  const { error } = await supabase
    .from('group_chats')
    .delete()
    .eq('id', messageId);

  if (error) throw new Error(`Failed to delete chat: ${error.message}`);
  
  await supabase.from('audit_logs').insert({
    user_id: adminId,
    action: `live_monitor_delete_chat`,
    target_table: 'group_chats',
    target_id: messageId,
    details: { reason: 'Deleted from Live Monitor dashboard' }
  });

  return { success: true };
};
