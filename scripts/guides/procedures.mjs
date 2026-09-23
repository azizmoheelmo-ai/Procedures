// دليل إجراءات العمل بمدارس التعليم العام.
//
// Accepts the flat data/procedures.json (default) or the grouped
// procedures-db.json export (groups[] → procedures[]).
//
// Sections: 18 groups (level 1) → 60 procedures (level 2, code = reference
// code such as س-1-ا-1). Blocks: step, raci, policy, input, output, form, kpi,
// system, plus note blocks for related procedures and raw_text.
import path from 'node:path';
import { block, clean, compareCodes, section, sha256, toInt } from './payload.mjs';

const TOTAL_PAGES = 385;
const RELATIONS = ['previous', 'implicit', 'next'];

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
    raw_text: p.raw_text ?? null,
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

function loadGroups(data, file) {
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
  return groups;
}

// Related procedures are listed by name ("إجراء ..."). Link the ones that are
// in this guide to their reference code; the rest belong to other levels
// (e.g. the education department) and keep ref_code null.
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

// The date comes from the Gregorian part of the first procedure's issue_date
// ("رجب، 1446 هـ الموافق Jan,2025").
function parseIssueDate(text) {
  const m = /([A-Za-z]{3})[a-z]*\s*,?\s*(\d{4})/.exec(text ?? '');
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mi = months.indexOf(m[1].toLowerCase());
  return mi < 0 ? null : `${m[2]}-${String(mi + 1).padStart(2, '0')}-01`;
}

function addProcedureBlocks(sec, proc) {
  const page = proc.page;
  for (const s of proc.steps) {
    block(sec, 'step', s.seq, s.task, page, {
      printed_seq: s.printed_seq,
      responsible: s.responsible,
      system: s.system,
      form_or_doc: s.form_or_doc,
      detail_bullets: s.detail_bullets,
    });
  }
  proc.raci.forEach((r, i) => block(sec, 'raci', toInt(r.seq) ?? i + 1, r.task, page, { roles: r.roles ?? {} }));
  proc.policies.forEach((t, i) => block(sec, 'policy', i + 1, t, page));
  proc.inputs.forEach((t, i) => block(sec, 'input', i + 1, t, page));
  proc.outputs.forEach((t, i) => block(sec, 'output', i + 1, t, page));
  proc.forms.forEach((t, i) => block(sec, 'form', i + 1, t, page));
  proc.kpis.forEach((k, i) =>
    block(sec, 'kpi', toInt(k.seq) ?? i + 1, k.name, page, { code: k.code, formula: k.formula, unit: k.unit })
  );
  proc.systems.forEach((s, i) => block(sec, 'system', i + 1, s.system, page, { description: s.description }));
  proc.related.forEach((r, i) =>
    block(sec, 'note', i + 1, r.name, page, { kind: 'related_procedure', relation: r.relation, ref_code: r.ref_code })
  );
  // Full extracted text of the procedure (only in procedures-db.json).
  block(sec, 'note', 0, proc.raw_text, page, { kind: 'raw_text', page_start: proc.page_start, page_end: proc.page_end });
}

export default {
  code: 'procedures_manual',
  source: 'data/procedures.json',

  build(raw, file) {
    const data = JSON.parse(raw.toString('utf-8'));
    const groups = loadGroups(data, file);
    const procedures = groups.flatMap((g) => g.procedures);
    resolveRelated(procedures);

    const sections = [];
    groups.forEach((g, gi) => {
      const gs = section({
        key: `group:${g.code}`,
        code: g.code,
        title: g.name,
        level: 1,
        order: gi,
        pageStart: g.page_start,
        pageEnd: g.page_end,
      });
      sections.push(gs);
      g.procedures.forEach((p, pi) => {
        const ps = section({
          key: `procedure:${p.ref_code}`,
          parent: gs,
          code: p.ref_code,
          title: p.name,
          level: 2,
          order: pi,
          pageStart: p.page_start,
          pageEnd: p.page_end,
          ownerRole: p.owner,
          objective: p.objective,
          scope: p.scope,
        });
        addProcedureBlocks(ps, p);
        sections.push(ps);
      });
    });

    return {
      format: 1,
      guide: {
        code: 'procedures_manual',
        name_ar: 'دليل إجراءات العمل بمدارس التعليم العام',
        short_name: 'دليل الإجراءات',
        guide_type: 'procedures',
      },
      version: {
        version_label: '1446-1447هـ',
        issue_date: parseIssueDate(procedures[0]?.issue_date),
        source_file: data.source_file ?? path.basename(file),
        source_hash: data.source_hash ?? sha256(raw),
        total_pages: data.total_pages ?? TOTAL_PAGES,
      },
      sections,
      expected: {
        level1: data.group_count ?? 18,
        level2: data.procedure_count ?? data.total ?? 60,
      },
    };
  },
};
