// One-off: create (or reset) an allowlisted admin login in the Capricorn
// Supabase project, using the service-role key from webapp/.env.local.
// Usage: node scripts/create-admin.mjs <email> <password> [role]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const out = {};
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = loadEnv(join(here, '..', '.env.local'));
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in webapp/.env.local');
  process.exit(1);
}

const email = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';
const role = (process.argv[4] || 'admin').trim();
if (!email || !password) {
  console.error('Usage: node scripts/create-admin.mjs <email> <password> [role]');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function findUserByEmail(em) {
  // Paginate the admin user list and match by email (no direct get-by-email API).
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = (data?.users || []).find((u) => (u.email || '').toLowerCase() === em);
    if (hit) return hit;
    if (!data || data.users.length < 200) break;
  }
  return null;
}

const main = async () => {
  let userId;
  const created = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) {
    // Most likely already exists -> find and reset the password.
    const existing = await findUserByEmail(email);
    if (!existing) throw created.error;
    const upd = await sb.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (upd.error) throw upd.error;
    userId = existing.id;
    console.log('Existing auth user updated (password reset).');
  } else {
    userId = created.data.user.id;
    console.log('New auth user created.');
  }

  // Ensure the email is on the allowlist with the given role.
  const allow = await sb.from('app_users').upsert(
    { email, role },
    { onConflict: 'email' }
  );
  if (allow.error) throw allow.error;

  console.log('Allowlisted in app_users as role:', role);
  console.log('DONE');
  console.log('LOGIN_EMAIL=' + email);
  console.log('USER_ID=' + userId);
};

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
