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
  let attendanceCode;
  try {
    const body = await req.json()
    attendanceCode = body.attendance_code
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  if (attendanceCode === undefined) {
    return new Response(JSON.stringify({ error: 'Missing attendance_code' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 3. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  // 4. Update Student (Soft Delete)
  const { data, error, count } = await supabase
    .from('students')
    .update({ is_active: false })
    .eq('code', attendanceCode)
    .select()

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
