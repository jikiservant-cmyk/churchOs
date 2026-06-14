// lib/db/members.ts
// Paginated, cached member queries.
//
// Replace any direct .from('members').select('*') calls in your components/routes
// with these functions. They handle pagination, column selection, and caching.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getCached, setCached, invalidateCache, cacheKeys } from '../cache';

export const PAGE_SIZE = 50;

export interface Member {
  id:           string;
  church_id:    string;
  full_name:    string;
  phone_number: string | null;
  email:        string | null;
  gender:       string | null;
  birthday:     string | null;
  is_youth:     boolean;
  status:       string;
  created_at:   string;
  updated_at:   string;
}

export interface PagedResult<T> {
  data:     T[];
  total:    number;
  page:     number;
  pageSize: number;
  hasMore:  boolean;
}

/**
 * Fetch a paginated list of members for a church.
 * Results are cached for 60s. Pass a search string to skip the cache.
 */
export async function getMembers(
  supabase: SupabaseClient,
  churchId: string,
  page    = 0,
  search?: string
): Promise<PagedResult<Member>> {
  const cacheKey = cacheKeys.members(churchId, page);

  // Serve from cache on non-search requests
  if (!search) {
    const cached = await getCached<PagedResult<Member>>(cacheKey);
    if (cached) return cached;
  }

  const from = page * PAGE_SIZE;
  const to   = from + PAGE_SIZE - 1;

  // FIX: Never SELECT * — only fetch the columns you actually render.
  // This reduces payload size significantly on large churches.
  let query = supabase
    .from('members')
    .select(
      'id, church_id, full_name, phone_number, email, gender, birthday, is_youth, status, created_at, updated_at',
      { count: 'exact' }
    )
    .eq('church_id', churchId)
    .order('full_name', { ascending: true })
    .range(from, to);

  if (search?.trim()) {
    query = query.ilike('full_name', `%${search.trim()}%`);
  }

  const { data, count, error } = await query;

  if (error) {
    console.error('[db/members] getMembers error:', error);
    throw new Error(error.message);
  }

  const result: PagedResult<Member> = {
    data:     (data ?? []) as Member[],
    total:    count ?? 0,
    page,
    pageSize: PAGE_SIZE,
    hasMore:  from + PAGE_SIZE < (count ?? 0),
  };

  if (!search) {
    await setCached(cacheKey, result, 60);
  }

  return result;
}

/**
 * Add a new member and bust the church's member caches.
 */
export async function addMember(
  supabase: SupabaseClient,
  churchId: string,
  member: Omit<Member, 'id' | 'church_id' | 'created_at' | 'updated_at'>
) {
  const { data, error } = await supabase
    .from('members')
    .insert({ ...member, church_id: churchId })
    .select('id, full_name, status')
    .single();

  if (error) throw new Error(error.message);

  await invalidateCache(
    cacheKeys.members(churchId, 0),
    cacheKeys.memberCount(churchId),
    cacheKeys.dashboardStats(churchId)
  );

  return data;
}

/**
 * Update a member and bust relevant caches.
 */
export async function updateMember(
  supabase: SupabaseClient,
  memberId: string,
  churchId: string,
  updates: Partial<Omit<Member, 'id' | 'church_id' | 'created_at'>>
) {
  const { data, error } = await supabase
    .from('members')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', memberId)
    .eq('church_id', churchId)
    .select('id, full_name, status')
    .single();

  if (error) throw new Error(error.message);

  await invalidateCache(
    cacheKeys.members(churchId, 0),
    cacheKeys.memberCount(churchId)
  );

  return data;
}

/**
 * Delete a member and bust relevant caches.
 */
export async function deleteMember(
  supabase: SupabaseClient,
  memberId: string,
  churchId: string
) {
  const { error } = await supabase
    .from('members')
    .delete()
    .eq('id', memberId)
    .eq('church_id', churchId);

  if (error) throw new Error(error.message);

  await invalidateCache(
    cacheKeys.members(churchId, 0),
    cacheKeys.memberCount(churchId),
    cacheKeys.dashboardStats(churchId)
  );
}
