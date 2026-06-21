import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export type AppRole = 'admin' | 'client';

export type AppUser = {
  email: string;
  role: AppRole;
};

/**
 * Returns the signed-in user if they're on the app_users allowlist; null otherwise.
 * Reads role from app_users (preferred) — single source of truth.
 */
export async function getCurrentAppUser(): Promise<AppUser | null> {
  const supabase = await getServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;

  // Allowlist check via service role (cheap, bypasses RLS recursion).
  const svc = getServiceSupabase();
  const { data } = await svc
    .from('app_users')
    .select('email,role')
    .ilike('email', user.email)
    .maybeSingle();
  if (!data) return null;
  return { email: data.email, role: data.role as AppRole };
}

/**
 * Use in page server components and API routes that require a signed-in
 * allowlisted user. Redirects to /login if unauth'd; throws 403 if not allowlisted.
 */
export async function requireAppUser(): Promise<AppUser> {
  const supabase = await getServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const appUser = await getCurrentAppUser();
  if (!appUser) {
    throw new Error(`403 Forbidden: ${user.email} is not on the Capricorn allowlist.`);
  }
  return appUser;
}
