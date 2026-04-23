import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const AUTO_SIGNOUT_SECRET = Deno.env.get('AUTO_SIGNOUT_SECRET') ?? ''

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${AUTO_SIGNOUT_SECRET}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }

  try {
    const today = new Date().toISOString().split('T')[0]
    const nowUtc = new Date()
    
    // 1. Get Config
    const { data: settings, error: settingsError } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'config')
      .single()

    if (settingsError || !settings) {
      throw new Error('Config not found')
    }

    const config = settings.value
    const schoolClosingTime = config.school_closing_time || '15:30'
    const groupSize = config.dismissal_group_size || 20
    const intervalMinutes = config.dismissal_interval_minutes || 1

    // 2. Check/Generate Daily Groups
    const { data: groups, error: groupsError } = await supabase
      .from('daily_groups')
      .select('student_id')
      .eq('date', today)
      .limit(1)

    if (groupsError) throw groupsError

    if (groups.length === 0) {
      console.log(`Generating daily groups for ${today}...`)
      const { data: students, error: studentsError } = await supabase
        .from('students')
        .select('id')

      if (studentsError) throw studentsError

      // Shuffle students
      const shuffled = students.sort(() => Math.random() - 0.5)
      const groupData = shuffled.map((s, index) => ({
        date: today,
        student_id: s.id,
        group_index: Math.floor(index / groupSize)
      }))

      const { error: insertError } = await supabase
        .from('daily_groups')
        .insert(groupData)

      if (insertError) throw insertError
    }

    // 3. Process Sign-outs
    // Get students signed in today but not signed out
    const { data: attendance, error: attendanceError } = await supabase
      .from('attendance')
      .select('student_id, sign_in, sign_out')
      .eq('date', today)
      .not('sign_in', 'is', null)
      .is('sign_out', null)

    if (attendanceError) throw attendanceError

    if (attendance.length === 0) {
      return new Response(JSON.stringify({ message: 'No students to sign out' }), { status: 200 })
    }

    // Get group indices for these students
    const studentIds = attendance.map(a => a.student_id)
    const { data: studentGroups, error: sgError } = await supabase
      .from('daily_groups')
      .select('student_id, group_index')
      .eq('date', today)
      .in('student_id', studentIds)

    if (sgError) throw sgError

    const groupMap = new Map(studentGroups.map(sg => [sg.student_id, sg.group_index]))
    
    // Parse school closing time (HH:mm) into a UTC Date for today
    const [hours, minutes] = schoolClosingTime.split(':').map(Number)
    const baseTime = new Date(Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate(), hours, minutes, 0))

    let signedOutCount = 0
    const timeStr = nowUtc.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })

    for (const record of attendance) {
      const groupIndex = groupMap.get(record.student_id) ?? 0
      const scheduledTime = new Date(baseTime.getTime() + groupIndex * intervalMinutes * 60000)

      if (nowUtc >= scheduledTime) {
        // Sign out
        const { error: updateError } = await supabase
          .from('attendance')
          .update({ sign_out: timeStr })
          .match({ student_id: record.student_id, date: today })

        if (!updateError) signedOutCount++
      }
    }

    return new Response(JSON.stringify({ 
      message: `Processed ${attendance.length} records, signed out ${signedOutCount} students.`,
      time: nowUtc.toISOString()
    }), { status: 200 })

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 })
  }
})
