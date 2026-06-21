// Apply a SQL migration to the Capricorn Supabase project via the Management
// API, using SUPABASE_ACCESS_TOKEN + the project ref from the configured URL.
// Targets the project by ref explicitly. Usage:
//   node scripts/apply-migration.mjs ../supabase/migrations/0003_pipeline_runs.sql
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  const out = {};
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const root = loadEnv(join(here, '..', '..', '.env'));
const web = loadEnv(join(here, '..', '.env.local'));
const url = web.NEXT_PUBLIC_SUPABASE_URL || root.NEXT_PUBLIC_SUPABASE_URL || root.SUPABASE_URL;
const ref = url ? url.replace(/^https:\/\//, '').split('.')[0] : null;
const token = root.SUPABASE_ACCESS_TOKEN || web.SUPABASE_ACCESS_TOKEN;

if (!ref || !token) {
  console.error('Need a project URL (for ref) and SUPABASE_ACCESS_TOKEN.');
  process.exit(1);
}
const sqlPath = process.argv[2];
if (!sqlPath) { console.error('Usage: node scripts/apply-migration.mjs <path-to-sql>'); process.exit(1); }
const query = readFileSync(resolve(here, sqlPath), 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query }),
});
const text = await res.text();
if (!res.ok) {
  console.error(`FAILED ${res.status}: ${text.slice(0, 600)}`);
  process.exit(1);
}
console.log(`Applied ${sqlPath} to project ${ref}.`);
console.log('Response:', text.slice(0, 400) || '(empty = success)');
