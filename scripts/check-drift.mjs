// Drift check: is the database still a faithful copy of the repository?
//
// data/*.json in GitHub is the single source of truth. Each guide's payload
// (supabase/payloads/<code>.json) carries the source hash of its data file;
// the current version of that guide in Supabase must carry the same hash.
// A mismatch means either a merged change was not imported yet, or someone
// edited the database directly.
//
// Usage:
//   node scripts/check-drift.mjs          # query Supabase (SUPABASE_URL + SUPABASE_ANON_KEY
//                                          # or SUPABASE_SERVICE_ROLE_KEY in .env)
//   node scripts/check-drift.mjs --sql    # print an SQL query that does the same check,
//                                          # for the SQL editor or the daily routine
//
// Exits 1 when any guide has drifted.
import dotenv from 'dotenv';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ quiet: true });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, 'supabase', 'payloads');

const expected = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const p = JSON.parse(readFileSync(path.join(dir, f), 'utf-8'));
    return { code: p.guide.code, hash: p.version.source_hash };
  });

if (process.argv.includes('--sql')) {
  const values = expected.map((e) => `('${e.code}', '${e.hash}')`).join(',\n       ');
  console.log(`-- Rows returned = guides whose database copy differs from the repository.
select e.code,
       case when gv.id is null then 'missing in database' else 'different source_hash' end as problem,
       e.hash as repo_hash, gv.source_hash as db_hash
  from (values ${values}) as e(code, hash)
  left join guides g on g.code = e.code
  left join guide_versions gv on gv.guide_id = g.id and gv.is_current
 where gv.source_hash is distinct from e.hash;`);
  process.exit(0);
}

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const key = SUPABASE_ANON_KEY ?? SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !key) {
  console.error('Missing SUPABASE_URL and a key (SUPABASE_ANON_KEY is enough). Or use --sql.');
  process.exit(2);
}
const sb = createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
const { data, error } = await sb
  .from('guide_versions')
  .select('source_hash, guides!inner(code)')
  .eq('is_current', true);
if (error) {
  console.error(`Query failed: ${error.message}`);
  process.exit(2);
}
const current = new Map(data.map((r) => [r.guides.code, r.source_hash]));

let drift = 0;
for (const e of expected) {
  const db = current.get(e.code);
  const ok = db === e.hash;
  if (!ok) drift++;
  console.log(`${ok ? '✓' : '✗'} ${e.code}: ${ok ? 'مطابق' : db ? 'مختلف عن المستودع' : 'غير موجود في القاعدة'}`);
}
console.log(drift ? `\n${drift} دليل غير مطابق للمستودع.` : '\nكل الأدلة في القاعدة مطابقة للمستودع.');
process.exit(drift ? 1 : 0);
