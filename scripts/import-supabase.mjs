// Import the procedures guide into the edu-guides-hub Supabase schema
// (guides → guide_versions → sections → content_blocks).
//
// Usage:
//   node scripts/import-supabase.mjs [source.json] [--force] [--dry-run]
//
// Accepts either the grouped export (procedures-db.json, with groups[]) or the
// flat data/procedures.json used by the MCP connector (the default).
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ quiet: true });

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const GUIDE = {
  code: 'procedures_manual',
  name_ar: 'دليل إجراءات العمل بمدارس التعليم العام',
  short_name: 'دليل الإجراءات',
  guide_type: 'procedures',
};
const VERSION_LABEL = '1446-1447هـ';
const EXPECTED_GROUPS = 18;
const EXPECTED_PROCEDURES = 60;
const CHUNK = 500;

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const sourcePath = path.resolve(
  args.find((a) => !a.startsWith('--')) ?? path.join(root, 'data', 'procedures.json')
);

// ---------------------------------------------------------------------------
// Source normalisation: both input shapes become { meta, groups[] }.
// ---------------------------------------------------------------------------

const compareCodes = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const clean = (s) => (typeof s === 'string' ? s.trim() : '');

function normalizeProcedure(p) {
  return {
    code: p.code,
    ref_code: p.procedure_ref_code ?? p.ref ?? p.code,
    name: p.procedure_name ?? p.name,
    page: p.page ?? p.page_start ?? null,
    page_start: p.page_start ?? p.page ?? null,
    page_end: p.page_end ?? null,
    owner: p.owner ?? null,
    objective: p.objective ?? null,
    scope: p.scope ?? null,
    issue_date: p.issue_date ?? null,
    kpis: p.kpis ?? [],
    policies: p.policies ?? [],
    inputs: p.inputs ?? [],
    outputs: p.outputs ?? [],
    systems: p.systems ?? [],
    forms: p.forms ?? [],
    raci: p.raci ?? [],
    related: p.related_procedures ?? p.related ?? {},
    steps: (p.steps ?? []).map((s, i) => ({
      seq: toInt(s.seq) ?? i + 1,
      printed_seq: s.printed_seq ?? null,
      task: s.task ?? s.heading,
      detail_bullets: s.detail_bullets ?? s.bullets ?? [],
      responsible: s.responsible ?? null,
      system: s.system ?? null,
      form_or_doc: s.form_or_doc ?? null,
    })),
  };
}

function loadSource(file) {
  const raw = readFileSync(file);
  const data = JSON.parse(raw.toString('utf-8'));
  const meta = {
    source_file: data.source_file ?? path.basename(file),
    source_hash: data.source_hash ?? createHash('sha256').update(raw).digest('hex'),
    total_pages: data.total_pages ?? null,
    expected_groups: data.group_count ?? EXPECTED_GROUPS,
    expected_procedures: data.procedure_count ?? data.total ?? EXPECTED_PROCEDURES,
  };

  let groups;
  if (Array.isArray(data.groups)) {
    groups = data.groups.map((g) => ({
      code: g.code,
      name: g.name,
      page_start: g.page_start ?? g.page ?? null,
      page_end: g.page_end ?? null,
      procedures: (g.procedures ?? []).map(normalizeProcedure),
    }));
  } else if (Array.isArray(data.procedures)) {
    // Flat shape: rebuild groups from the procedure code (1.1.1 → group 1.1).
    const byCode = new Map();
    for (const p of data.procedures) {
      const code = p.code.split('.').slice(0, 2).join('.');
      if (!byCode.has(code)) byCode.set(code, { code, name: p.group, procedures: [] });
      byCode.get(code).procedures.push(normalizeProcedure(p));
    }
    groups = [...byCode.values()].map((g) => ({
      ...g,
      page_start: Math.min(...g.procedures.map((p) => p.page_start ?? Infinity)),
      page_end: Math.max(...g.procedures.map((p) => p.page_end ?? -Infinity)),
    }));
  } else {
    throw new Error(`${file}: expected a "groups" or "procedures" array`);
  }

  groups.sort((a, b) => compareCodes(a.code, b.code));
  for (const g of groups) g.procedures.sort((a, b) => compareCodes(a.code, b.code));
  resolveRelated(groups.flatMap((g) => g.procedures));
  return { meta, groups };
}

// Related procedures are listed by name ("إجراء ..."). Link the ones that are
// in this guide to their reference code; the rest belong to other levels
// (e.g. the education department) and keep ref_code null.
const RELATIONS = ['previous', 'implicit', 'next'];
const nameKey = (s) => clean(s).replace(/^إجراء\s*/, '').replace(/\s+/g, ' ');

function resolveRelated(procedures) {
  const refByName = new Map(procedures.map((p) => [nameKey(p.name), p.ref_code]));
  for (const p of procedures) {
    p.related = RELATIONS.flatMap((relation) =>
      (p.related[relation] ?? []).map((name) => ({
        relation,
        name: clean(name),
        ref_code: refByName.get(nameKey(name)) ?? null,
      }))
    );
  }
}

// Brief: version_label is 1446-1447هـ; the date comes from the Gregorian part
// of the first procedure's issue_date ("رجب، 1446 هـ الموافق Jan,2025").
function parseIssueDate(text) {
  const m = /([A-Za-z]{3})[a-z]*\s*,?\s*(\d{4})/.exec(text ?? '');
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mi = months.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : `${m[2]}-${String(mi + 1).padStart(2, '0')}-01`;
}

function buildBlocks(proc, sectionId) {
  const page = proc.page;
  const blocks = [];
  const add = (block_type, seq, text, metadata = {}) => {
    const text_content = clean(text);
    if (text_content) blocks.push({ section_id: sectionId, block_type, seq, text_content, page, metadata });
  };

  for (const s of proc.steps) {
    add('step', s.seq, s.task, {
      printed_seq: s.printed_seq,
      responsible: s.responsible,
      system: s.system,
      form_or_doc: s.form_or_doc,
      detail_bullets: s.detail_bullets,
    });
  }
  proc.raci.forEach((r, i) => add('raci', toInt(r.seq) ?? i + 1, r.task, { roles: r.roles ?? {} }));
  proc.policies.forEach((t, i) => add('policy', i + 1, t));
  proc.inputs.forEach((t, i) => add('input', i + 1, t));
  proc.outputs.forEach((t, i) => add('output', i + 1, t));
  proc.forms.forEach((t, i) => add('form', i + 1, t));
  proc.kpis.forEach((k, i) =>
    add('kpi', toInt(k.seq) ?? i + 1, k.name, { code: k.code, formula: k.formula, unit: k.unit })
  );
  proc.systems.forEach((s, i) => add('system', i + 1, s.system, { description: s.description }));
  proc.related.forEach((r, i) =>
    add('note', i + 1, r.name, { kind: 'related_procedure', relation: r.relation, ref_code: r.ref_code })
  );
  return blocks;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

function must({ data, error, count }, what) {
  if (error) throw new Error(`${what}: ${error.message}${error.details ? ` (${error.details})` : ''}`);
  return count ?? data;
}

async function insertChunked(sb, table, rows, select) {
  const out = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    let q = sb.from(table).insert(rows.slice(i, i + CHUNK));
    if (select) q = q.select(select);
    const data = must(await q, `insert ${table}`);
    if (select) out.push(...data);
  }
  return out;
}

async function countRows(sb, versionId) {
  const sections = must(
    await sb.from('sections').select('id', { count: 'exact', head: true }).eq('guide_version_id', versionId),
    'count sections'
  );
  const groups = must(
    await sb
      .from('sections')
      .select('id', { count: 'exact', head: true })
      .eq('guide_version_id', versionId)
      .eq('level', 1),
    'count groups'
  );
  const blocks = must(
    await sb
      .from('content_blocks')
      .select('id, sections!inner(guide_version_id)', { count: 'exact', head: true })
      .eq('sections.guide_version_id', versionId),
    'count content_blocks'
  );
  return { sections, groups, procedures: sections - groups, blocks };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function main() {
  const { meta, groups } = loadSource(sourcePath);
  const procedures = groups.flatMap((g) => g.procedures);
  const issueDate = parseIssueDate(procedures[0]?.issue_date);
  const plannedBlocks = procedures.reduce((n, p) => n + buildBlocks(p, null).length, 0);

  console.log(`Source: ${path.relative(process.cwd(), sourcePath)}`);
  console.log(`  hash ${meta.source_hash}`);
  console.log(
    `  ${groups.length} groups, ${procedures.length} procedures, ${plannedBlocks} content blocks, issue_date ${issueDate}`
  );

  if (dryRun) {
    const byType = {};
    for (const p of procedures) for (const b of buildBlocks(p, null)) byType[b.block_type] = (byType[b.block_type] ?? 0) + 1;
    console.log('  blocks by type:', byType);
    checkCounts(meta, groups.length, procedures.length);
    console.log('\n--dry-run: nothing written.');
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in.');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1. Guide (upsert on its unique code).
  const [guide] = must(
    await sb.from('guides').upsert(GUIDE, { onConflict: 'code' }).select('id'),
    'upsert guide'
  );

  // 2. Idempotency: same source_hash → skip unless --force.
  const existing = must(
    await sb.from('guide_versions').select('id, version_label, source_hash').eq('guide_id', guide.id),
    'look up versions'
  ).filter((v) => v.source_hash === meta.source_hash || v.version_label === VERSION_LABEL);
  const sameHash = existing.find((v) => v.source_hash === meta.source_hash);
  if (sameHash && !force) {
    console.log(`\nAlready imported as version ${sameHash.id} (${sameHash.version_label}). Use --force to re-import.`);
    await report(sb, meta, sameHash.id);
    return;
  }
  // Replacing: drop the old version(s); sections and blocks go with it (ON DELETE CASCADE).
  if (existing.length) {
    must(
      await sb.from('guide_versions').delete().in('id', existing.map((v) => v.id)),
      'delete old version'
    );
    console.log(`Removed ${existing.length} earlier version(s) with the same hash or label.`);
  }

  // 3. New version, marked current only after everything is in.
  const [version] = must(
    await sb
      .from('guide_versions')
      .insert({
        guide_id: guide.id,
        version_label: VERSION_LABEL,
        issue_date: issueDate,
        source_file: meta.source_file,
        source_hash: meta.source_hash,
        total_pages: meta.total_pages,
        is_current: false,
      })
      .select('id'),
    'insert guide_version'
  );

  try {
    // 4. Groups (level 1).
    const groupRows = await insertChunked(
      sb,
      'sections',
      groups.map((g, i) => ({
        guide_version_id: version.id,
        parent_id: null,
        code: g.code,
        title: g.name,
        level: 1,
        order_index: i,
        page_start: g.page_start,
        page_end: g.page_end,
      })),
      'id, code'
    );
    const groupId = new Map(groupRows.map((r) => [r.code, r.id]));

    // 5. Procedures (level 2) under their group.
    const procRows = await insertChunked(
      sb,
      'sections',
      groups.flatMap((g) =>
        g.procedures.map((p, i) => ({
          guide_version_id: version.id,
          parent_id: groupId.get(g.code),
          code: p.ref_code,
          title: p.name,
          level: 2,
          order_index: i,
          page_start: p.page_start,
          page_end: p.page_end,
          owner_role: p.owner,
          objective: p.objective,
          scope: p.scope,
        }))
      ),
      'id, code'
    );
    const procId = new Map(procRows.map((r) => [r.code, r.id]));
    if (procId.size !== procedures.length) throw new Error('procedure reference codes are not unique');

    // 6. Content blocks.
    const blocks = procedures.flatMap((p) => buildBlocks(p, procId.get(p.ref_code)));
    await insertChunked(sb, 'content_blocks', blocks);

    // 7. Make this the current version.
    must(
      await sb.from('guide_versions').update({ is_current: false }).eq('guide_id', guide.id).neq('id', version.id),
      'unset old current'
    );
    must(await sb.from('guide_versions').update({ is_current: true }).eq('id', version.id), 'set current');
  } catch (err) {
    // Roll back the partial import so the next run starts clean.
    await sb.from('guide_versions').delete().eq('id', version.id);
    throw err;
  }

  console.log(`\nImported version ${version.id}.`);
  await report(sb, meta, version.id, plannedBlocks);
}

function checkCounts(meta, groups, procedures) {
  const ok = groups === meta.expected_groups && procedures === meta.expected_procedures;
  console.log(
    `  groups ${groups}/${meta.expected_groups}, procedures ${procedures}/${meta.expected_procedures} → ${ok ? 'OK' : 'MISMATCH'}`
  );
  if (!ok) process.exitCode = 1;
}

async function report(sb, meta, versionId, plannedBlocks) {
  const guides = must(await sb.from('guides').select('id', { count: 'exact', head: true }), 'count guides');
  const c = await countRows(sb, versionId);

  console.log('\nReport');
  console.log(`  guides:         ${guides}`);
  console.log(`  sections:       ${c.sections} (${c.groups} groups + ${c.procedures} procedures)`);
  console.log(`  content_blocks: ${c.blocks}${plannedBlocks != null ? ` (expected ${plannedBlocks})` : ''}`);
  checkCounts(meta, c.groups, c.procedures);
  if (plannedBlocks != null && plannedBlocks !== c.blocks) {
    console.log('  content_blocks count MISMATCH');
    process.exitCode = 1;
  }

  await demo(sb, versionId);
}

async function demo(sb, versionId) {
  console.log('\nSample queries');

  const term = 'التشغيلية';
  const sections = must(
    await sb
      .from('sections')
      .select('code, title, page_start')
      .eq('guide_version_id', versionId)
      .textSearch('search_vector', term, { config: 'simple', type: 'plain' })
      .limit(3),
    'search sections'
  );
  console.log(`  sections matching "${term}":`);
  for (const s of sections) console.log(`    ${s.code}  ${s.title}  (ص ${s.page_start})`);

  const blocks = must(
    await sb
      .from('content_blocks')
      .select('id, block_type, text_content, sections!inner(code, title, guide_version_id)')
      .eq('sections.guide_version_id', versionId)
      .textSearch('search_vector', term, { config: 'simple', type: 'plain' })
      .limit(3),
    'search content_blocks'
  );
  console.log(`  content_blocks matching "${term}" with get_citation():`);
  for (const b of blocks) {
    const citation = must(await sb.rpc('get_citation', { block_id: b.id }), 'get_citation');
    console.log(`    [${b.block_type}] ${b.text_content.slice(0, 60)}`);
    console.log(`      → ${citation}`);
  }

  console.log(`
  Same checks in the SQL editor:
    select s.code, s.title from sections s
     where s.search_vector @@ plainto_tsquery('simple', '${term}');

    select cb.block_type, left(cb.text_content, 60), get_citation(cb.id)
      from content_blocks cb
     where cb.search_vector @@ plainto_tsquery('simple', '${term}')
     limit 5;

    -- Related procedures of س-1-ا-1, linked to their section where in this guide
    select cb.metadata->>'relation' as relation, cb.text_content, t.title
      from content_blocks cb
      join sections s on s.id = cb.section_id
      left join sections t on t.guide_version_id = s.guide_version_id
                          and t.code = cb.metadata->>'ref_code'
     where s.code = 'س-1-ا-1' and cb.metadata->>'kind' = 'related_procedure'
     order by cb.seq;`);
}

main().catch((err) => {
  console.error(`\nImport failed: ${err.message}`);
  process.exit(1);
});
