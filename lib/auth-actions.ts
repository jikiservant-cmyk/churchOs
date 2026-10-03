'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient, createAdminClient } from '@/lib/supabase/server';
import { getClientIp, rateLimit } from '@/lib/security';
import { denominationsEnabled, firstRow, type LoginContext } from '@/lib/denominations';

export type AuthState = {
  error?: string;
  success?: boolean;
  redirectTo?: string;
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const GENERIC_LOGIN_ERROR = 'Invalid email or password.';

function isRedirect(err: unknown): boolean {
  const e = err as { message?: string; digest?: string } | null;
  return e?.message === 'NEXT_REDIRECT' || (typeof e?.digest === 'string' && e.digest.startsWith('NEXT_REDIRECT'));
}

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'Email and password are required' };
  if (email.length > 320 || password.length > MAX_PASSWORD) return { error: GENERIC_LOGIN_ERROR };

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Sign-in is temporarily unavailable.' };
  }

  // Credential-stuffing protection: per (IP, email) and per IP.
  const ip = getClientIp(await headers());
  if (!(await rateLimit(`login:${ip}:${email}`, 8, 15 * 60)) || !(await rateLimit(`login-ip:${ip}`, 40, 15 * 60))) {
    return { error: 'Too many attempts. Please wait a few minutes and try again.' };
  }

  let targetSlug: string | null = null;
  let overseer = false;
  try {
    const supabase = await createClient();
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError || !authData.user) {
      return { error: /email not confirmed/i.test(authError?.message ?? '') ? 'Please confirm your email first.' : GENERIC_LOGIN_ERROR };
    }

    // Overseers (denomination accounts) have no church workspace; route them by DB context.
    if (denominationsEnabled()) {
      const { data: ctxData, error: ctxError } = await supabase.rpc('my_login_context');
      if (ctxError) console.error('[auth] my_login_context failed:', ctxError.code, ctxError.message);
      overseer = firstRow<LoginContext>(ctxData)?.account_type === 'overseer';
    }

    // The profile is looked up by the authenticated user id ONLY (no email fallback).
    const { data: profile } = await supabase
      .from('admin_profiles')
      .select('role, tenant_id')
      .eq('id', authData.user.id)
      .maybeSingle();

    if (overseer) return redirect('/overseer');

    if (!profile?.tenant_id || String(profile.role).toLowerCase() !== 'pastor') {
      await supabase.auth.signOut();
      return { error: 'This account does not have admin access.' };
    }

    // The redirect slug comes from the database, never from the form.
    const admin = await createAdminClient();
    const { data: church } = await admin.schema('church').from('churches').select('slug').eq('id', profile.tenant_id).maybeSingle();
    if (!church?.slug) {
      await supabase.auth.signOut();
      return { error: 'Your church workspace could not be found. Please contact support.' };
    }
    targetSlug = church.slug;
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error('[auth] login failed:', (err as Error).message);
    return { error: 'An unexpected error occurred. Please try again.' };
  }

  redirect(`/${targetSlug}/admin`);
}

export async function signup(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'Email and password are required' };
  if (!EMAIL_RE.test(email)) return { error: 'Please enter a valid email address.' };
  if (password.length < MIN_PASSWORD) return { error: `Password must be at least ${MIN_PASSWORD} characters.` };
  if (password.length > MAX_PASSWORD) return { error: 'Password is too long.' };

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return { error: 'Sign-up is temporarily unavailable.' };
  }

  const ip = getClientIp(await headers());
  if (!(await rateLimit(`signup-ip:${ip}`, 10, 60 * 60))) {
    return { error: 'Too many sign-up attempts. Please try again later.' };
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error || !data.user) {
      console.error('[auth] signup rejected:', error?.status, error?.code);
      return { error: 'Could not create the account. If you already have one, please log in.' };
    }
    return { success: true, redirectTo: '/signup/provision' };
  } catch (err) {
    if (isRedirect(err)) throw err;
    console.error('[auth] signup failed:', (err as Error).message);
    return { error: 'An unexpected error occurred. Please try again later.' };
  }
}

export async function logout(_formData?: FormData) {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect('/');
}
