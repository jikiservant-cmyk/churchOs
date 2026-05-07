'use server';

import { createClient, createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { ChurchEvent, AttendanceLog, AttendanceFlag, AttendanceFlagStatus } from './attendance-types';
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function validateUsherPasskey(churchSlug: string, passkey: string) {
  try {
    console.log('Validating passkey for:', churchSlug);
    const supabase = await createAdminClient();
    
    // 1. Validate church exists and passkey is correct
    const { data, error } = await supabase
      .rpc('validate_usher_passkey', {
        p_church_slug: churchSlug,
        p_passkey: passkey
      });

    if (error) {
      console.error('RPC Error:', error);
      return { success: false, error: `Database error: ${error.message}` };
    }

    const result = Array.isArray(data) ? data[0] : data;
    
    let churchId: string | null = null;
    let churchName: string | null = null;
    let isValid = false;

    if (typeof result === 'object' && result !== null) {
      churchId = result.church_id || result.id;
      churchName = result.church_name || result.name;
      isValid = result.valid === true || !!churchId;
    }

    if (!isValid || !churchId) {
      return { success: false, error: 'Invalid passkey. Please check and try again.' };
    }

    // 2. Create a cryptographically signed JWT for the session
    const token = await new SignJWT({
      church_id: churchId,
      church_name: churchName,
      church_slug: churchSlug,
      role: 'usher'
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(JWT_SECRET);

    const cookieStore = await cookies();
    const cookieName = `usher_session_${churchSlug.toLowerCase()}`;
    
    cookieStore.set(cookieName, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 // 24 hours
    });

    revalidatePath(`/${churchSlug}/usher/dashboard`);
    return { success: true, churchName };

  } catch (error) {
    console.error('CRITICAL: validateUsherPasskey error:', error);
    return { 
      success: false, 
      error: 'An unexpected security or network error occurred' 
    };
  }
}

export async function getUsherSession(churchSlug: string) {
  const cookieStore = await cookies();
  const cookieName = `usher_session_${churchSlug.toLowerCase()}`;
  const token = cookieStore.get(cookieName)?.value;
  
  if (!token) return null;
  
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload as any;
  } catch (e) {
    console.error('Usher session verification failed:', e);
    return null;
  }
}

export async function logoutUsher(churchSlug: string) {
  const cookieStore = await cookies();
  const cookieName = `usher_session_${churchSlug.toLowerCase()}`;
  cookieStore.delete(cookieName);
  return { success: true };
}

export async function createEvent(formData: FormData, churchId: string, churchSlug: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    console.error('CreateEvent: No authenticated user found');
    return { error: 'You must be logged in to create services.' };
  }

  const name = formData.get('name') as string;
  const serviceType = formData.get('service_type') as 'sunday_service' | 'bible_study' | 'prayer_meeting' | 'youth_service';
  const eventDate = formData.get('event_date') as string;
  const startTime = formData.get('start_time') as string;
  const location = formData.get('location') as string;

  console.log('Creating event for church:', churchId, 'by user:', user.id);

  const { error } = await supabase
    .schema('church')
    .from('events')
    .insert({
      church_id: churchId,
      name,
      service_type: serviceType,
      event_date: eventDate,
      start_time: startTime,
      location,
      status: 'upcoming',
      created_by: user.id
    });

  if (error) {
    console.error('Error creating event:', error);
    // If we get an RLS error, it usually manifests as a 42501 or just a generic failure
    return { error: error.message || 'Failed to create event. This might be due to a unique constraint or RLS policy.' };
  }

  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true };
}

export async function updateEventStatus(eventId: string, status: 'upcoming' | 'active' | 'completed', churchSlug: string) {
  try {
    const supabase = await createClient();
    
    // Auto-mark absentees when an event is finalized
    if (status === 'completed') {
      const adminClient = await createAdminClient();
      const { data: event } = await adminClient.schema('church').from('events').select('church_id').eq('id', eventId).single();
      
      if (event) {
        const { data: allMembers } = await adminClient.schema('church').from('members').select('id').eq('church_id', event.church_id).eq('status', 'active');
        const { data: logs } = await adminClient.schema('church').from('attendance_logs').select('member_id').eq('event_id', eventId);
        
        if (allMembers && logs) {
          const attendedIds = new Set(logs.map(l => l.member_id));
          const absentMembers = allMembers.filter(m => !attendedIds.has(m.id));
          
          if (absentMembers.length > 0) {
            const absentLogs = absentMembers.map(m => ({
              event_id: eventId,
              member_id: m.id,
              attendance_status: 'absent'
            }));
            
            // Insert in chunks or just all at once
            await adminClient.schema('church').from('attendance_logs').insert(absentLogs);
          }
        }
      }
    }

    const { error } = await supabase
      .schema('church')
      .from('events')
      .update({ status })
      .eq('id', eventId);

    if (error) return { error: error.message };
    
    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    revalidatePath(`/${churchSlug}/usher/dashboard`);
    return { success: true };
  } catch (error) {
    return { error: 'A network or server error occurred.' };
  }
}

export async function claimAdminAccess(churchId: string, churchSlug: string) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    
    if (!user) return { error: 'Not authenticated' };
    
    const adminSupabase = await createAdminClient();
    const { error } = await adminSupabase.from('admin_profiles').upsert({
      id: user.id,
      tenant_id: churchId,
      email: user.email,
      role: 'pastor',
      full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Admin'
    });

    if (error) return { error: error.message };

    revalidatePath(`/${churchSlug}/admin/attendance`);
    return { success: true };
  } catch (error) {
    return { error: 'Failed to claim access.' };
  }
}

async function checkAuthorization(churchSlug: string, eventId: string) {
  const adminClient = await createAdminClient();
  const { data: event } = await adminClient.schema('church').from('events').select('church_id').eq('id', eventId).single();
  
  if (!event) {
    throw new Error('Event not found.');
  }
  
  // 1. Is there an usher session for this church?
  const usherSession = await getUsherSession(churchSlug);
  if (usherSession && usherSession.church_slug === churchSlug && usherSession.church_id === event.church_id) {
    return { adminClient, allowed: true };
  }

  // 2. Is there a logged-in admin for this church?
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();

  if (user) {
    const { data: profile } = await adminClient.from('admin_profiles').select('tenant_id').eq('id', user.id).maybeSingle();
    if (profile && profile.tenant_id === event.church_id) {
       // Make sure churchSlug matches the tenant (rough check, strictly we check the event's church_id)
       const { data: church } = await adminClient.schema('church').from('churches').select('slug').eq('id', event.church_id).maybeSingle();
       if (church && church.slug === churchSlug) {
         return { adminClient, allowed: true };
       }
    }
  }

  throw new Error('Unauthorized to modify this event.');
}

export async function markAttendance(churchSlug: string, eventId: string, memberId: string, status: 'present' | 'late' | 'absent' | 'excused' = 'present') {
  try {
    const { adminClient: supabase } = await checkAuthorization(churchSlug, eventId);
    
    // 1. Get the church_id from the event first
    const { data: eventData, error: eventError } = await supabase
      .schema('church')
      .from('events')
      .select('church_id')
      .eq('id', eventId)
      .single();

    if (eventError || !eventData) {
      throw new Error('Could not find event details.');
    }

    // 2. Direct upsert into attendance_logs using Admin Client (bypasses RLS)
    const { error } = await supabase
      .schema('church')
      .from('attendance_logs')
      .upsert({
        church_id: eventData.church_id,
        member_id: memberId,
        event_id: eventId,
        attendance_status: status,
        check_in_time: new Date().toISOString()
        // recorded_by omitted to avoid FK constraint issues with non-user ushers
      }, { onConflict: 'member_id,event_id' });

    if (error) {
      console.error('[markAttendance] Upsert Error:', error);
      return { error: `Database error: ${error.message}` };
    }

    // 3. Update the attendance count using the RPC which is multi-tenant safe
    // Explicitly call from the 'church' schema if that's where it is
    await supabase.schema('church').rpc('increment_event_attendance', { p_event_id: eventId });

    revalidatePath(`/${churchSlug}/usher/dashboard`);
    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    return { success: true };
  } catch (error: any) {
    console.error('[markAttendance] Exception:', error);
    return { error: error.message || 'Failed to record check-in.' };
  }
}

export async function removeAttendance(churchSlug: string, eventId: string, memberId: string) {
  try {
    const { adminClient: supabase } = await checkAuthorization(churchSlug, eventId);
    
    // 1. Get event data to verify tenant scope
    const { data: eventData } = await supabase
      .schema('church')
      .from('events')
      .select('church_id')
      .eq('id', eventId)
      .single();

    if (!eventData) throw new Error('Event not found');

    // 2. Direct delete from attendance_logs using Admin Client (bypasses RLS)
    // We include church_id for extra safety in multi-tenant environment
    const { error } = await supabase
      .schema('church')
      .from('attendance_logs')
      .delete()
      .match({ 
        member_id: memberId, 
        event_id: eventId,
        church_id: eventData.church_id 
      });

    if (error) {
      console.error('[removeAttendance] Delete Error:', error);
      return { error: `Database error: ${error.message}` };
    }

    // 3. Update the attendance count using the RPC
    await supabase.schema('church').rpc('decrement_event_attendance', { p_event_id: eventId });

    revalidatePath(`/${churchSlug}/usher/dashboard`);
    revalidatePath(`/${churchSlug}/admin/attendance`);
    revalidatePath(`/${churchSlug}/admin/attendance/${eventId}`);
    
    return { success: true };
  } catch (error: any) {
    console.error('[removeAttendance] Exception:', error);
    return { error: error.message || 'Failed to remove check-in.' };
  }
}

export async function runInactivityDetection(churchId: string, churchSlug: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('church')
    .rpc('refresh_inactive_30_days', { p_church_id: churchId });

  if (error) return { error: error.message };
  
  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true, count: data };
}

export async function getAttendanceFlags(churchId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('church')
    .from('attendance_flags')
    .select(`
      *,
      members:member_id (
        full_name,
        phone_number
      )
    `)
    .eq('church_id', churchId)
    .in('status', ['open', 'followed_up'])
    .order('created_at', { ascending: false });

  if (error) return { error: error.message };
  return { data };
}

export async function updateAttendanceFlagStatus(flagId: string, status: AttendanceFlagStatus, churchSlug: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .schema('church')
    .from('attendance_flags')
    .update({ status })
    .eq('id', flagId);

  if (error) return { error: error.message };
  
  revalidatePath(`/${churchSlug}/admin/attendance`);
  return { success: true };
}

export async function sendMissedYouMessages(churchId: string, churchSlug: string, eventId?: string) {
  try {
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    
    if (!session) {
      return { error: 'Not authenticated' };
    }

    // Sync the 3 consecutive Sundays missed flags by calling the deployed edge function
    try {
      await supabase.functions.invoke('sync_missed_3_sundays_flags', {
        method: 'POST'
      });
    } catch (e) {
      console.error('Failed to invoke edge function:', e);
    }

    const memberIdsToMessage = new Set<string>();
    
    // Fetch members who were absent for the event (if eventId is provided)
    if (eventId) {
      const { data: absentLogs, error: absentError } = await supabase
        .schema('church')
        .from('attendance_logs')
        .select('member_id')
        .eq('event_id', eventId)
        .eq('attendance_status', 'absent');

      if (absentError) return { error: absentError.message };
      if (absentLogs) {
        absentLogs.forEach(log => memberIdsToMessage.add(log.member_id));
      }
    }

    // Fetch members who have an active 'missed_3_sundays' flag
    const { data: openFlags, error: flagsError } = await supabase
      .schema('church')
      .from('attendance_flags')
      .select('id, member_id')
      .eq('church_id', churchId)
      .eq('flag_type', 'missed_3_sundays')
      .eq('status', 'open');

    if (flagsError) return { error: flagsError.message };

    // Add flagged members
    const flagsByMemberId = new Map<string, string>(); // member_id -> flag_id
    if (openFlags) {
      openFlags.forEach(flag => {
        memberIdsToMessage.add(flag.member_id);
        flagsByMemberId.set(flag.member_id, flag.id);
      });
    }

    if (memberIdsToMessage.size === 0) {
      return { success: true, count: 0 };
    }

    const memberIds = Array.from(memberIdsToMessage);

    // Fetch the actual members to get phone_number and full_name
    const { data: members, error: membersError } = await supabase
      .schema('church')
      .from('members')
      .select('id, full_name, phone_number')
      .in('id', memberIds);

    if (membersError) return { error: membersError.message };
    if (!members || members.length === 0) return { success: true, count: 0 };

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const cookieStore = await cookies();
    const cookieHeader = cookieStore.getAll().map(c => `${c.name}=${c.value}`).join('; ');

    let sentCount = 0;

    for (const member of members) {
      if (!member.phone_number) continue;

      const firstName = member.full_name.split(' ')[0] || 'there';
      const message = `Hello ${firstName}! we missed you  at church today. We pray you are well and hope to see you again next time. Blessings from your church family.`;
      
      try {
        const res = await fetch(`${appUrl}/api/sms/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': cookieHeader
          },
          body: JSON.stringify({ 
            phoneNumber: member.phone_number, 
            message, 
            churchId 
          })
        });

        if (res.ok) {
          sentCount++;
          // Close the flag if they had one
          const flagId = flagsByMemberId.get(member.id);
          if (flagId) {
            await supabase
              .schema('church')
              .from('attendance_flags')
              .update({ status: 'followed_up' })
              .eq('id', flagId);
          }
        } else {
          console.error(`Failed to send SMS to ${member.phone_number}:`, await res.text());
        }
      } catch (err) {
        console.error(`Failed to invoke SMS API for ${member.phone_number}:`, err);
      }
    }

    return { success: true, count: sentCount };
  } catch (error) {
    console.error('sendMissedYouMessages Error:', error);
    return { error: 'Failed to send messages.' };
  }
}
