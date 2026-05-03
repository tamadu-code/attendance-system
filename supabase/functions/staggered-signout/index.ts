import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-auto-signout-secret',
}

serve(async (req) => {
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

    // 3. Execution Context
    const nowUtc = new Date()
    const today = nowUtc.toISOString().split('T')[0]
    console.log(`[${nowUtc.toISOString()}] Starting staggered sign-out process for date: ${today}`)

    // 4. Get Config
    const { data: settings, error: settingsError } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'config')
      .single()

    if (settingsError || !settings) {
      console.error("Settings error:", settingsError)
      throw new Error('Configuration row "config" not found in "settings" table.')
    }

    const config = settings.value || {}
    const schoolClosingTime = config.school_closing_time || '15:30'
    const groupSize = config.dismissal_group_size || 20
    const intervalMinutes = config.dismissal_interval_minutes || 1

    console.log(`Config: Closing Time=${schoolClosingTime}, Group Size=${groupSize}, Interval=${intervalMinutes}m`)

    // 5. Manage Daily Groups (Randomize order once per day)
    const { data: groupsExist, error: groupsError } = await supabase
      .from('daily_groups')
      .select('student_id')
      .eq('date', today)
      .limit(1)

    if (groupsError) throw groupsError

    if (groupsExist.length === 0) {
      console.log(`Populating daily_groups for ${today}...`)
      const { data: activeStudents, error: studentsError } = await supabase
        .from('students')
        .select('id')
        .eq('is_active', true)

      if (studentsError) throw studentsError
      
      if (activeStudents && activeStudents.length > 0) {
        // Robust Shuffle (Fisher-Yates)
        const shuffled = [...activeStudents]
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
        }

        const groupData = shuffled.map((s, index) => ({
          date: today,
          student_id: s.id,
          group_index: Math.floor(index / groupSize)
        }))

        const { error: insertError } = await supabase.from('daily_groups').insert(groupData)
        if (insertError) throw insertError
        console.log(`Created ${groupData.length} group assignments.`)
      } else {
        console.log("No active students found to assign to groups.")
      }
    }

    // 6. Identify Students to Sign Out
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('student_id, sign_in, sign_out')
      .eq('date', today)
      .not('sign_in', 'is', null)
      .is('sign_out', null)

    if (attendanceError) throw attendanceError
    
    if (!attendance || attendance.length === 0) {
      console.log("No active students (present but not signed out) found.")
      return new Response(JSON.stringify({ message: 'Success: No students active to sign out.' }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } })
    }

    // 7. Get Group Indices for Active Students
    const studentIds = attendance.map(a => a.student_id)
    const { data: studentGroups, error: sgError } = await supabase
      .from('daily_groups')
      .select('student_id, group_index')
      .eq('date', today)
      .in('student_id', studentIds)

    if (sgError) throw sgError

    const groupMap = new Map(studentGroups.map(sg => [sg.student_id, sg.group_index]))

    // 8. Calculate Thresholds
    // Convert School Closing Time (WAT, UTC+1) to UTC Reference
    const [hours, minutes] = schoolClosingTime.split(':').map(Number)
    const baseTimeUtc = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), hours, minutes, 0))
    const schoolBaseTime = new Date(baseTimeUtc.getTime() - (1 * 60 * 60 * 1000)) // WAT -> UTC adjustment
    
    const localNow = new Date(nowUtc.getTime() + (1 * 60 * 60 * 1000)) // UTC -> WAT for display
    const timeStr = `${String(localNow.getUTCHours()).padStart(2, '0')}:${String(localNow.getUTCMinutes()).padStart(2, '0')}`

    console.log(`Dismissal Window: Base (WAT)=${schoolClosingTime}, Base (UTC)=${schoolBaseTime.toISOString()}. Current (WAT)=${timeStr}`)

    // 9. Update Attendance Records
    let signedOutCount = 0
    let skippedCount = 0

    for (const record of attendance) {
      const groupIndex = groupMap.get(record.student_id) ?? 0
      const scheduledTime = new Date(schoolBaseTime.getTime() + groupIndex * intervalMinutes * 60000)

      if (nowUtc >= scheduledTime) {
        const { error: updateError } = await supabase
          .from('attendance')
          .update({ sign_out: timeStr })
          .match({ student_id: record.student_id, date: today })
        
        if (updateError) {
          console.error(`Failed to update student ${record.student_id}:`, updateError)
        } else {
          signedOutCount++
        }
      } else {
        skippedCount++
      }
    }

    console.log(`Process Complete: Signed out ${signedOutCount}, Queued ${skippedCount}.`)

    return new Response(JSON.stringify({
      message: `System checked ${attendance.length} records.`,
      signed_out: signedOutCount,
      queued: skippedCount,
      local_time: timeStr
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } })

  } catch (err) {
    console.error("Function Error:", err)
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } })
  }
})
