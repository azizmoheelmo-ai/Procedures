// الدليل التنظيمي لمدارس التعليم العام (دليل الأهداف والمهام).
//
// Level 1 follows the manual's table of contents; level 2 holds its
// repeated units (staffing parts, org-chart templates, committees, job
// descriptions). The manual has no clause numbers, so sections carry no code
// and citations read "الدليل التنظيمي، ص N".
//
// Blocks: task (school/committee/role tasks), article (foreword paragraphs,
// definitions, clarifications) and note blocks told apart by metadata.kind:
// org_link, qualification, member, formation_rule, meeting, staffing,
// org_chart_unit, footnote, intro.
import path from 'node:path';
import { block, clean, section, sha256 } from './payload.mjs';

const pageRange = (items) => {
  const pages = items.flatMap((i) => [i.page_start, i.page_end]).filter((p) => p != null);
  return pages.length ? [Math.min(...pages), Math.max(...pages)] : [null, null];
};

// Clarification items nest sub-points; flatten them into readable lines.
const flatten = (items, depth = 1) =>
  (items ?? []).flatMap((s) => [`${'  '.repeat(depth - 1)}- ${clean(s.text)}`, ...flatten(s.sub, depth + 1)]);

export default {
  code: 'org_manual',
  source: 'data/org_manual.json',

  build(raw, file) {
    const d = JSON.parse(raw.toString('utf-8'));
    const toc = new Map(d.table_of_contents.items.map((i) => [i.seq, i.title]));
    const sections = [];
    let order = 0;
    const top = (key, tocSeq, pageStart, pageEnd, extra = {}) => {
      const s = section({ key, title: toc.get(tocSeq), level: 1, order: order++, pageStart, pageEnd, ...extra });
      sections.push(s);
      return s;
    };
    const child = (parent, key, i, fields) => {
      const s = section({ key, parent, level: 2, order: i, ...fields });
      sections.push(s);
      return s;
    };

    // 1) المقدمة — one article per paragraph.
    const fw = d.foreword;
    const intro = top('foreword', 1, fw.page, fw.page);
    fw.text.split(/\n\s*\n/).forEach((para, i) => block(intro, 'article', i + 1, para, fw.page));

    // 2) التعريفات والمفاهيم
    const gl = d.glossary;
    const glossary = top('glossary', 2, gl.page_start, gl.page_end);
    block(glossary, 'note', 0, gl.intro, gl.page_start, { kind: 'intro' });
    gl.terms.forEach((t, i) =>
      block(glossary, 'article', i + 1, `${clean(t.term)}: ${clean(t.definition)}`, t.page, { kind: 'definition', term: t.term })
    );

    // 3) مهام واختصاصات المدرسة
    const su = d.school_unit;
    const school = top('school_unit', 3, su.page, su.page, { ownerRole: su.org_unit, objective: su.goal });
    su.org_link.forEach((t, i) => block(school, 'note', i + 1, t, su.page, { kind: 'org_link' }));
    su.tasks.forEach((t) => block(school, 'task', t.seq, t.text, su.page));

    // 4) التشكيلات المدرسية: staffing table + clarifications.
    const st = d.staffing_table;
    const cn = d.clarification_notes;
    const staffing = top('staffing', 4, st.page, cn.page_end);
    const table = child(staffing, 'staffing:table', 0, { title: st.title, pageStart: st.page, pageEnd: st.page });
    // The extracted intro ends with UI text ("اختر فئة مدرستك ..."); keep the guide's sentence only.
    block(table, 'note', 0, st.intro.split(/\s*اختر /)[0], st.page, { kind: 'intro' });
    const stageLabel = new Map(st.stages.map((s) => [s.id, s.label]));
    st.roles.forEach((r, i) => {
      const parts = Object.entries(r.by_stage).map(
        ([stage, rows]) => `${stageLabel.get(stage) ?? stage}: ${rows.map((x) => `${x.count} (${x.range})`).join('، ')}`
      );
      block(table, 'note', i + 1, `${r.role}${r.marker ?? ''} — ${parts.join('؛ ')}`, st.page, {
        kind: 'staffing',
        role: r.role,
        marker: r.marker,
        by_stage: r.by_stage,
      });
    });
    st.footnotes.forEach((f, i) =>
      block(table, 'note', 100 + i, `${f.marker} ${f.text}`, st.page, { kind: 'footnote', marker: f.marker })
    );
    const clar = child(staffing, 'staffing:clarifications', 1, {
      title: cn.title,
      pageStart: cn.page_start,
      pageEnd: cn.page_end,
      scope: cn.subtitle,
    });
    cn.items.forEach((it) =>
      block(clar, 'article', it.seq, [clean(it.text), ...flatten(it.sub)].join('\n'), it.page, it.sub ? { sub: it.sub } : {})
    );
    block(clar, 'note', 100, cn.footnote, cn.page_end, { kind: 'footnote' });

    // 5) نماذج الهياكل التنظيمية — one section per template.
    const oc = d.org_charts;
    const charts = top('org_charts', 5, oc.page_start, oc.page_end);
    block(charts, 'note', 0, oc.intro, oc.page_start, { kind: 'intro' });
    oc.footnotes.forEach((f, i) => block(charts, 'note', 100 + i, f, oc.page_start, { kind: 'footnote' }));
    oc.variants.forEach((v, vi) => {
      const vs = child(charts, `org_chart:${v.id}`, vi, { title: v.title, pageStart: v.page, pageEnd: v.page, scope: v.label });
      let seq = 1;
      if (v.secretary) {
        block(vs, 'note', seq++, v.secretary, v.page, { kind: 'org_chart_unit', unit: v.secretary, reports_to: 'مدير المدرسة' });
      }
      for (const dep of v.deputies) {
        block(vs, 'note', seq++, `${dep.name}: ${dep.subordinates.join('، ')}`, v.page, {
          kind: 'org_chart_unit',
          unit: dep.name,
          reports_to: 'مدير المدرسة',
          subordinates: dep.subordinates,
        });
      }
      if (v.direct_reports.length) {
        block(vs, 'note', seq++, `يرتبط مباشرة بمدير المدرسة: ${v.direct_reports.join('، ')}`, v.page, {
          kind: 'org_chart_unit',
          unit: 'مدير المدرسة',
          subordinates: v.direct_reports,
        });
      }
    });

    // 6) اللجان وفرق العمل — one section per committee, in TOC order.
    const committees = Object.entries(d.committees);
    const [cStart, cEnd] = pageRange(committees.map(([, c]) => c));
    const comm = top('committees', 6, cStart, cEnd);
    committees.forEach(([name, c], ci) => {
      const chair = c.members.find((m) => m.role === 'رئيس اللجنة');
      const cs = child(comm, `committee:${name}`, ci, {
        title: c.title,
        pageStart: c.page_start,
        pageEnd: c.page_end,
        ownerRole: chair?.text ?? null,
        objective: c.goal,
        scope: c.subtitle ?? null,
      });
      c.members.forEach((m, i) =>
        block(cs, 'note', i + 1, `${m.text} (${m.role})`, c.page_start, { kind: 'member', member: m.text, role: m.role })
      );
      c.formation_rules.forEach((t, i) => block(cs, 'note', i + 1, t, c.page_start, { kind: 'formation_rule' }));
      c.meetings.forEach((t, i) => block(cs, 'note', i + 1, t, c.page_start, { kind: 'meeting' }));
      c.tasks.forEach((t) => block(cs, 'task', t.seq, t.text, c.page_start));
    });

    // 7) الوصف الوظيفي — one section per role card, in page order. Some cards
    // are listed under two names (المعلم / المعلم الخبير / المتقدم); import each once.
    const seen = new Set();
    const roles = Object.values(d.job_descriptions.roles)
      .filter((r) => !seen.has(JSON.stringify(r)) && seen.add(JSON.stringify(r)))
      .map((r, i) => ({ ...r, i }))
      .sort((a, b) => a.page_start - b.page_start || a.i - b.i);
    const [rStart, rEnd] = pageRange(roles);
    const jobs = top('job_descriptions', 14, rStart, rEnd);
    roles.forEach((r, ri) => {
      const rs = child(jobs, `role:${r.title}`, ri, {
        title: r.title,
        pageStart: r.page_start,
        pageEnd: r.page_end,
        ownerRole: r.title,
        objective: r.objective,
      });
      r.org_link.forEach((t, i) => block(rs, 'note', i + 1, t, r.page_start, { kind: 'org_link' }));
      r.min_quals.forEach((t, i) => block(rs, 'note', i + 1, t, r.page_start, { kind: 'qualification' }));
      r.tasks.forEach((t) => block(rs, 'task', t.seq, t.text, r.page_start));
    });

    return {
      format: 1,
      guide: {
        code: 'org_manual',
        name_ar: clean(d.cover.title),
        short_name: 'الدليل التنظيمي',
        guide_type: 'org_structure',
        description: 'دليل الأهداف والمهام: مهام المدرسة، التشكيلات المدرسية، الهياكل التنظيمية، اللجان وفرق العمل، والوصف الوظيفي لمنسوبي المدرسة.',
      },
      version: {
        version_label: '1446-1447هـ',
        issue_date: null, // the cover gives the year only (1446هـ - 2025م)
        source_file: path.basename(file),
        source_hash: sha256(raw),
        total_pages: d.total_pdf_pages ?? null,
      },
      sections,
      expected: {
        level1: 7,
        level2: 2 + oc.variants.length + committees.length + roles.length,
      },
    };
  },
};
