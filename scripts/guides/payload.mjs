// Shared helpers for guide adapters.
//
// Every adapter turns its source file into one import payload (format 1),
// which public.import_guide() loads atomically:
//
//   {
//     format: 1,
//     guide:    { code, name_ar, short_name, guide_type, description? },
//     version:  { version_label, issue_date, source_file, source_hash, total_pages },
//     sections: [{ key, parent_key, code, title, level, order_index,
//                  page_start, page_end, owner_role, objective, scope,
//                  blocks: [{ block_type, seq, text_content, page, metadata }] }]
//   }
//
// `key` / `parent_key` only link sections inside the payload; the database
// assigns the real ids.
import { createHash } from 'node:crypto';

export const clean = (s) => (typeof s === 'string' ? s.trim() : '');

export const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Numeric compare for dotted codes: 1.2 < 1.10.
export const compareCodes = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

export function section({ key, parent = null, code = null, title, level, order, pageStart = null, pageEnd = null, ownerRole = null, objective = null, scope = null }) {
  return {
    key,
    parent_key: parent?.key ?? null,
    code,
    title,
    level,
    order_index: order,
    page_start: pageStart,
    page_end: pageEnd,
    owner_role: ownerRole,
    objective,
    scope,
    blocks: [],
  };
}

// Adds a content block to a section; blank text is skipped (text_content is NOT NULL).
export function block(sec, blockType, seq, text, page, metadata = {}) {
  const textContent = clean(text);
  if (textContent) {
    sec.blocks.push({ block_type: blockType, seq, text_content: textContent, page, metadata });
  }
}

export function summarize(payload) {
  const byType = {};
  let blocks = 0;
  for (const s of payload.sections) {
    for (const b of s.blocks) {
      byType[b.block_type] = (byType[b.block_type] ?? 0) + 1;
      blocks++;
    }
  }
  const byLevel = {};
  for (const s of payload.sections) byLevel[s.level] = (byLevel[s.level] ?? 0) + 1;
  return { sections: payload.sections.length, blocks, byLevel, byType };
}
