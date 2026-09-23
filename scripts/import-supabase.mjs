// Import guides into the edu-guides-hub Supabase schema
// (guides → guide_versions → sections → content_blocks).
//
// Usage:
//   node scripts/import-supabase.mjs [guide-code ...] [--file path] [--force] [--dry-run] [--out dir]
//
//   guide-code  one or more of the codes in scripts/guides/index.mjs (default: all)
//   --file      source file to read instead of the adapter's default (one guide only),
//               e.g. procedures_manual --file procedures-db.json
//   --force     re-import even if this exact source was imported before
//   --dry-run   build and check the payloads without touching the database
//   --out dir   also write each payload to <dir>/<code>.json
//
// Each guide is sent as one payload to public.import_guide(), which imports it
// in a single transaction. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in
// .env (see .env.example) unless --dry-run.
import dotenv from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { guides } from './guides/index.mjs';
import { summarize } from './guides/payload.mjs';

dotenv.config({ quiet: true });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const opts = { codes: [], file: null, force: false, dryRun: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.codes.push(a);
  }
  return opts;
}

function selectGuides(codes, file) {
  const known = new Map(guides.map((g) => [g.code, g]));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new Error(`unknown guide ${unknown.join(', ')}; available: ${[...known.keys()].join(', ')}`);
  }
  const selected = codes.length ? codes.map((c) => known.get(c)) : guides;
  if (file && selected.length !== 1) throw new Error('--file needs exactly one guide code');
  return selected;
}

function checkExpected(payload, summary) {
  const { expected = {} } = payload;
  const got = { level1: summary.byLevel[1] ?? 0, level2: summary.byLevel[2] ?? 0 };
  const bad = Object.keys(expected).filter((k) => expected[k] !== got[k]);
  const detail = Object.keys(expected).map((k) => `${k} ${got[k]}/${expected[k]}`).join(', ');
  console.log(`  ${detail} → ${bad.length ? 'MISMATCH' : 'OK'}`);
  return bad.length === 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const selected = selectGuides(opts.codes, opts.file);

  const payloads = [];
  let ok = true;
  for (const adapter of selected) {
    const file = path.resolve(opts.file ?? path.join(root, adapter.source));
    const payload = adapter.build(readFileSync(file), file);
    const summary = summarize(payload);
    console.log(`\n${adapter.code}: ${path.relative(process.cwd(), file)}`);
    console.log(`  hash ${payload.version.source_hash}`);
    console.log(`  ${summary.sections} sections, ${summary.blocks} blocks`, summary.byType);
    ok = checkExpected(payload, summary) && ok;
    if (opts.out) {
      mkdirSync(opts.out, { recursive: true });
      const outFile = path.join(opts.out, `${adapter.code}.json`);
      writeFileSync(outFile, JSON.stringify(payload) + '\n');
      console.log(`  wrote ${path.relative(process.cwd(), outFile)}`);
    }
    payloads.push({ payload, summary });
  }
  if (!ok) {
    console.error('\nCount check failed; nothing imported.');
    process.exit(1);
  }
  if (opts.dryRun) {
    console.log('\n--dry-run: nothing written to the database.');
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in.');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  console.log('\nImport');
  for (const { payload, summary } of payloads) {
    const { data, error } = await sb.rpc('import_guide', { payload, force: opts.force });
    if (error) throw new Error(`${payload.guide.code}: ${error.message}`);
    if (data.status === 'skipped') {
      console.log(`  ${data.guide}: already imported (version ${data.version_id}); use --force to re-import`);
      continue;
    }
    const match = data.blocks === summary.blocks && data.sections === summary.sections;
    console.log(`  ${data.guide}: ${data.sections} sections, ${data.blocks} blocks → ${match ? 'OK' : 'MISMATCH'}`);
    if (!match) process.exitCode = 1;
  }

  await demo(sb);
}

async function demo(sb) {
  const term = 'الخطة التشغيلية';
  const { data, error } = await sb.rpc('search_guides', { q: term, max_results: 5 });
  if (error) throw new Error(`search_guides: ${error.message}`);
  console.log(`\nSample search "${term}" across all guides:`);
  for (const r of data) console.log(`  [${r.guide_code}/${r.block_type}] ${r.text_content.slice(0, 60)}\n    → ${r.citation}`);
  console.log(`
  Same search in the SQL editor:
    select guide_code, block_type, left(text_content, 60), citation
      from search_guides('${term}');          -- all guides
    select * from search_guides('مهام', 'org_manual', 10);   -- one guide`);
}

main().catch((err) => {
  console.error(`\nImport failed: ${err.message}`);
  process.exit(1);
});
