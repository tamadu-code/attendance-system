import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  // Debug: Print environment variables
  const url = new URL(req.url)
  if (url.searchParams.get('debug') === 'true') {
    return new Response(JSON.stringify({
      EXPECTED_TOKEN: Deno.env.get('EXPECTED_TOKEN'),
      EXPECTED_TOKEN_LENGTH: Deno.env.get('EXPECTED_TOKEN')?.length || 0,
      SUPABASE_URL: Deno.env.get('SUPABASE_URL')
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
  }

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
  let attendanceCode, tenantId, studentId;
  try {
    const body = await req.json()
    attendanceCode = body.attendance_code
    tenantId = body.tenant_id
    studentId = body.student_id
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  if (!attendanceCode && !studentId) {
    return new Response(JSON.stringify({ error: 'Missing attendance_code or student_id' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 3. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  // 4. Update Student (Soft Delete)
  let query = supabase.from('students').update({ is_active: false })

  if (attendanceCode) {
    const codeStr = String(attendanceCode).trim();
    if (!/^\d+$/.test(codeStr)) {
      return new Response(JSON.stringify({ error: 'Invalid attendance_code format' }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      })
    }
    query = query.eq('code', codeStr)
  } else {
    // If only studentId is provided, verify it is a valid UUID before querying id
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(studentId);
    if (!isUuid) {
      return new Response(JSON.stringify({ error: 'student_id must be a valid UUID' }), { 
        status: 400, 
        headers: { "Content-Type": "application/json" } 
      })
    }
    query = query.eq('id', studentId)
  }

  if (tenantId) {
    query = query.eq('tenant_id', tenantId)
  }

  const { data, error } = await query.select()

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  if (!data || data.length === 0) {
    return new Response(JSON.stringify({ error: 'Student not found' }), { 
      status: 404, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  return new Response(JSON.stringify({ message: 'Student deactivated successfully' }), { 
    status: 200, 
    headers: { "Content-Type": "application/json" } 
  })
})
