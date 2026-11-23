export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  phone_number?: string;
  full_name: string;
  avatar_url?: string;
  bio?: string;
  gender?: string;
  date_of_birth?: string;
  institution?: string;
  institution_id?: string;
  class_level?: string;
  group?: string;
  education_board?: string;
  batch_year?: string;
  guardian_phone?: string;
  study_goal?: string;
  language_preference?: string;
  address?: Record<string, any>;
  total_xp: number;
  coin_balance: number;
  pvp_rating: number;
  current_streak: number;
  subscription_status?: string;
  created_at: string;
}

export interface UpdateProfileDto {
  full_name?: string;
  phone_number?: string;
  bio?: string;
  avatar_url?: string;
  gender?: string;
  date_of_birth?: string;
  institution?: string;
  institution_id?: string;
  class_level?: string;
  group?: string;
  education_board?: string;
  batch_year?: string;
  guardian_phone?: string;
  study_goal?: string;
  language_preference?: string;
  address?: Record<string, any>;
}

export interface ActivityPoint {
  day: string;
  you: number;
  them: number;
}

// ফ্রন্টএন্ডের VersusStats কম্পোনেন্টের সাথে সামঞ্জস্যপূর্ণ
export interface PlayerStats {
  total_xp: number;
  accuracy: number;
  current_streak: number;
  total_exams: number;
}

export interface VersusStats {
  my_stats: PlayerStats;
  their_stats: PlayerStats;
}
