import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  })
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // 1. Authenticate via Bearer Token (accept either expectedToken or service role key)
  const authHeader = req.headers.get('Authorization')
  const expectedToken = Deno.env.get('EXPECTED_TOKEN')
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const isAuthorized = 
    (expectedToken && authHeader === `Bearer ${expectedToken}`) ||
    (supabaseServiceRoleKey && authHeader === `Bearer ${supabaseServiceRoleKey}`)

  if (!authHeader || !isAuthorized) {
    return jsonResponse({ error: 'Unauthorized' }, 401)
  }

  // 2. Parse Request Body
  let email, password, fullName, role, tenantId;
  try {
    const body = await req.json()
    email = body.email
    password = body.password
    fullName = body.full_name
    role = body.role
    tenantId = body.tenant_id
  } catch (e) {
    return jsonResponse({ error: 'Invalid JSON body' }, 400)
  }

  // 3. Validation
  if (!email || !role) {
    return jsonResponse({ error: 'Missing email or role' }, 400)
  }

  if (role !== 'Teacher' && role !== 'Admin') {
    return jsonResponse({ error: 'Role must be either "Teacher" or "Admin"' }, 400)
  }

  const tenantIdVal = tenantId || '00000000-0000-0000-0000-000000000001';

  // 4. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  try {
    // 5. Idempotent Lookup: Find if user already exists
    let userId = null;
    
    // Check profiles table first
    const { data: profile, error: profileGetError } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (profileGetError) {
      return jsonResponse({ error: 'Database error searching profiles: ' + profileGetError.message }, 500)
    }

    if (profile) {
      userId = profile.id;
    } else {
      // Check auth.users directly by listing users (in case profile doesn't exist but auth does)
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) {
        return jsonResponse({ error: 'Auth API error listing users: ' + listError.message }, 500)
      }
      
      const matched = users?.find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (matched) {
        userId = matched.id;
      }
    }

    let status = 'updated';

    if (userId) {
      // User exists, update auth attributes
      const updateData: any = { email_confirm: true };
      if (password) updateData.password = password;
      if (fullName) updateData.user_metadata = { full_name: fullName };

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, updateData);
      if (updateError) {
        return jsonResponse({ error: 'Auth API error updating user: ' + updateError.message }, 500)
      }
    } else {
      // User does not exist, create auth user
      const createData: any = {
        email,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      };
      
      if (password) {
        createData.password = password;
      } else {
        // Fallback: generate a secure random password if none is provided
        createData.password = Math.random().toString(36).slice(-10) + Math.random().toString(36).toUpperCase().slice(-5);
      }

      const { data: createResult, error: createError } = await supabase.auth.admin.createUser(createData);
      if (createError) {
        return jsonResponse({ error: 'Auth API error creating user: ' + createError.message }, 500)
      }
      
      userId = createResult.user.id;
      status = 'created';
    }

    // 6. Upsert the profile record to match auth user and link tenant + role
    const { error: upsertError } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        tenant_id: tenantIdVal,
        role: role,
        full_name: fullName,
        email: email
      });

    if (upsertError) {
      return jsonResponse({ error: 'Database error upserting profile: ' + upsertError.message }, 500)
    }

    return jsonResponse({ id: userId, email, role, status }, status === 'created' ? 201 : 200)

  } catch (err: any) {
    return jsonResponse({ error: err.message || 'Internal server error' }, 500)
  }
})
