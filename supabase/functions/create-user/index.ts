import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  // 1. Authenticate via Bearer Token
  const authHeader = req.headers.get('Authorization')
  const expectedToken = Deno.env.get('EXPECTED_TOKEN')

  if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    })
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
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 3. Validation
  if (!email || !role) {
    return new Response(JSON.stringify({ error: 'Missing email or role' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  if (role !== 'Teacher' && role !== 'Admin') {
    return new Response(JSON.stringify({ error: 'Role must be either "Teacher" or "Admin"' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  const tenantIdVal = tenantId || '00000000-0000-0000-0000-000000000001';

  // 4. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
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
      return new Response(JSON.stringify({ error: 'Database error searching profiles: ' + profileGetError.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      })
    }

    if (profile) {
      userId = profile.id;
    } else {
      // Check auth.users directly by listing users (in case profile doesn't exist but auth does)
      const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
      if (listError) {
        return new Response(JSON.stringify({ error: 'Auth API error listing users: ' + listError.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        })
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
        return new Response(JSON.stringify({ error: 'Auth API error updating user: ' + updateError.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        })
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
        return new Response(JSON.stringify({ error: 'Auth API error creating user: ' + createError.message }), { 
          status: 500, 
          headers: { "Content-Type": "application/json" } 
        })
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
      return new Response(JSON.stringify({ error: 'Database error upserting profile: ' + upsertError.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      })
    }

    return new Response(JSON.stringify({ id: userId, email, role, status }), { 
      status: status === 'created' ? 201 : 200, 
      headers: { "Content-Type": "application/json" } 
    })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    })
  }
})
