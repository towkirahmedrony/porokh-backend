import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { identifier, password } = await req.json()

    // Service Role Key ব্যবহার করে অ্যাডমিন ক্লায়েন্ট তৈরি
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    let loginEmail = identifier

    // যদি ইনপুটে '@' না থাকে, তবে এটি ইউজারনেম। ডাটাবেস থেকে ইমেইল বের করা হবে।
    if (!identifier.includes('@')) {
      const { data, error } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('username', identifier.toLowerCase())
        .single()

      if (error || !data) {
        return new Response(JSON.stringify({ error: 'Invalid login credentials' }), { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        })
      }
      loginEmail = data.email
    }

    // অথেনটিকেশন করা
    const { data: authData, error: authError } = await supabaseAdmin.auth.signInWithPassword({
      email: loginEmail,
      password: password,
    })

    if (authError) throw authError

    // সফল হলে ক্লায়েন্টকে সেশন ডেটা ফেরত দেওয়া
    return new Response(JSON.stringify({ session: authData.session }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
