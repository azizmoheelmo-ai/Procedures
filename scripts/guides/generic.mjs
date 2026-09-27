// Generic adapter for guides that follow the source template in
// docs/extraction-standard.md: a `sections` tree (guide → parts/chapters →
// articles/clauses → paragraphs, to any depth), each node optionally holding
// `blocks` (content items) and/or `children` (sub-sections).
//
// Most new guides need no adapter of their own: register one line in
// index.mjs, e.g.
//   genericGuide({ code: 'behavior_regs', source: 'data/behavior_regs.json' })
//
// A guide whose structure truly doesn't fit this tree (like procedures.mjs's
// groups/procedures, or org-manual.mjs's fixed table-of-contents parts) keeps
// its own adapter instead.
import path from 'node:path';
import { block, clean, section, sha256 } from './payload.mjs';

const VALID_BLOCK_TYPES = new Set([
  'step', 'raci', 'policy', 'input', 'output', 'form', 'kpi', 'article', 'task', 'system', 'note',
]);

function walk(nodes, parentSection, level, sections, filePath) {
  nodes.forEach((node, i) => {
    if (!node.title) throw new Error(`${filePath}: a level-${level} section is missing "title"`);
    const sec = section({
      key: `${parentSection?.key ?? 'root'}/${i}`,
      parent: parentSection,
      code: node.code ?? null,
      title: node.title,
      level,
      order: i,
      pageStart: node.page_start ?? null,
      pageEnd: node.page_end ?? node.page_start ?? null,
      ownerRole: node.owner_role ?? null,
      objective: node.objective ?? null,
      scope: node.scope ?? null,
    });
    sections.push(sec);

    for (const b of node.blocks ?? []) {
      const blockType = b.block_type ?? 'article';
      if (!VALID_BLOCK_TYPES.has(blockType)) {
        throw new Error(`${filePath}: unknown block_type "${blockType}" in section "${node.title}"`);
      }
      block(sec, blockType, b.seq ?? null, b.text ?? b.text_content, b.page ?? sec.page_start, b.metadata ?? {});
    }
    if (node.children?.length) walk(node.children, sec, level + 1, sections, filePath);
  });
}

export function genericGuide({ code, source }) {
  return {
    code,
    source,

    build(raw, file) {
      const data = JSON.parse(raw.toString('utf-8'));
      if (!data.guide?.code) throw new Error(`${file}: missing guide.code`);
      if (data.guide.code !== code) {
        throw new Error(`${file}: guide.code "${data.guide.code}" does not match the registered code "${code}"`);
      }
      if (!Array.isArray(data.sections) || data.sections.length === 0) {
        throw new Error(`${file}: "sections" must be a non-empty array — see docs/extraction-standard.md`);
      }

      const sections = [];
      walk(data.sections, null, 1, sections, file);

      const byLevel = {};
      for (const s of sections) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;

      return {
        format: 1,
        guide: {
          code: data.guide.code,
          name_ar: data.guide.name_ar,
          short_name: data.guide.short_name ?? data.guide.name_ar,
          guide_type: data.guide.guide_type ?? 'other',
          ...(data.guide.description ? { description: data.guide.description } : {}),
        },
        version: {
          version_label: data.version.version_label,
          issue_date: data.version.issue_date ?? null,
          source_file: data.version.source_file ?? path.basename(file),
          source_hash: sha256(raw),
          total_pages: data.version.total_pages ?? null,
        },
        sections,
        // The source may pin exact expected counts (level1/level2/...); otherwise
        // the counts computed above are used as a self-consistency default.
        expected: { level1: byLevel[1] ?? 0, level2: byLevel[2] ?? 0, ...(data.expected ?? {}) },
      };
    },
  };
}

export default genericGuide;
