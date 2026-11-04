export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      achievements_master: {
        Row: {
          condition_type: string | null
          condition_value: Json | null
          description: string | null
          description_en: string | null
          icon_url: string | null
          id: string
          title: string
          title_en: string | null
          xp_reward: number | null
        }
        Insert: {
          condition_type?: string | null
          condition_value?: Json | null
          description?: string | null
          description_en?: string | null
          icon_url?: string | null
          id: string
          title: string
          title_en?: string | null
          xp_reward?: number | null
        }
        Update: {
          condition_type?: string | null
          condition_value?: Json | null
          description?: string | null
          description_en?: string | null
          icon_url?: string | null
          id?: string
          title?: string
          title_en?: string | null
          xp_reward?: number | null
        }
        Relationships: []
      }
      admin_alerts: {
        Row: {
          action_link: string | null
          created_at: string | null
          id: string
          is_read: boolean | null
          message: string
          meta_data: Json | null
          priority: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
          target_admin_id: string | null
          title: string
          type: string
        }
        Insert: {
          action_link?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message: string
          meta_data?: Json | null
          priority: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_admin_id?: string | null
          title?: string
          type: string
        }
        Update: {
          action_link?: string | null
          created_at?: string | null
          id?: string
          is_read?: boolean | null
          message?: string
          meta_data?: Json | null
          priority?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_admin_id?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "admin_alerts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_alerts_target_admin_id_fkey"
            columns: ["target_admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_login_history: {
        Row: {
          admin_id: string | null
          device_details: string | null
          failure_reason: string | null
          id: string
          ip_address: string | null
          location: string | null
          login_at: string
          login_status: string
          logout_at: string | null
        }
        Insert: {
          admin_id?: string | null
          device_details?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: string | null
          location?: string | null
          login_at?: string
          login_status: string
          logout_at?: string | null
        }
        Update: {
          admin_id?: string | null
          device_details?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: string | null
          location?: string | null
          login_at?: string
          login_status?: string
          logout_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_login_history_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "admin_login_history_admin_id_idx"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_performance_stats: {
        Row: {
          admin_id: string
          content_reviews_completed: number | null
          id: number
          last_updated_at: string | null
          month: string
          questions_approved: number | null
          questions_created: number | null
          support_tickets_resolved: number | null
          users_banned: number | null
        }
        Insert: {
          admin_id: string
          content_reviews_completed?: number | null
          id?: number
          last_updated_at?: string | null
          month: string
          questions_approved?: number | null
          questions_created?: number | null
          support_tickets_resolved?: number | null
          users_banned?: number | null
        }
        Update: {
          admin_id?: string
          content_reviews_completed?: number | null
          id?: number
          last_updated_at?: string | null
          month?: string
          questions_approved?: number | null
          questions_created?: number | null
          support_tickets_resolved?: number | null
          users_banned?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_performance_stats_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_sessions: {
        Row: {
          admin_id: string | null
          device_id: string | null
          id: string
          is_2fa_verified: boolean | null
          last_active: string | null
        }
        Insert: {
          admin_id?: string | null
          device_id?: string | null
          id?: string
          is_2fa_verified?: boolean | null
          last_active?: string | null
        }
        Update: {
          admin_id?: string | null
          device_id?: string | null
          id?: string
          is_2fa_verified?: boolean | null
          last_active?: string | null
        }
        Relationships: []
      }
      ai_chat_messages: {
        Row: {
          completion_tokens: number | null
          content: string
          created_at: string | null
          id: string
          prompt_tokens: number | null
          role: string
          session_id: string | null
        }
        Insert: {
          completion_tokens?: number | null
          content: string
          created_at?: string | null
          id?: string
          prompt_tokens?: number | null
          role: string
          session_id?: string | null
        }
        Update: {
          completion_tokens?: number | null
          content?: string
          created_at?: string | null
          id?: string
          prompt_tokens?: number | null
          role?: string
          session_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_messages_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "ai_chat_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_chat_sessions: {
        Row: {
          created_at: string | null
          id: string
          last_active_at: string | null
          session_title: string | null
          subject_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_active_at?: string | null
          session_title?: string | null
          subject_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          last_active_at?: string | null
          session_title?: string | null
          subject_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_sessions_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chat_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_prompts_config: {
        Row: {
          context_name: string
          id: string
          is_active: boolean | null
          system_prompt: string
          temperature: number | null
          updated_at: string | null
        }
        Insert: {
          context_name: string
          id?: string
          is_active?: boolean | null
          system_prompt: string
          temperature?: number | null
          updated_at?: string | null
        }
        Update: {
          context_name?: string
          id?: string
          is_active?: boolean | null
          system_prompt?: string
          temperature?: number | null
          updated_at?: string | null
        }
        Relationships: []
      }
      app_configs: {
        Row: {
          is_force_update_required: boolean | null
          key: string
          maintenance_message: string | null
          maintenance_message_en: string | null
          maintenance_mode: boolean | null
          min_app_version: string | null
          ui_theme_settings: Json | null
          update_redirect_url: string | null
          value: Json | null
        }
        Insert: {
          is_force_update_required?: boolean | null
          key: string
          maintenance_message?: string | null
          maintenance_message_en?: string | null
          maintenance_mode?: boolean | null
          min_app_version?: string | null
          ui_theme_settings?: Json | null
          update_redirect_url?: string | null
          value?: Json | null
        }
        Update: {
          is_force_update_required?: boolean | null
          key?: string
          maintenance_message?: string | null
          maintenance_message_en?: string | null
          maintenance_mode?: boolean | null
          min_app_version?: string | null
          ui_theme_settings?: Json | null
          update_redirect_url?: string | null
          value?: Json | null
        }
        Relationships: []
      }
      app_error_logs: {
        Row: {
          app_version: string | null
          created_at: string | null
          device_info: Json | null
          error_message: string
          id: string
          stack_trace: string | null
          status: string | null
          user_id: string | null
        }
        Insert: {
          app_version?: string | null
          created_at?: string | null
          device_info?: Json | null
          error_message: string
          id?: string
          stack_trace?: string | null
          status?: string | null
          user_id?: string | null
        }
        Update: {
          app_version?: string | null
          created_at?: string | null
          device_info?: Json | null
          error_message?: string
          id?: string
          stack_trace?: string | null
          status?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "app_error_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      app_feedback: {
        Row: {
          admin_notes: string | null
          category: string | null
          comments: string | null
          created_at: string
          device_info: Json | null
          id: string
          page_context: string | null
          rating: number | null
          status: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          admin_notes?: string | null
          category?: string | null
          comments?: string | null
          created_at?: string
          device_info?: Json | null
          id?: string
          page_context?: string | null
          rating?: number | null
          status?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          admin_notes?: string | null
          category?: string | null
          comments?: string | null
          created_at?: string
          device_info?: Json | null
          id?: string
          page_context?: string | null
          rating?: number | null
          status?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          id: string
          target_id: string
          target_table: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          id?: string
          target_id: string
          target_table: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          id?: string
          target_id?: string
          target_table?: string
          user_id?: string | null
        }
        Relationships: []
      }
      auth_otps: {
        Row: {
          created_at: string | null
          expires_at: string
          id: string
          is_used: boolean | null
          otp_code: string
          phone_number: string
          purpose: string | null
        }
        Insert: {
          created_at?: string | null
          expires_at: string
          id?: string
          is_used?: boolean | null
          otp_code: string
          phone_number: string
          purpose?: string | null
        }
        Update: {
          created_at?: string | null
          expires_at?: string
          id?: string
          is_used?: boolean | null
          otp_code?: string
          phone_number?: string
          purpose?: string | null
        }
        Relationships: []
      }
      auto_ban_dictionary: {
        Row: {
          auto_delete: boolean | null
          created_at: string | null
          created_by: string | null
          id: string
          match_type: string | null
          word: string
        }
        Insert: {
          auto_delete?: boolean | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          match_type?: string | null
          word: string
        }
        Update: {
          auto_delete?: boolean | null
          created_at?: string | null
          created_by?: string | null
          id?: string
          match_type?: string | null
          word?: string
        }
        Relationships: [
          {
            foreignKeyName: "auto_ban_dictionary_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bookmarks: {
        Row: {
          created_at: string | null
          id: string
          note: string | null
          question_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          note?: string | null
          question_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          note?: string | null
          question_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bookmarks_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bookmarks_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chapters: {
        Row: {
          created_at: string | null
          curriculum_version: string | null
          description: string | null
          id: string
          is_active: boolean | null
          is_premium: boolean | null
          language: string | null
          name_bn: string
          name_en: string | null
          sequence: number | null
          slug: string
          subject_id: string | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          curriculum_version?: string | null
          description?: string | null
          id: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn: string
          name_en?: string | null
          sequence?: number | null
          slug: string
          subject_id?: string | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          curriculum_version?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn?: string
          name_en?: string | null
          sequence?: number | null
          slug?: string
          subject_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chapters_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      coin_transactions: {
        Row: {
          amount: number
          created_at: string | null
          description: string | null
          id: string
          meta_data: Json | null
          reference_id: string | null
          transaction_type: string
          user_id: string
        }
        Insert: {
          amount: number
          created_at?: string | null
          description?: string | null
          id?: string
          meta_data?: Json | null
          reference_id?: string | null
          transaction_type: string
          user_id: string
        }
        Update: {
          amount?: number
          created_at?: string | null
          description?: string | null
          id?: string
          meta_data?: Json | null
          reference_id?: string | null
          transaction_type?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "coin_transactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      comprehensions: {
        Row: {
          body: string | null
          chapter_id: string | null
          created_at: string | null
          id: string
          media_id: string | null
          sequence: number | null
          subject_id: string | null
          topic_id: string | null
        }
        Insert: {
          body?: string | null
          chapter_id?: string | null
          created_at?: string | null
          id?: string
          media_id?: string | null
          sequence?: number | null
          subject_id?: string | null
          topic_id?: string | null
        }
        Update: {
          body?: string | null
          chapter_id?: string | null
          created_at?: string | null
          id?: string
          media_id?: string | null
          sequence?: number | null
          subject_id?: string | null
          topic_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "comprehensions_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comprehensions_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media_library"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comprehensions_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comprehensions_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: {
          code: string
          discount_type: string | null
          discount_value: number
          expires_at: string | null
          is_active: boolean | null
          max_usage: number | null
        }
        Insert: {
          code: string
          discount_type?: string | null
          discount_value: number
          expires_at?: string | null
          is_active?: boolean | null
          max_usage?: number | null
        }
        Update: {
          code?: string
          discount_type?: string | null
          discount_value?: number
          expires_at?: string | null
          is_active?: boolean | null
          max_usage?: number | null
        }
        Relationships: []
      }
      daily_quests: {
        Row: {
          action_type: string
          coin_reward: number | null
          created_at: string | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          reset_frequency: string | null
          target_count: number
          title: string
          title_en: string | null
          xp_reward: number | null
        }
        Insert: {
          action_type: string
          coin_reward?: number | null
          created_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          reset_frequency?: string | null
          target_count: number
          title: string
          title_en?: string | null
          xp_reward?: number | null
        }
        Update: {
          action_type?: string
          coin_reward?: number | null
          created_at?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          reset_frequency?: string | null
          target_count?: number
          title?: string
          title_en?: string | null
          xp_reward?: number | null
        }
        Relationships: []
      }
      emergency_flags: {
        Row: {
          activated_at: string | null
          description: string | null
          is_active: boolean | null
          key: string
        }
        Insert: {
          activated_at?: string | null
          description?: string | null
          is_active?: boolean | null
          key: string
        }
        Update: {
          activated_at?: string | null
          description?: string | null
          is_active?: boolean | null
          key?: string
        }
        Relationships: []
      }
      exam_activity_cache: {
        Row: {
          avg_score: number | null
          created_at: string | null
          day: string
          exams_taken: number | null
          id: number
        }
        Insert: {
          avg_score?: number | null
          created_at?: string | null
          day: string
          exams_taken?: number | null
          id?: number
        }
        Update: {
          avg_score?: number | null
          created_at?: string | null
          day?: string
          exams_taken?: number | null
          id?: number
        }
        Relationships: []
      }
      exam_history: {
        Row: {
          correct_count: number | null
          created_at: string | null
          details_json: Json | null
          device_id: string | null
          device_type: string | null
          exam_id: string | null
          id: string
          ip_address: string | null
          is_timeout: boolean | null
          rank: number | null
          score: number
          skipped_count: number | null
          status: string | null
          submitted_at: string | null
          time_taken: number | null
          total_marks: number
          user_agent: string | null
          user_id: string | null
          wrong_count: number | null
        }
        Insert: {
          correct_count?: number | null
          created_at?: string | null
          details_json?: Json | null
          device_id?: string | null
          device_type?: string | null
          exam_id?: string | null
          id?: string
          ip_address?: string | null
          is_timeout?: boolean | null
          rank?: number | null
          score: number
          skipped_count?: number | null
          status?: string | null
          submitted_at?: string | null
          time_taken?: number | null
          total_marks: number
          user_agent?: string | null
          user_id?: string | null
          wrong_count?: number | null
        }
        Update: {
          correct_count?: number | null
          created_at?: string | null
          details_json?: Json | null
          device_id?: string | null
          device_type?: string | null
          exam_id?: string | null
          id?: string
          ip_address?: string | null
          is_timeout?: boolean | null
          rank?: number | null
          score?: number
          skipped_count?: number | null
          status?: string | null
          submitted_at?: string | null
          time_taken?: number | null
          total_marks?: number
          user_agent?: string | null
          user_id?: string | null
          wrong_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_history_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_history_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_history_details: {
        Row: {
          created_at: string
          exam_history_id: string
          id: string
          is_correct: boolean | null
          marks_awarded: number | null
          question_id: string
          selected_option: string | null
        }
        Insert: {
          created_at?: string
          exam_history_id: string
          id?: string
          is_correct?: boolean | null
          marks_awarded?: number | null
          question_id: string
          selected_option?: string | null
        }
        Update: {
          created_at?: string
          exam_history_id?: string
          id?: string
          is_correct?: boolean | null
          marks_awarded?: number | null
          question_id?: string
          selected_option?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_history_details_exam_history_id_fkey"
            columns: ["exam_history_id"]
            isOneToOne: false
            referencedRelation: "exam_history"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_history_details_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_paper_questions: {
        Row: {
          exam_id: string | null
          id: string
          marks: number
          negative_marks: number | null
          question_id: string | null
          sequence: number
        }
        Insert: {
          exam_id?: string | null
          id?: string
          marks?: number
          negative_marks?: number | null
          question_id?: string | null
          sequence: number
        }
        Update: {
          exam_id?: string | null
          id?: string
          marks?: number
          negative_marks?: number | null
          question_id?: string | null
          sequence?: number
        }
        Relationships: [
          {
            foreignKeyName: "exam_paper_questions_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_paper_questions_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_papers: {
        Row: {
          allowed_platforms: Json | null
          category: string | null
          created_at: string | null
          default_negative_marks: number | null
          duration_min: number | null
          end_time: string | null
          exam_type: string | null
          id: string
          instructions: string | null
          instructions_en: string | null
          is_premium: boolean | null
          is_published: boolean | null
          meta_data: Json | null
          pass_mark: number | null
          result_publish_time: string | null
          show_leaderboard: boolean | null
          start_time: string | null
          subject_id: string | null
          syllabus_details: string | null
          syllabus_details_en: string | null
          title: string
          title_en: string | null
          total_marks: number
          updated_at: string | null
        }
        Insert: {
          allowed_platforms?: Json | null
          category?: string | null
          created_at?: string | null
          default_negative_marks?: number | null
          duration_min?: number | null
          end_time?: string | null
          exam_type?: string | null
          id: string
          instructions?: string | null
          instructions_en?: string | null
          is_premium?: boolean | null
          is_published?: boolean | null
          meta_data?: Json | null
          pass_mark?: number | null
          result_publish_time?: string | null
          show_leaderboard?: boolean | null
          start_time?: string | null
          subject_id?: string | null
          syllabus_details?: string | null
          syllabus_details_en?: string | null
          title: string
          title_en?: string | null
          total_marks: number
          updated_at?: string | null
        }
        Update: {
          allowed_platforms?: Json | null
          category?: string | null
          created_at?: string | null
          default_negative_marks?: number | null
          duration_min?: number | null
          end_time?: string | null
          exam_type?: string | null
          id?: string
          instructions?: string | null
          instructions_en?: string | null
          is_premium?: boolean | null
          is_published?: boolean | null
          meta_data?: Json | null
          pass_mark?: number | null
          result_publish_time?: string | null
          show_leaderboard?: boolean | null
          start_time?: string | null
          subject_id?: string | null
          syllabus_details?: string | null
          syllabus_details_en?: string | null
          title?: string
          title_en?: string | null
          total_marks?: number
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_papers_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_progress: {
        Row: {
          answers_draft: Json | null
          current_question_index: number | null
          exam_id: string | null
          id: string
          last_updated_at: string | null
          time_remaining: number | null
          user_id: string | null
        }
        Insert: {
          answers_draft?: Json | null
          current_question_index?: number | null
          exam_id?: string | null
          id?: string
          last_updated_at?: string | null
          time_remaining?: number | null
          user_id?: string | null
        }
        Update: {
          answers_draft?: Json | null
          current_question_index?: number | null
          exam_id?: string | null
          id?: string
          last_updated_at?: string | null
          time_remaining?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "exam_progress_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "exam_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_flags: {
        Row: {
          is_enabled: boolean | null
          key: string
          rules: Json | null
          updated_at: string | null
        }
        Insert: {
          is_enabled?: boolean | null
          key: string
          rules?: Json | null
          updated_at?: string | null
        }
        Update: {
          is_enabled?: boolean | null
          key?: string
          rules?: Json | null
          updated_at?: string | null
        }
        Relationships: []
      }
      flagged_messages: {
        Row: {
          action_taken: string | null
          chat_id: string | null
          created_at: string | null
          flagged_by_system: boolean | null
          group_id: string | null
          id: string
          offense_type: string
          resolved_by: string | null
          sender_id: string | null
          status: string | null
        }
        Insert: {
          action_taken?: string | null
          chat_id?: string | null
          created_at?: string | null
          flagged_by_system?: boolean | null
          group_id?: string | null
          id?: string
          offense_type: string
          resolved_by?: string | null
          sender_id?: string | null
          status?: string | null
        }
        Update: {
          action_taken?: string | null
          chat_id?: string | null
          created_at?: string | null
          flagged_by_system?: boolean | null
          group_id?: string | null
          id?: string
          offense_type?: string
          resolved_by?: string | null
          sender_id?: string | null
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "flagged_messages_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "group_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flagged_messages_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flagged_messages_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flagged_messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      global_leaderboard_cache: {
        Row: {
          id: number
          last_updated_at: string | null
          period_start_date: string
          period_type: string
          rank: number
          total_score: number | null
          user_id: string
        }
        Insert: {
          id?: number
          last_updated_at?: string | null
          period_start_date: string
          period_type: string
          rank: number
          total_score?: number | null
          user_id: string
        }
        Update: {
          id?: number
          last_updated_at?: string | null
          period_start_date?: string
          period_type?: string
          rank?: number
          total_score?: number | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "global_leaderboard_cache_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_battles: {
        Row: {
          created_at: string | null
          end_time: string | null
          exam_id: string | null
          group_id: string | null
          id: string
          initiated_by: string | null
          scores_snapshot: Json | null
          start_time: string | null
          status: string | null
          winner_id: string | null
        }
        Insert: {
          created_at?: string | null
          end_time?: string | null
          exam_id?: string | null
          group_id?: string | null
          id?: string
          initiated_by?: string | null
          scores_snapshot?: Json | null
          start_time?: string | null
          status?: string | null
          winner_id?: string | null
        }
        Update: {
          created_at?: string | null
          end_time?: string | null
          exam_id?: string | null
          group_id?: string | null
          id?: string
          initiated_by?: string | null
          scores_snapshot?: Json | null
          start_time?: string | null
          status?: string | null
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_battles_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_battles_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_battles_initiated_by_fkey"
            columns: ["initiated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_battles_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_chats: {
        Row: {
          content: string | null
          created_at: string | null
          deleted_at: string | null
          deleted_by: string | null
          group_id: string | null
          id: string
          is_flagged: boolean | null
          message_type: string | null
          meta_data: Json | null
          sender_id: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          group_id?: string | null
          id?: string
          is_flagged?: boolean | null
          message_type?: string | null
          meta_data?: Json | null
          sender_id?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          group_id?: string | null
          id?: string
          is_flagged?: boolean | null
          message_type?: string | null
          meta_data?: Json | null
          sender_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_chats_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_chats_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_chats_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_focus_sessions: {
        Row: {
          created_at: string | null
          duration_minutes: number | null
          end_time: string | null
          group_id: string | null
          id: string
          participants: Json | null
          start_time: string | null
          started_by: string | null
          topic: string
          total_xp_awarded: number | null
        }
        Insert: {
          created_at?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          group_id?: string | null
          id?: string
          participants?: Json | null
          start_time?: string | null
          started_by?: string | null
          topic: string
          total_xp_awarded?: number | null
        }
        Update: {
          created_at?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          group_id?: string | null
          id?: string
          participants?: Json | null
          start_time?: string | null
          started_by?: string | null
          topic?: string
          total_xp_awarded?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "group_focus_sessions_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_focus_sessions_started_by_fkey"
            columns: ["started_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_leaderboard_cache: {
        Row: {
          group_id: string
          id: number
          last_updated_at: string | null
          period_type: string
          previous_rank: number | null
          rank: number
          total_xp: number
        }
        Insert: {
          group_id: string
          id?: number
          last_updated_at?: string | null
          period_type: string
          previous_rank?: number | null
          rank: number
          total_xp: number
        }
        Update: {
          group_id?: string
          id?: number
          last_updated_at?: string | null
          period_type?: string
          previous_rank?: number | null
          rank?: number
          total_xp?: number
        }
        Relationships: [
          {
            foreignKeyName: "group_leaderboard_cache_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          banned_until: string | null
          contribution_xp: number | null
          group_id: string | null
          id: string
          joined_at: string | null
          last_nudge_received: string | null
          role: string | null
          status: string | null
          user_id: string | null
        }
        Insert: {
          banned_until?: string | null
          contribution_xp?: number | null
          group_id?: string | null
          id?: string
          joined_at?: string | null
          last_nudge_received?: string | null
          role?: string | null
          status?: string | null
          user_id?: string | null
        }
        Update: {
          banned_until?: string | null
          contribution_xp?: number | null
          group_id?: string | null
          id?: string
          joined_at?: string | null
          last_nudge_received?: string | null
          role?: string | null
          status?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_xp_history: {
        Row: {
          created_at: string | null
          group_id: string
          id: string
          period_date: string
          period_type: string
          updated_at: string | null
          xp_earned: number | null
        }
        Insert: {
          created_at?: string | null
          group_id: string
          id?: string
          period_date: string
          period_type: string
          updated_at?: string | null
          xp_earned?: number | null
        }
        Update: {
          created_at?: string | null
          group_id?: string
          id?: string
          period_date?: string
          period_type?: string
          updated_at?: string | null
          xp_earned?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "group_xp_history_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
        ]
      }
      home_banners: {
        Row: {
          action_link: string | null
          action_type: string | null
          button_text: string | null
          button_text_en: string | null
          created_at: string | null
          description: string | null
          description_en: string | null
          end_date: string | null
          id: string
          image_url: string
          is_active: boolean | null
          sequence: number | null
          start_date: string | null
          target_rules: Json | null
          title: string | null
          title_en: string | null
        }
        Insert: {
          action_link?: string | null
          action_type?: string | null
          button_text?: string | null
          button_text_en?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          end_date?: string | null
          id?: string
          image_url: string
          is_active?: boolean | null
          sequence?: number | null
          start_date?: string | null
          target_rules?: Json | null
          title?: string | null
          title_en?: string | null
        }
        Update: {
          action_link?: string | null
          action_type?: string | null
          button_text?: string | null
          button_text_en?: string | null
          created_at?: string | null
          description?: string | null
          description_en?: string | null
          end_date?: string | null
          id?: string
          image_url?: string
          is_active?: boolean | null
          sequence?: number | null
          start_date?: string | null
          target_rules?: Json | null
          title?: string | null
          title_en?: string | null
        }
        Relationships: []
      }
      home_grids: {
        Row: {
          bg_color: string | null
          color: string | null
          created_at: string | null
          icon_name: string
          id: string
          image_url: string | null
          is_active: boolean | null
          link: string | null
          serial_order: number | null
          target_rules: Json | null
          title: string
          title_en: string | null
          type: string | null
        }
        Insert: {
          bg_color?: string | null
          color?: string | null
          created_at?: string | null
          icon_name: string
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link?: string | null
          serial_order?: number | null
          target_rules?: Json | null
          title: string
          title_en?: string | null
          type?: string | null
        }
        Update: {
          bg_color?: string | null
          color?: string | null
          created_at?: string | null
          icon_name?: string
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          link?: string | null
          serial_order?: number | null
          target_rules?: Json | null
          title?: string
          title_en?: string | null
          type?: string | null
        }
        Relationships: []
      }
      institutions: {
        Row: {
          aliases: string[] | null
          code: string | null
          created_at: string | null
          display_order: number | null
          district: string | null
          division: string | null
          education_board: string | null
          eiin: string | null
          id: string
          is_active: boolean | null
          is_verified: boolean | null
          location: string | null
          name_bn: string
          name_en: string | null
          ownership: string | null
          short_name: string | null
          slug: string | null
          type: string
          upazila: string | null
          updated_at: string | null
        }
        Insert: {
          aliases?: string[] | null
          code?: string | null
          created_at?: string | null
          display_order?: number | null
          district?: string | null
          division?: string | null
          education_board?: string | null
          eiin?: string | null
          id?: string
          is_active?: boolean | null
          is_verified?: boolean | null
          location?: string | null
          name_bn: string
          name_en?: string | null
          ownership?: string | null
          short_name?: string | null
          slug?: string | null
          type: string
          upazila?: string | null
          updated_at?: string | null
        }
        Update: {
          aliases?: string[] | null
          code?: string | null
          created_at?: string | null
          display_order?: number | null
          district?: string | null
          division?: string | null
          education_board?: string | null
          eiin?: string | null
          id?: string
          is_active?: boolean | null
          is_verified?: boolean | null
          location?: string | null
          name_bn?: string
          name_en?: string | null
          ownership?: string | null
          short_name?: string | null
          slug?: string | null
          type?: string
          upazila?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      leaderboard_cache: {
        Row: {
          exam_id: string | null
          id: string
          rank: number | null
          score: number | null
          user_id: string | null
        }
        Insert: {
          exam_id?: string | null
          id?: string
          rank?: number | null
          score?: number | null
          user_id?: string | null
        }
        Update: {
          exam_id?: string | null
          id?: string
          rank?: number | null
          score?: number | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leaderboard_cache_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leaderboard_cache_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      levels_master: {
        Row: {
          badge_url: string | null
          created_at: string | null
          id: number
          max_xp: number | null
          min_xp: number
          name_bn: string
          name_en: string
          updated_at: string | null
        }
        Insert: {
          badge_url?: string | null
          created_at?: string | null
          id: number
          max_xp?: number | null
          min_xp: number
          name_bn: string
          name_en: string
          updated_at?: string | null
        }
        Update: {
          badge_url?: string | null
          created_at?: string | null
          id?: number
          max_xp?: number | null
          min_xp?: number
          name_bn?: string
          name_en?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      marketplace_items: {
        Row: {
          created_at: string | null
          description: string
          description_en: string | null
          features: Json | null
          features_en: Json | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          item_type: string
          price_coins: number
          title: string
          title_en: string | null
        }
        Insert: {
          created_at?: string | null
          description: string
          description_en?: string | null
          features?: Json | null
          features_en?: Json | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          item_type: string
          price_coins: number
          title: string
          title_en?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string
          description_en?: string | null
          features?: Json | null
          features_en?: Json | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          item_type?: string
          price_coins?: number
          title?: string
          title_en?: string | null
        }
        Relationships: []
      }
      media_library: {
        Row: {
          cloud_provider_id: string | null
          created_at: string | null
          deleted_at: string | null
          file_name: string
          file_type: string
          file_url: string
          id: string
          is_active: boolean | null
          metadata: Json | null
          tags: Json | null
          updated_at: string | null
          uploader_id: string | null
          usage_count: number | null
        }
        Insert: {
          cloud_provider_id?: string | null
          created_at?: string | null
          deleted_at?: string | null
          file_name: string
          file_type: string
          file_url: string
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          tags?: Json | null
          updated_at?: string | null
          uploader_id?: string | null
          usage_count?: number | null
        }
        Update: {
          cloud_provider_id?: string | null
          created_at?: string | null
          deleted_at?: string | null
          file_name?: string
          file_type?: string
          file_url?: string
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          tags?: Json | null
          updated_at?: string | null
          uploader_id?: string | null
          usage_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "media_library_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          action_link: string | null
          attachment_url: string | null
          body_bn: string
          body_en: string | null
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          priority: string | null
          published_at: string | null
          target_rules: Json | null
          title_bn: string
          title_en: string | null
          updated_at: string | null
        }
        Insert: {
          action_link?: string | null
          attachment_url?: string | null
          body_bn: string
          body_en?: string | null
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          priority?: string | null
          published_at?: string | null
          target_rules?: Json | null
          title_bn: string
          title_en?: string | null
          updated_at?: string | null
        }
        Update: {
          action_link?: string | null
          attachment_url?: string | null
          body_bn?: string
          body_en?: string | null
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          priority?: string | null
          published_at?: string | null
          target_rules?: Json | null
          title_bn?: string
          title_en?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_reads: {
        Row: {
          clicked_at: string | null
          device_platform: string | null
          id: string
          is_clicked: boolean | null
          is_read: boolean | null
          notification_id: string | null
          read_at: string | null
          user_id: string | null
        }
        Insert: {
          clicked_at?: string | null
          device_platform?: string | null
          id?: string
          is_clicked?: boolean | null
          is_read?: boolean | null
          notification_id?: string | null
          read_at?: string | null
          user_id?: string | null
        }
        Update: {
          clicked_at?: string | null
          device_platform?: string | null
          id?: string
          is_clicked?: boolean | null
          is_read?: boolean | null
          notification_id?: string | null
          read_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_reads_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_reads_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_templates: {
        Row: {
          action_link: string | null
          body_bn: string | null
          body_en: string
          created_at: string | null
          id: string
          image_url: string | null
          is_active: boolean | null
          template_code: string
          title_bn: string | null
          title_en: string
        }
        Insert: {
          action_link?: string | null
          body_bn?: string | null
          body_en: string
          created_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          template_code: string
          title_bn?: string | null
          title_en: string
        }
        Update: {
          action_link?: string | null
          body_bn?: string | null
          body_en?: string
          created_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean | null
          template_code?: string
          title_bn?: string | null
          title_en?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          action_link: string | null
          body_bn: string | null
          body_en: string | null
          channel: string
          created_at: string | null
          created_by: string | null
          expires_at: string | null
          id: string
          image_url: string | null
          meta_data: Json | null
          priority: string | null
          scheduled_at: string | null
          sent_at: string | null
          status: string | null
          target_rules: Json | null
          target_user_id: string | null
          title_bn: string | null
          title_en: string | null
          total_clicks: number | null
          total_sent: number | null
          type: string
        }
        Insert: {
          action_link?: string | null
          body_bn?: string | null
          body_en?: string | null
          channel: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          meta_data?: Json | null
          priority?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: string | null
          target_rules?: Json | null
          target_user_id?: string | null
          title_bn?: string | null
          title_en?: string | null
          total_clicks?: number | null
          total_sent?: number | null
          type: string
        }
        Update: {
          action_link?: string | null
          body_bn?: string | null
          body_en?: string | null
          channel?: string
          created_at?: string | null
          created_by?: string | null
          expires_at?: string | null
          id?: string
          image_url?: string | null
          meta_data?: Json | null
          priority?: string | null
          scheduled_at?: string | null
          sent_at?: string | null
          status?: string | null
          target_rules?: Json | null
          target_user_id?: string | null
          title_bn?: string | null
          title_en?: string | null
          total_clicks?: number | null
          total_sent?: number | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_parsers: {
        Row: {
          amount_regex: string
          cash_in_keyword: string
          cash_out_keyword: string | null
          created_at: string | null
          id: number
          is_active: boolean | null
          provider: string
          sender_regex: string
          sms_sender_id: string
          trx_id_regex: string
        }
        Insert: {
          amount_regex: string
          cash_in_keyword: string
          cash_out_keyword?: string | null
          created_at?: string | null
          id?: number
          is_active?: boolean | null
          provider: string
          sender_regex: string
          sms_sender_id: string
          trx_id_regex: string
        }
        Update: {
          amount_regex?: string
          cash_in_keyword?: string
          cash_out_keyword?: string | null
          created_at?: string | null
          id?: number
          is_active?: boolean | null
          provider?: string
          sender_regex?: string
          sms_sender_id?: string
          trx_id_regex?: string
        }
        Relationships: []
      }
      payment_requests: {
        Row: {
          amount: number
          coupon_code: string | null
          created_at: string | null
          currency: string | null
          gateway_response: Json | null
          id: string
          invoice_url: string | null
          method: string | null
          plan_id: string | null
          rejection_reason: string | null
          sender_number: string | null
          status: string | null
          trx_id: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          amount: number
          coupon_code?: string | null
          created_at?: string | null
          currency?: string | null
          gateway_response?: Json | null
          id?: string
          invoice_url?: string | null
          method?: string | null
          plan_id?: string | null
          rejection_reason?: string | null
          sender_number?: string | null
          status?: string | null
          trx_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          amount?: number
          coupon_code?: string | null
          created_at?: string | null
          currency?: string | null
          gateway_response?: Json | null
          id?: string
          invoice_url?: string | null
          method?: string | null
          plan_id?: string | null
          rejection_reason?: string | null
          sender_number?: string | null
          status?: string | null
          trx_id?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_requests_coupon_code_fkey"
            columns: ["coupon_code"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "payment_requests_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_requests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_sms_logs: {
        Row: {
          extracted_amount: number
          extracted_sender: string | null
          extracted_trx_id: string
          id: string
          linked_request_id: string | null
          match_confidence: string | null
          message_body: string
          message_type: string
          provider: string
          received_at: string | null
          sms_sender_number: string
          status: string | null
        }
        Insert: {
          extracted_amount: number
          extracted_sender?: string | null
          extracted_trx_id: string
          id?: string
          linked_request_id?: string | null
          match_confidence?: string | null
          message_body: string
          message_type: string
          provider: string
          received_at?: string | null
          sms_sender_number: string
          status?: string | null
        }
        Update: {
          extracted_amount?: number
          extracted_sender?: string | null
          extracted_trx_id?: string
          id?: string
          linked_request_id?: string | null
          match_confidence?: string | null
          message_body?: string
          message_type?: string
          provider?: string
          received_at?: string | null
          sms_sender_number?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payment_sms_logs_linked_request_id_fkey"
            columns: ["linked_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      permissions: {
        Row: {
          action: string
          description: string | null
          id: number
        }
        Insert: {
          action: string
          description?: string | null
          id?: number
        }
        Update: {
          action?: string
          description?: string | null
          id?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          account_status: Database["public"]["Enums"]["user_status"] | null
          achievements: Json | null
          address: Json | null
          auto_purge_at: string | null
          avatar_url: string | null
          batch_year: string | null
          bio: string | null
          class_level: string | null
          coin_balance: number | null
          created_at: string | null
          current_group_id: string | null
          current_streak: number | null
          date_of_birth: string | null
          deleted_at: string | null
          deletion_requested_at: string | null
          education_board: string | null
          email: string | null
          freezes_left: number | null
          full_name: string | null
          gender: string | null
          group: string | null
          guardian_phone: string | null
          id: string
          institution: string | null
          institution_id: string | null
          is_2fa_enabled: boolean | null
          is_email_verified: boolean
          is_phone_verified: boolean | null
          language_preference: string | null
          last_active_at: string | null
          last_streak_reset_at: string | null
          mastery: Json | null
          phone_number: string | null
          pvp_matches_played: number | null
          pvp_matches_won: number | null
          pvp_rating: number | null
          pvp_win_streak: number | null
          referral_code: string | null
          referred_by: string | null
          settings: Json | null
          study_goal: string | null
          subscription_expiry: string | null
          subscription_status: string | null
          total_xp: number | null
          updated_at: string | null
          username: string | null
        }
        Insert: {
          account_status?: Database["public"]["Enums"]["user_status"] | null
          achievements?: Json | null
          address?: Json | null
          auto_purge_at?: string | null
          avatar_url?: string | null
          batch_year?: string | null
          bio?: string | null
          class_level?: string | null
          coin_balance?: number | null
          created_at?: string | null
          current_group_id?: string | null
          current_streak?: number | null
          date_of_birth?: string | null
          deleted_at?: string | null
          deletion_requested_at?: string | null
          education_board?: string | null
          email?: string | null
          freezes_left?: number | null
          full_name?: string | null
          gender?: string | null
          group?: string | null
          guardian_phone?: string | null
          id: string
          institution?: string | null
          institution_id?: string | null
          is_2fa_enabled?: boolean | null
          is_email_verified?: boolean
          is_phone_verified?: boolean | null
          language_preference?: string | null
          last_active_at?: string | null
          last_streak_reset_at?: string | null
          mastery?: Json | null
          phone_number?: string | null
          pvp_matches_played?: number | null
          pvp_matches_won?: number | null
          pvp_rating?: number | null
          pvp_win_streak?: number | null
          referral_code?: string | null
          referred_by?: string | null
          settings?: Json | null
          study_goal?: string | null
          subscription_expiry?: string | null
          subscription_status?: string | null
          total_xp?: number | null
          updated_at?: string | null
          username?: string | null
        }
        Update: {
          account_status?: Database["public"]["Enums"]["user_status"] | null
          achievements?: Json | null
          address?: Json | null
          auto_purge_at?: string | null
          avatar_url?: string | null
          batch_year?: string | null
          bio?: string | null
          class_level?: string | null
          coin_balance?: number | null
          created_at?: string | null
          current_group_id?: string | null
          current_streak?: number | null
          date_of_birth?: string | null
          deleted_at?: string | null
          deletion_requested_at?: string | null
          education_board?: string | null
          email?: string | null
          freezes_left?: number | null
          full_name?: string | null
          gender?: string | null
          group?: string | null
          guardian_phone?: string | null
          id?: string
          institution?: string | null
          institution_id?: string | null
          is_2fa_enabled?: boolean | null
          is_email_verified?: boolean
          is_phone_verified?: boolean | null
          language_preference?: string | null
          last_active_at?: string | null
          last_streak_reset_at?: string | null
          mastery?: Json | null
          phone_number?: string | null
          pvp_matches_played?: number | null
          pvp_matches_won?: number | null
          pvp_rating?: number | null
          pvp_win_streak?: number | null
          referral_code?: string | null
          referred_by?: string | null
          settings?: Json | null
          study_goal?: string | null
          subscription_expiry?: string | null
          subscription_status?: string | null
          total_xp?: number | null
          updated_at?: string | null
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_current_group_id_fkey"
            columns: ["current_group_id"]
            isOneToOne: false
            referencedRelation: "study_groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_referred_by_fkey"
            columns: ["referred_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pvp_challenges: {
        Row: {
          challenger_id: string
          challenger_score: number | null
          challenger_time_taken: number | null
          chapter_id: string | null
          created_at: string | null
          elo_lose_snapshot: number
          elo_win_snapshot: number
          expires_at: string
          id: string
          opponent_id: string
          opponent_score: number | null
          opponent_time_taken: number | null
          question_ids: Json
          reward_coin_snapshot: number
          reward_xp_snapshot: number
          status: string
          subject_id: string
          updated_at: string | null
          winner_id: string | null
        }
        Insert: {
          challenger_id: string
          challenger_score?: number | null
          challenger_time_taken?: number | null
          chapter_id?: string | null
          created_at?: string | null
          elo_lose_snapshot: number
          elo_win_snapshot: number
          expires_at: string
          id?: string
          opponent_id: string
          opponent_score?: number | null
          opponent_time_taken?: number | null
          question_ids: Json
          reward_coin_snapshot: number
          reward_xp_snapshot: number
          status?: string
          subject_id: string
          updated_at?: string | null
          winner_id?: string | null
        }
        Update: {
          challenger_id?: string
          challenger_score?: number | null
          challenger_time_taken?: number | null
          chapter_id?: string | null
          created_at?: string | null
          elo_lose_snapshot?: number
          elo_win_snapshot?: number
          expires_at?: string
          id?: string
          opponent_id?: string
          opponent_score?: number | null
          opponent_time_taken?: number | null
          question_ids?: Json
          reward_coin_snapshot?: number
          reward_xp_snapshot?: number
          status?: string
          subject_id?: string
          updated_at?: string | null
          winner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pvp_challenges_challenger_id_fkey"
            columns: ["challenger_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pvp_challenges_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pvp_challenges_opponent_id_fkey"
            columns: ["opponent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pvp_challenges_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pvp_challenges_winner_id_fkey"
            columns: ["winner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      question_institution_references: {
        Row: {
          created_at: string | null
          exam_name: string | null
          exam_year: number | null
          id: string
          institution_id: string | null
          is_verified: boolean | null
          question_id: string
          source_label: string | null
        }
        Insert: {
          created_at?: string | null
          exam_name?: string | null
          exam_year?: number | null
          id?: string
          institution_id?: string | null
          is_verified?: boolean | null
          question_id: string
          source_label?: string | null
        }
        Update: {
          created_at?: string | null
          exam_name?: string | null
          exam_year?: number | null
          id?: string
          institution_id?: string | null
          is_verified?: boolean | null
          question_id?: string
          source_label?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "question_institution_references_institution_id_fkey"
            columns: ["institution_id"]
            isOneToOne: false
            referencedRelation: "institutions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_institution_references_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
        ]
      }
      question_tags: {
        Row: {
          created_at: string | null
          question_id: string
          tag_id: number
        }
        Insert: {
          created_at?: string | null
          question_id: string
          tag_id: number
        }
        Update: {
          created_at?: string | null
          question_id?: string
          tag_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "question_tags_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "question_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags_master"
            referencedColumns: ["id"]
          },
        ]
      }
      questions: {
        Row: {
          answer: Json | null
          approved_at: string | null
          approved_by: string | null
          audit_notes: string | null
          avg_time_spent: number | null
          body: Json
          chapter_id: string | null
          comprehension_id: string | null
          confidence_score: number | null
          content_hash: string | null
          correct_attempts: number | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          difficulty_level: string | null
          embedding: string | null
          embedding_updated_at: string | null
          embedding_version: string | null
          exam_references: Json | null
          explanation: string | null
          explanation_media_id: string | null
          id: string
          is_active: boolean | null
          is_embedding_stale: boolean | null
          media_id: string | null
          options: Json | null
          revision: number | null
          search_vector: unknown
          source_type: string | null
          status: string | null
          subject_id: string | null
          tags: string[] | null
          topic_id: string | null
          total_attempts: number | null
          type: string
          updated_at: string | null
        }
        Insert: {
          answer?: Json | null
          approved_at?: string | null
          approved_by?: string | null
          audit_notes?: string | null
          avg_time_spent?: number | null
          body: Json
          chapter_id?: string | null
          comprehension_id?: string | null
          confidence_score?: number | null
          content_hash?: string | null
          correct_attempts?: number | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          difficulty_level?: string | null
          embedding?: string | null
          embedding_updated_at?: string | null
          embedding_version?: string | null
          exam_references?: Json | null
          explanation?: string | null
          explanation_media_id?: string | null
          id?: string
          is_active?: boolean | null
          is_embedding_stale?: boolean | null
          media_id?: string | null
          options?: Json | null
          revision?: number | null
          search_vector?: unknown
          source_type?: string | null
          status?: string | null
          subject_id?: string | null
          tags?: string[] | null
          topic_id?: string | null
          total_attempts?: number | null
          type: string
          updated_at?: string | null
        }
        Update: {
          answer?: Json | null
          approved_at?: string | null
          approved_by?: string | null
          audit_notes?: string | null
          avg_time_spent?: number | null
          body?: Json
          chapter_id?: string | null
          comprehension_id?: string | null
          confidence_score?: number | null
          content_hash?: string | null
          correct_attempts?: number | null
          created_at?: string | null
          created_by?: string | null
          deleted_at?: string | null
          difficulty_level?: string | null
          embedding?: string | null
          embedding_updated_at?: string | null
          embedding_version?: string | null
          exam_references?: Json | null
          explanation?: string | null
          explanation_media_id?: string | null
          id?: string
          is_active?: boolean | null
          is_embedding_stale?: boolean | null
          media_id?: string | null
          options?: Json | null
          revision?: number | null
          search_vector?: unknown
          source_type?: string | null
          status?: string | null
          subject_id?: string | null
          tags?: string[] | null
          topic_id?: string | null
          total_attempts?: number | null
          type?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_comprehension_id_fkey"
            columns: ["comprehension_id"]
            isOneToOne: false
            referencedRelation: "comprehensions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_explanation_media_id_fkey"
            columns: ["explanation_media_id"]
            isOneToOne: false
            referencedRelation: "media_library"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media_library"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      report_exports: {
        Row: {
          file_url: string | null
          filters: Json | null
          generated_at: string | null
          id: number
          report_type: string
          requested_by: string | null
          status: string | null
        }
        Insert: {
          file_url?: string | null
          filters?: Json | null
          generated_at?: string | null
          id?: number
          report_type: string
          requested_by?: string | null
          status?: string | null
        }
        Update: {
          file_url?: string | null
          filters?: Json | null
          generated_at?: string | null
          id?: number
          report_type?: string
          requested_by?: string | null
          status?: string | null
        }
        Relationships: []
      }
      revenue_analytics_cache: {
        Row: {
          created_at: string | null
          day: string
          id: number
          plan_breakdown: Json | null
          total_revenue: number | null
          total_transactions: number | null
        }
        Insert: {
          created_at?: string | null
          day: string
          id?: number
          plan_breakdown?: Json | null
          total_revenue?: number | null
          total_transactions?: number | null
        }
        Update: {
          created_at?: string | null
          day?: string
          id?: number
          plan_breakdown?: Json | null
          total_revenue?: number | null
          total_transactions?: number | null
        }
        Relationships: []
      }
      role_permissions: {
        Row: {
          permission_id: number
          role: string
        }
        Insert: {
          permission_id: number
          role: string
        }
        Update: {
          permission_id?: number
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_migrations: {
        Row: {
          applied_at: string
          execution_time_ms: number | null
          version: string
        }
        Insert: {
          applied_at?: string
          execution_time_ms?: number | null
          version: string
        }
        Update: {
          applied_at?: string
          execution_time_ms?: number | null
          version?: string
        }
        Relationships: []
      }
      study_groups: {
        Row: {
          created_at: string | null
          created_by: string | null
          current_streak: number | null
          group_level: number | null
          icon: string | null
          id: string
          is_active: boolean | null
          join_code: string
          last_activity_date: string | null
          name: string
          total_xp: number | null
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          current_streak?: number | null
          group_level?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          join_code: string
          last_activity_date?: string | null
          name: string
          total_xp?: number | null
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          current_streak?: number | null
          group_level?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean | null
          join_code?: string
          last_activity_date?: string | null
          name?: string
          total_xp?: number | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "study_groups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      study_materials: {
        Row: {
          chapter_id: string | null
          created_at: string | null
          id: string
          is_premium: boolean | null
          media_id: string | null
          subject_id: string | null
          title: string
          title_en: string | null
          topic_id: string | null
          type: string | null
        }
        Insert: {
          chapter_id?: string | null
          created_at?: string | null
          id?: string
          is_premium?: boolean | null
          media_id?: string | null
          subject_id?: string | null
          title: string
          title_en?: string | null
          topic_id?: string | null
          type?: string | null
        }
        Update: {
          chapter_id?: string | null
          created_at?: string | null
          id?: string
          is_premium?: boolean | null
          media_id?: string | null
          subject_id?: string | null
          title?: string
          title_en?: string | null
          topic_id?: string | null
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "study_materials_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_materials_media_id_fkey"
            columns: ["media_id"]
            isOneToOne: false
            referencedRelation: "media_library"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_materials_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_materials_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
        ]
      }
      subjects: {
        Row: {
          created_at: string | null
          curriculum_version: string | null
          description: string | null
          icon_url: string | null
          id: string
          is_active: boolean | null
          is_premium: boolean | null
          language: string | null
          name_bn: string
          name_en: string
          sequence: number | null
          slug: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          curriculum_version?: string | null
          description?: string | null
          icon_url?: string | null
          id: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn: string
          name_en: string
          sequence?: number | null
          slug: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          curriculum_version?: string | null
          description?: string | null
          icon_url?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn?: string
          name_en?: string
          sequence?: number | null
          slug?: string
          updated_at?: string | null
        }
        Relationships: []
      }
      subscription_plans: {
        Row: {
          discounted_price: number | null
          duration_days: number
          features: Json | null
          features_en: Json | null
          id: string
          is_active: boolean | null
          name: string
          name_en: string | null
          price: number
          target_batches: Json | null
        }
        Insert: {
          discounted_price?: number | null
          duration_days: number
          features?: Json | null
          features_en?: Json | null
          id: string
          is_active?: boolean | null
          name: string
          name_en?: string | null
          price: number
          target_batches?: Json | null
        }
        Update: {
          discounted_price?: number | null
          duration_days?: number
          features?: Json | null
          features_en?: Json | null
          id?: string
          is_active?: boolean | null
          name?: string
          name_en?: string | null
          price?: number
          target_batches?: Json | null
        }
        Relationships: []
      }
      tags_master: {
        Row: {
          id: number
          name: string
          usage_count: number | null
        }
        Insert: {
          id?: number
          name: string
          usage_count?: number | null
        }
        Update: {
          id?: number
          name?: string
          usage_count?: number | null
        }
        Relationships: []
      }
      topics: {
        Row: {
          chapter_id: string | null
          curriculum_version: string | null
          id: string
          is_active: boolean | null
          is_premium: boolean | null
          language: string | null
          name_bn: string
          name_en: string | null
          sequence: number | null
          slug: string
          total_questions: number | null
        }
        Insert: {
          chapter_id?: string | null
          curriculum_version?: string | null
          id: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn: string
          name_en?: string | null
          sequence?: number | null
          slug: string
          total_questions?: number | null
        }
        Update: {
          chapter_id?: string | null
          curriculum_version?: string | null
          id?: string
          is_active?: boolean | null
          is_premium?: boolean | null
          language?: string | null
          name_bn?: string
          name_en?: string | null
          sequence?: number | null
          slug?: string
          total_questions?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "topics_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
        ]
      }
      user_coupon_usages: {
        Row: {
          coupon_code: string
          id: string
          payment_request_id: string | null
          used_at: string | null
          user_id: string
        }
        Insert: {
          coupon_code: string
          id?: string
          payment_request_id?: string | null
          used_at?: string | null
          user_id: string
        }
        Update: {
          coupon_code?: string
          id?: string
          payment_request_id?: string | null
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_coupon_usages_coupon_code_fkey"
            columns: ["coupon_code"]
            isOneToOne: false
            referencedRelation: "coupons"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "user_coupon_usages_payment_request_id_fkey"
            columns: ["payment_request_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_coupon_usages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_daily_activities: {
        Row: {
          activity_date: string
          created_at: string
          exams_taken: number
          extra_metrics: Json
          id: string
          study_time_minutes: number
          updated_at: string
          used_freeze: boolean | null
          user_id: string
          xp_earned: number
        }
        Insert: {
          activity_date: string
          created_at?: string
          exams_taken?: number
          extra_metrics?: Json
          id?: string
          study_time_minutes?: number
          updated_at?: string
          used_freeze?: boolean | null
          user_id: string
          xp_earned?: number
        }
        Update: {
          activity_date?: string
          created_at?: string
          exams_taken?: number
          extra_metrics?: Json
          id?: string
          study_time_minutes?: number
          updated_at?: string
          used_freeze?: boolean | null
          user_id?: string
          xp_earned?: number
        }
        Relationships: [
          {
            foreignKeyName: "user_daily_activities_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_devices: {
        Row: {
          device_id: string
          device_name: string | null
          fcm_token: string | null
          id: string
          ip_address: string | null
          is_trusted: boolean | null
          last_active_at: string | null
          os_or_browser: string | null
          platform: string
          user_id: string | null
        }
        Insert: {
          device_id: string
          device_name?: string | null
          fcm_token?: string | null
          id?: string
          ip_address?: string | null
          is_trusted?: boolean | null
          last_active_at?: string | null
          os_or_browser?: string | null
          platform?: string
          user_id?: string | null
        }
        Update: {
          device_id?: string
          device_name?: string | null
          fcm_token?: string | null
          id?: string
          ip_address?: string | null
          is_trusted?: boolean | null
          last_active_at?: string | null
          os_or_browser?: string | null
          platform?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_quest_progress: {
        Row: {
          completed_at: string | null
          id: string
          is_completed: boolean | null
          progress_count: number | null
          quest_id: string
          reset_at: string | null
          user_id: string
        }
        Insert: {
          completed_at?: string | null
          id?: string
          is_completed?: boolean | null
          progress_count?: number | null
          quest_id: string
          reset_at?: string | null
          user_id: string
        }
        Update: {
          completed_at?: string | null
          id?: string
          is_completed?: boolean | null
          progress_count?: number | null
          quest_id?: string
          reset_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_quest_progress_quest_id_fkey"
            columns: ["quest_id"]
            isOneToOne: false
            referencedRelation: "daily_quests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_quest_progress_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_reports: {
        Row: {
          admin_reply: string | null
          created_at: string | null
          description: string | null
          id: string
          report_reason: string | null
          reporter_user_id: string | null
          resolved_by: string | null
          screenshot_url: string | null
          status: string | null
          target_exam_id: string | null
          target_message_id: string | null
          target_question_id: string | null
          target_user_id: string | null
          type: string
        }
        Insert: {
          admin_reply?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          report_reason?: string | null
          reporter_user_id?: string | null
          resolved_by?: string | null
          screenshot_url?: string | null
          status?: string | null
          target_exam_id?: string | null
          target_message_id?: string | null
          target_question_id?: string | null
          target_user_id?: string | null
          type: string
        }
        Update: {
          admin_reply?: string | null
          created_at?: string | null
          description?: string | null
          id?: string
          report_reason?: string | null
          reporter_user_id?: string | null
          resolved_by?: string | null
          screenshot_url?: string | null
          status?: string | null
          target_exam_id?: string | null
          target_message_id?: string | null
          target_question_id?: string | null
          target_user_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_reporter_user"
            columns: ["reporter_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_reports_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_reports_target_exam_id_fkey"
            columns: ["target_exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_reports_target_message_id_fkey"
            columns: ["target_message_id"]
            isOneToOne: false
            referencedRelation: "group_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_reports_target_question_id_fkey"
            columns: ["target_question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_reports_target_user_id_fkey"
            columns: ["target_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          assigned_by: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          role: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          role?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          assigned_by?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          role?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      user_subscriptions: {
        Row: {
          auto_renewal: boolean | null
          end_date: string
          id: string
          payment_id: string | null
          plan_id: string | null
          start_date: string | null
          status: string | null
          user_id: string | null
        }
        Insert: {
          auto_renewal?: boolean | null
          end_date: string
          id?: string
          payment_id?: string | null
          plan_id?: string | null
          start_date?: string | null
          status?: string | null
          user_id?: string | null
        }
        Update: {
          auto_renewal?: boolean | null
          end_date?: string
          id?: string
          payment_id?: string | null
          plan_id?: string | null
          start_date?: string | null
          status?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "user_subscriptions_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payment_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "subscription_plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_subscriptions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      user_warnings: {
        Row: {
          created_at: string | null
          id: string
          issued_by: string | null
          strike_weight: number | null
          target_chat_id: string | null
          user_id: string
          warning_reason: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          issued_by?: string | null
          strike_weight?: number | null
          target_chat_id?: string | null
          user_id: string
          warning_reason: string
        }
        Update: {
          created_at?: string | null
          id?: string
          issued_by?: string | null
          strike_weight?: number | null
          target_chat_id?: string | null
          user_id?: string
          warning_reason?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_warnings_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_warnings_target_chat_id_fkey"
            columns: ["target_chat_id"]
            isOneToOne: false
            referencedRelation: "group_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_warnings_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      wrong_answers: {
        Row: {
          created_at: string | null
          exam_id: string | null
          id: string
          question_id: string | null
          selected_option: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          exam_id?: string | null
          id?: string
          question_id?: string | null
          selected_option?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          exam_id?: string | null
          id?: string
          question_id?: string | null
          selected_option?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "wrong_answers_exam_id_fkey"
            columns: ["exam_id"]
            isOneToOne: false
            referencedRelation: "exam_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wrong_answers_question_id_fkey"
            columns: ["question_id"]
            isOneToOne: false
            referencedRelation: "questions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wrong_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      search_index: {
        Row: {
          content: string | null
          entity_id: string | null
          meta_data: Json | null
          type: string | null
        }
        Relationships: []
      }
      student_topic_analytics: {
        Row: {
          chapter_id: string | null
          subject_id: string | null
          topic_id: string | null
          topic_name_bn: string | null
          topic_name_en: string | null
          total_mistakes: number | null
          user_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "questions_chapter_id_fkey"
            columns: ["chapter_id"]
            isOneToOne: false
            referencedRelation: "chapters"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_subject_id_fkey"
            columns: ["subject_id"]
            isOneToOne: false
            referencedRelation: "subjects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "questions_topic_id_fkey"
            columns: ["topic_id"]
            isOneToOne: false
            referencedRelation: "topics"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wrong_answers_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      apply_referral_code: {
        Args: { p_referral_code: string; p_user_id: string }
        Returns: Json
      }
      bulk_soft_delete_by_chapter: {
        Args: { chapter_target_id: string }
        Returns: undefined
      }
      finalize_pvp_match: { Args: { match_id: string }; Returns: undefined }
      find_duplicate_questions: {
        Args: { similarity_threshold: number }
        Returns: {
          body: Json
          id: string
          other_body: Json
          other_id: string
          similarity: number
        }[]
      }
      get_adaptive_random_questions: {
        Args: { p_limit: number; p_user_id: string }
        Returns: {
          answer: Json | null
          approved_at: string | null
          approved_by: string | null
          audit_notes: string | null
          avg_time_spent: number | null
          body: Json
          chapter_id: string | null
          comprehension_id: string | null
          confidence_score: number | null
          content_hash: string | null
          correct_attempts: number | null
          created_at: string | null
          created_by: string | null
          deleted_at: string | null
          difficulty_level: string | null
          embedding: string | null
          embedding_updated_at: string | null
          embedding_version: string | null
          exam_references: Json | null
          explanation: string | null
          explanation_media_id: string | null
          id: string
          is_active: boolean | null
          is_embedding_stale: boolean | null
          media_id: string | null
          options: Json | null
          revision: number | null
          search_vector: unknown
          source_type: string | null
          status: string | null
          subject_id: string | null
          tags: string[] | null
          topic_id: string | null
          total_attempts: number | null
          type: string
          updated_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "questions"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      get_current_streak: { Args: { p_user_id: string }; Returns: number }
      get_current_user_id: { Args: never; Returns: string }
      get_longest_streak: {
        Args: { p_user_id: string }
        Returns: {
          longest_streak_days: number
          streak_end_date: string
          streak_start_date: string
        }[]
      }
      get_student_subject_analytics: {
        Args: { p_user_id: string }
        Returns: {
          average_score: number
          mastery_percentage: number
          subject_name: string
          total_correct: number
          total_skipped: number
          total_wrong: number
        }[]
      }
      get_student_weaknesses: {
        Args: { p_user_id: string }
        Returns: {
          error_rate: number
          subject_name: string
          topic_name: string
        }[]
      }
      get_user_heatmap: {
        Args: { p_user_id: string }
        Returns: {
          cal_date: string
          exams_taken: number
          study_time_minutes: number
          xp_earned: number
        }[]
      }
      is_admin: { Args: never; Returns: boolean }
      is_group_member: { Args: { _group_id: string }; Returns: boolean }
      match_questions:
        | {
            Args: {
              match_count: number
              match_threshold: number
              query_embedding: string
            }
            Returns: {
              body: Json
              explanation: string
              id: string
              similarity: number
            }[]
          }
        | {
            Args: {
              filter_subject_id: string
              match_count: number
              match_threshold: number
              query_embedding: string
            }
            Returns: {
              body: Json
              explanation: string
              id: string
              similarity: number
            }[]
          }
      refresh_global_index: { Args: never; Returns: undefined }
      refresh_vector_index: { Args: never; Returns: undefined }
      submit_payment_claim: {
        Args: {
          p_amount: number
          p_method: string
          p_plan_id: string
          p_sender_number: string
          p_trx_id: string
          p_user_id: string
        }
        Returns: Json
      }
      submit_payment_request: {
        Args: {
          p_amount: number
          p_method: string
          p_plan_id: string
          p_sender_number: string
          p_trx_id: string
          p_user_id: string
        }
        Returns: Json
      }
      update_user_progress: {
        Args: { p_coins: number; p_user_id: string; p_xp: number }
        Returns: undefined
      }
    }
    Enums: {
      user_status: "active" | "suspended" | "deleted"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      user_status: ["active", "suspended", "deleted"],
    },
  },
} as const

