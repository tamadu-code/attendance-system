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
  let id, name, slug, studentIdPrefix;
  try {
    const body = await req.json()
    id = body.id
    name = body.name
    slug = body.slug
    studentIdPrefix = body.student_id_prefix
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 3. Validation
  if (!id || !name || !slug) {
    return new Response(JSON.stringify({ error: 'Missing id (UUID), name, or slug' }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    })
  }

  // 4. Initialize Supabase Client
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  try {
    // 5. Upsert Tenant record
    const { error: tenantError } = await supabase
      .from('tenants')
      .upsert({
        id: id,
        name: name,
        slug: slug,
        student_id_prefix: studentIdPrefix || 'NKQMS',
        status: 'active',
        updated_at: new Date().toISOString()
      });

    if (tenantError) {
      return new Response(JSON.stringify({ error: 'Database error upserting tenant: ' + tenantError.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      })
    }

    // 6. Upsert default Subscription for this tenant
    const { error: subError } = await supabase
      .from('subscriptions')
      .upsert({
        tenant_id: id,
        plan_tier: 'standard',
        status: 'active',
        max_student_limit: 500,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'tenant_id'
      });

    if (subError) {
      return new Response(JSON.stringify({ error: 'Database error setting up subscription: ' + subError.message }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      })
    }

    return new Response(JSON.stringify({ success: true, tenant_id: id, name, slug }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Internal server error' }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    })
  }
})
