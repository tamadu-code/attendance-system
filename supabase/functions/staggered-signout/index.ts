import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
  // 1. Check Secret using custom header to bypass Supabase JWT filters
  const AUTO_SIGNOUT_SECRET = Deno.env.get('AUTO_SIGNOUT_SECRET')
  const clientSecret = req.headers.get('X-Auto-Signout-Secret')

  if (!clientSecret || clientSecret !== AUTO_SIGNOUT_SECRET) {
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      message: 'Secret mismatch. Check X-Auto-Signout-Secret header.'
    }), { status: 401, headers: { "Content-Type": "application/json" } })
  }

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    const today = new Date().toISOString().split('T')[0]
    const nowUtc = new Date()

    // 1. Get Config from settings table
    const { data: settings, error: settingsError } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'config')
      .single()

    if (settingsError || !settings) throw new Error('Configuration not found in settings table.')

    const config = settings.value
    const schoolClosingTime = config.school_closing_time || '15:30'
    const groupSize = config.dismissal_group_size || 20
    const intervalMinutes = config.dismissal_interval_minutes || 1

    // 2. Manage Daily Groups
    const { data: groups, error: groupsError } = await supabase
      .from('daily_groups')
      .select('student_id')
      .eq('date', today)
      .limit(1)

    if (groupsError) throw groupsError

    if (groups.length === 0) {
      const { data: students, error: studentsError } = await supabase.from('students').select('id')
      if (studentsError) throw studentsError

      const shuffled = students.sort(() => Math.random() - 0.5)
      const groupData = shuffled.map((s, index) => ({
        date: today,
        student_id: s.id,
        group_index: Math.floor(index / groupSize)
      }))

      const { error: insertError } = await supabase.from('daily_groups').insert(groupData)
      if (insertError) throw insertError
    }

    // 3. Process Automatic Sign-outs
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('student_id, sign_in, sign_out')
      .eq('date', today)
      .not('sign_in', 'is', null)
      .is('sign_out', null)

    if (attendanceError) throw attendanceError
    if (attendance.length === 0) {
      return new Response(JSON.stringify({ message: 'Success: No students active to sign out.' }), {
        status: 200, headers: { "Content-Type": "application/json" }
      })
    }

    const studentIds = attendance.map(a => a.student_id)
    const { data: studentGroups, error: sgError } = await supabase
      .from('daily_groups')
      .select('student_id, group_index')
      .eq('date', today)
      .in('student_id', studentIds)

    if (sgError) throw sgError

    const groupMap = new Map(studentGroups.map(sg => [sg.student_id, sg.group_index]))
    const [hours, minutes] = schoolClosingTime.split(':').map(Number)
    const baseTime = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), hours, minutes, 0))

    let signedOutCount = 0
    const timeStr = nowUtc.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })

    for (const record of attendance) {
      const groupIndex = groupMap.get(record.student_id) ?? 0
      const scheduledTime = new Date(baseTime.getTime() + groupIndex * intervalMinutes * 60000)

      if (nowUtc >= scheduledTime) {
        const { error: updateError } = await supabase
          .from('attendance')
          .update({ sign_out: timeStr })
          .match({ student_id: record.student_id, date: today })
        if (!updateError) signedOutCount++
      }
    }

    return new Response(JSON.stringify({
      message: `Success: System checked ${attendance.length} records and signed out ${signedOutCount} students.`,
      timestamp: nowUtc.toISOString()
    }), { status: 200, headers: { "Content-Type": "application/json" } })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    })
  }
})
