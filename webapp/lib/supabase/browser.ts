'use client';
import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client (anon/publishable key). Safe to import from
 * Client Components. All access goes through RLS — never include
 * service-role data here. Used for realtime subscriptions on the leads page.
 */
export function getBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      'Supabase browser env missing: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local'
    );
  }
  return createBrowserClient(url, key);
}
