import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  // 1. Authenticate via Bearer Token (accept either expectedToken or service role key)
  const authHeader = req.headers.get('Authorization')
  const expectedToken = Deno.env.get('EXPECTED_TOKEN')
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  const isAuthorized = 
    (expectedToken && authHeader === `Bearer ${expectedToken}`) ||
    (supabaseServiceRoleKey && authHeader === `Bearer ${supabaseServiceRoleKey}`)

  if (!authHeader || !isAuthorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 2. Parse Request Body
  let name, studentClass, tenantId;
  try {
    const body = await req.json()
    name = body.name
    studentClass = body.class
    tenantId = body.tenant_id
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  if (!name || !studentClass) {
    return new Response(JSON.stringify({ error: 'Missing name or class' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  const tenantIdVal = tenantId || '00000000-0000-0000-0000-000000000001';

  // 3. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  // 4. Generate Unique 4-digit code (scoped to tenant)
  let code: number = 0;
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    code = Math.floor(1000 + Math.random() * 9000); // 1000 to 9999
    const { data, error } = await supabase
      .from('students')
      .select('code')
      .eq('code', code)
      .eq('tenant_id', tenantIdVal)
      .maybeSingle();

    if (error) {
      return new Response(JSON.stringify({ error: 'Database error while checking code' }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      })
    }

    if (!data) {
      // Code is unique within this tenant
      break;
    }
    attempts++;
  }

  if (attempts === maxAttempts) {
    return new Response(JSON.stringify({ error: 'Failed to generate a unique code after 100 attempts' }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 5. Insert Student
  const { error: insertError } = await supabase
    .from('students')
    .insert([
      { code, name, class: studentClass, is_active: true, tenant_id: tenantIdVal }
    ])

  if (insertError) {
    return new Response(JSON.stringify({ error: insertError.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  return new Response(JSON.stringify({ attendance_code: code }), { 
    status: 201, 
    headers: { "Content-Type": "application/json" } 
  })
})
