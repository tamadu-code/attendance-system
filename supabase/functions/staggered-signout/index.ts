import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-auto-signout-secret',
}

serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. Validate Secret
    const AUTO_SIGNOUT_SECRET = Deno.env.get('AUTO_SIGNOUT_SECRET')
    const clientSecret = req.headers.get('X-Auto-Signout-Secret')

    if (!AUTO_SIGNOUT_SECRET) {
      console.error("Environment variable AUTO_SIGNOUT_SECRET is not set.")
      return new Response(JSON.stringify({ error: 'Server Configuration Error', message: 'AUTO_SIGNOUT_SECRET missing.' }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    if (!clientSecret || clientSecret !== AUTO_SIGNOUT_SECRET) {
      console.warn(`Unauthorized attempt with secret: ${clientSecret?.substring(0, 3)}...`)
      return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Secret mismatch.' }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 2. Initialize Supabase
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase credentials in environment.")
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // 3. Parse optional tenant_id from request body (for manual single-tenant trigger)
    let targetTenantId: string | null = null
    try {
      const body = await req.json()
      if (body && body.tenant_id) {
        targetTenantId = body.tenant_id
        console.log(`Manual trigger received for specific tenant: ${targetTenantId}`)
      }
    } catch (_) {
      // No body or invalid JSON — process all tenants (cron job default)
    }

    // 3b. Execution Context
    const nowUtc = new Date()
    const localNow = new Date(nowUtc.getTime() + (1 * 60 * 60 * 1000)) // UTC -> WAT (UTC+1)
    const today = localNow.toISOString().split('T')[0] // WAT date, not UTC
    const isFriday = localNow.getDay() === 5 // 0 = Sun, 5 = Fri, 6 = Sat
    const timeStr = `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`
    console.log(`[${nowUtc.toISOString()}] Starting ${targetTenantId ? 'single-tenant' : 'multi-tenant'} staggered sign-out process for date: ${today} (WAT)`)

    // 4. Get Configs — filter to specific tenant if provided
    let settingsQuery = supabase
      .from('settings')
      .select('tenant_id, value')
      .eq('key', 'config')

    if (targetTenantId) {
      settingsQuery = settingsQuery.eq('tenant_id', targetTenantId)
    }

    const { data: allSettings, error: settingsError } = await settingsQuery

    if (settingsError || !allSettings) {
      console.error("Settings error:", settingsError)
      throw new Error('No configurations found in "settings" table.')
    }

    if (allSettings.length === 0 && targetTenantId) {
      return new Response(JSON.stringify({ 
        error: 'No configuration found for tenant', 
        tenant_id: targetTenantId 
      }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    let totalChecked = 0
    let totalSignedOut = 0
    let totalQueued = 0
    const results = []

    for (const settings of allSettings) {
      const tenant_id = settings.tenant_id
      const config = settings.value || {}
      
      console.log(`Processing Tenant: ${tenant_id}`)

      let schoolClosingTime = config.school_closing_time || '15:30'
      if (isFriday) {
        schoolClosingTime = '14:00' // Friday closing time is 2:00 PM WAT
      }
      const groupSize = config.dismissal_group_size || 20
      const intervalMinutes = config.dismissal_interval_minutes || 1

      // Holiday & Term Closure Safeguards
      const holidays = config.holidays || []
      if (holidays.includes(today)) {
        console.log(`[${today}] Tenant ${tenant_id} has a scheduled school holiday. Skipping.`)
        continue
      }

      if (config.isTermClosed) {
        console.log(`[${today}] Tenant ${tenant_id} term is closed. Skipping.`)
        continue
      }

      // 5. Manage Daily Groups (Randomize order once per day per tenant)
      const { data: groupsExist, error: groupsError } = await supabase
        .from('daily_groups')
        .select('student_id')
        .eq('date', today)
        .eq('tenant_id', tenant_id)
        .limit(1)

      if (groupsError) {
        console.error(`Daily groups check failed for tenant ${tenant_id}:`, groupsError)
        continue
      }

      if (groupsExist.length === 0) {
        console.log(`Populating daily_groups for tenant ${tenant_id}...`)
        const { data: activeStudents, error: studentsError } = await supabase
          .from('students')
          .select('id')
          .eq('is_active', true)
          .eq('tenant_id', tenant_id)

        if (studentsError) {
          console.error(`Active students fetch failed for tenant ${tenant_id}:`, studentsError)
          continue
        }
        
        if (activeStudents && activeStudents.length > 0) {
          // Shuffle active students (Fisher-Yates)
          const shuffled = [...activeStudents]
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
          }

          const groupData = shuffled.map((s, index) => ({
            date: today,
            student_id: s.id,
            group_index: Math.floor(index / groupSize),
            tenant_id: tenant_id
          }))

          const { error: insertError } = await supabase.from('daily_groups').insert(groupData)
          if (insertError) {
            console.error(`Failed to insert daily groups for tenant ${tenant_id}:`, insertError)
            continue
          }
          console.log(`Created ${groupData.length} group assignments for tenant ${tenant_id}.`)
        } else {
          console.log(`No active students found to assign to groups for tenant ${tenant_id}.`)
        }
      }

      // 6. Identify Students to Sign Out
      const { data: attendance, error: attendanceError } = await supabase
        .from('attendance')
        .select('student_id, sign_in, sign_out')
        .eq('date', today)
        .eq('tenant_id', tenant_id)
        .not('sign_in', 'is', null)
        .is('sign_out', null)

      if (attendanceError) {
        console.error(`Attendance fetch failed for tenant ${tenant_id}:`, attendanceError)
        continue
      }
      
      if (!attendance || attendance.length === 0) {
        console.log(`No active students (present but not signed out) found for tenant ${tenant_id}.`)
        continue
      }

      // 7. Get Group Indices for Active Students
      const studentIds = attendance.map((a: any) => a.student_id)
      const { data: studentGroups, error: sgError } = await supabase
        .from('daily_groups')
        .select('student_id, group_index')
        .eq('date', today)
        .eq('tenant_id', tenant_id)
        .in('student_id', studentIds)

      if (sgError) {
        console.error(`Group index fetch failed for tenant ${tenant_id}:`, sgError)
        continue
      }

      const groupMap = new Map<string, number>((studentGroups || []).map((sg: any) => [sg.student_id, sg.group_index]))

      // 8. Calculate Thresholds
      const [hours, minutes] = schoolClosingTime.split(':').map(Number)
      const baseTimeUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), hours, minutes, 0))
      const schoolBaseTime = new Date(baseTimeUtc.getTime() - (1 * 60 * 60 * 1000)) // WAT -> UTC adjustment

      let signedOutCount = 0
      let skippedCount = 0

      for (const record of attendance) {
        const groupIndex = groupMap.get(record.student_id) ?? 0
        const scheduledTime = new Date(schoolBaseTime.getTime() + groupIndex * intervalMinutes * 60000)

        if (nowUtc >= scheduledTime) {
          const { error: updateError } = await supabase
            .from('attendance')
            .update({ sign_out: timeStr })
            .match({ student_id: record.student_id, date: today, tenant_id: tenant_id })
          
          if (updateError) {
            console.error(`Failed to sign out student ${record.student_id} for tenant ${tenant_id}:`, updateError)
          } else {
            signedOutCount++
          }
        } else {
          skippedCount++
        }
      }

      console.log(`Tenant ${tenant_id} Process Complete: Signed out ${signedOutCount}, Queued ${skippedCount}.`)
      totalChecked += attendance.length
      totalSignedOut += signedOutCount
      totalQueued += skippedCount
      results.push({ tenant_id, checked: attendance.length, signed_out: signedOutCount, queued: skippedCount })
    }

    return new Response(JSON.stringify({
      message: `Checked ${totalChecked} records across ${allSettings.length} tenants.`,
      signed_out: totalSignedOut,
      queued: totalQueued,
      local_time: timeStr,
      tenants: results
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  } catch (err) {
    console.error("Global Function Error:", err)
    return new Response(JSON.stringify({ error: (err as any).message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }
})
