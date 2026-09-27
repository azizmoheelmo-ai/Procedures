// Quality validator for a guide's payload, per docs/extraction-standard.md.
// Prints an Arabic quality report and exits non-zero on a hard failure
// (broken-Arabic evidence). Everything else is a warning: printed, but does
// not block the import on its own.
//
// Usage:
//   node scripts/validate-guide.mjs [code] [--file path] [--pdf path.pdf]
//
//   code       a code from scripts/guides/index.mjs; omit to validate every
//              registered guide (no --pdf in that mode: one PDF can't match many).
//   --file     source file to read instead of the adapter's default
//   --pdf      the original PDF, to check the extracted-vs-source text ratio (§3.5)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { guides } from './guides/index.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Arabic Presentation Forms (A & B): text landing here almost always means a
// PDF extractor pulled glyph codepoints without reshaping/reordering them —
// a definite sign of broken extraction, not a real word.
const PRESENTATION_FORMS = /[ﭐ-﷿ﹰ-﻿]/;

// Specific corrupted tokens seen in real extractions (reversed lam-hamza
// prefix). Mapped to the word they should have been, for the report.
const KNOWN_BAD_TOKENS = {
  'إلدارة': 'لإدارة',
  'إلعداد': 'لإعداد',
  'إلجراءات': 'لإجراءات',
  'إلرسال': 'لإرسال',
};

const LATIN_RUN = /[A-Za-z]{2,}/;
const ARABIC_LETTER = /[ء-ي]/;

function parseArgs(argv) {
  const opts = { code: null, file: null, pdf: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--pdf') opts.pdf = argv[++i];
    else if (!a.startsWith('--')) opts.code = a;
  }
  return opts;
}

function loadGuide(adapter, fileOverride) {
  const file = path.resolve(fileOverride ?? path.join(root, adapter.source));
  const raw = readFileSync(file);
  const payload = adapter.build(raw, file);
  let rawData = null;
  try {
    rawData = JSON.parse(raw.toString('utf-8'));
  } catch {
    // Not all future sources need be JSON; the TOC/ratio checks just degrade.
  }
  return { file, raw, payload, rawData };
}

function allBlocks(payload) {
  return payload.sections.flatMap((s) => s.blocks.map((b) => ({ ...b, section: s })));
}

// §3.1 page coverage
function checkPageCoverage(payload) {
  const total = payload.version.total_pages;
  if (!total) return { skipped: 'عدد الصفحات (total_pages) غير معروف' };
  const covered = new Set();
  const mark = (p) => p != null && covered.add(p);
  for (const s of payload.sections) {
    for (let p = s.page_start ?? s.page_end; p != null && p <= (s.page_end ?? s.page_start); p++) mark(p);
    mark(s.page_start);
    mark(s.page_end);
  }
  for (const b of allBlocks(payload)) mark(b.page);
  const missing = [];
  for (let p = 1; p <= total; p++) if (!covered.has(p)) missing.push(p);
  return { total, coveredCount: covered.size, missing };
}

// §3.2 clause numbering continuity — heuristic: compare the last integer run
// in `code` among siblings (same parent_key); codes without digits are skipped.
function lastInt(code) {
  const m = /(\d+)(?!.*\d)/.exec(code ?? '');
  return m ? Number.parseInt(m[1], 10) : null;
}

function checkNumbering(payload) {
  const byParent = new Map();
  for (const s of payload.sections) {
    const n = lastInt(s.code);
    if (n == null) continue;
    const key = s.parent_key ?? '(جذر)';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push({ code: s.code, title: s.title, n });
  }
  const gaps = [];
  const dups = [];
  let checkedGroups = 0;
  for (const items of byParent.values()) {
    if (items.length < 2) continue;
    checkedGroups++;
    const sorted = [...items].sort((a, b) => a.n - b.n);
    const seen = new Map();
    for (const it of sorted) {
      seen.set(it.n, (seen.get(it.n) ?? 0) + 1);
    }
    for (const [n, count] of seen) if (count > 1) dups.push({ n, count, sample: sorted.find((x) => x.n === n) });
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i].n - sorted[i - 1].n;
      if (diff > 1) gaps.push({ from: sorted[i - 1], to: sorted[i], diff });
    }
  }
  const numberedSections = [...byParent.values()].flat().length;
  return { checkedGroups, numberedSections, gaps, dups };
}

// §3.3 table-of-contents titles present among the built sections
function tocTitles(rawData) {
  if (!rawData) return null;
  if (Array.isArray(rawData.table_of_contents?.items)) {
    return rawData.table_of_contents.items.map((i) => i.title);
  }
  if (Array.isArray(rawData.table_of_contents)) {
    return rawData.table_of_contents.map((i) => i.title ?? i);
  }
  return null;
}

function checkToc(payload, rawData) {
  const titles = tocTitles(rawData);
  if (!titles) return { skipped: 'لا يوجد فهرس (table_of_contents) في الملف المصدر' };
  const sectionTitles = new Set(payload.sections.map((s) => (s.title ?? '').trim()));
  const missing = titles.map((t) => (t ?? '').trim()).filter((t) => t && !sectionTitles.has(t));
  return { total: titles.length, missing };
}

// §3.4 broken-Arabic heuristics
function checkArabic(payload) {
  const texts = [
    ...payload.sections.flatMap((s) => [s.title, s.objective, s.scope].filter(Boolean).map((t) => ({ t, where: s.title }))),
    ...allBlocks(payload).map((b) => ({ t: b.text_content, where: b.section.title })),
  ];
  const presentationForms = [];
  const badTokens = [];
  const latinRuns = [];
  for (const { t, where } of texts) {
    if (PRESENTATION_FORMS.test(t)) presentationForms.push({ where, sample: t.slice(0, 60) });
    for (const bad of Object.keys(KNOWN_BAD_TOKENS)) {
      if (t.includes(bad)) badTokens.push({ where, bad, fix: KNOWN_BAD_TOKENS[bad], sample: t.slice(0, 60) });
    }
    // Soft signal only: a Latin run inside Arabic text is often a legitimate
    // abbreviation or code, so this is reported, never a hard failure.
    if (ARABIC_LETTER.test(t) && LATIN_RUN.test(t)) latinRuns.push({ where, sample: t.slice(0, 60) });
  }
  return { presentationForms, badTokens, latinRuns, scanned: texts.length };
}

// §3.5 extracted-vs-source text length ratio
async function checkRatio(payload, pdfPath) {
  if (!pdfPath) return { skipped: '--pdf لم يُمرَّر' };
  let PDFParse;
  try {
    ({ PDFParse } = await import('pdf-parse'));
  } catch (e) {
    return { skipped: `تعذّر تحميل مكتبة استخراج PDF: ${e.message}` };
  }
  try {
    const data = readFileSync(path.resolve(pdfPath));
    const parser = new PDFParse({ data });
    const result = await parser.getText();
    const sourceLen = result.text.replace(/\s+/g, '').length;
    const extractedLen = payload.sections
      .flatMap((s) => [s.title, s.objective, s.scope, ...s.blocks.map((b) => b.text_content)])
      .filter(Boolean)
      .join('')
      .replace(/\s+/g, '').length;
    const ratio = sourceLen ? extractedLen / sourceLen : null;
    return { sourceLen, extractedLen, ratio };
  } catch (e) {
    return { skipped: `تعذّر قراءة الملف: ${e.message}` };
  }
}

// §3.6 empty/duplicate blocks
function checkBlocks(payload) {
  const blocks = allBlocks(payload);
  const empty = blocks.filter((b) => !b.text_content || !b.text_content.trim());
  const counts = new Map();
  for (const b of blocks) {
    const key = `${b.block_type}\u0000${b.text_content}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([key, n]) => ({ text: key.split('\u0000')[1].slice(0, 60), count: n }));
  return { total: blocks.length, empty: empty.length, duplicates };
}

function fmtPages(list, max = 15) {
  if (list.length === 0) return 'لا شيء';
  const shown = list.slice(0, max).join('، ');
  return list.length > max ? `${shown} … (+${list.length - max})` : shown;
}

async function validateOne(adapter, opts) {
  console.log(`\n=== ${adapter.code} ===`);
  const { file, payload, rawData } = loadGuide(adapter, opts.file);
  console.log(`الملف: ${path.relative(process.cwd(), file)}`);
  console.log(`الأقسام: ${payload.sections.length}، العناصر: ${payload.sections.reduce((n, s) => n + s.blocks.length, 0)}`);

  let hardFailure = false;

  const cov = checkPageCoverage(payload);
  if (cov.skipped) console.log(`○ تغطية الصفحات: تخطّي — ${cov.skipped}`);
  else console.log(`${cov.missing.length ? '⚠' : '✓'} تغطية الصفحات: ${cov.coveredCount}/${cov.total} مغطاة${cov.missing.length ? `، صفحات بلا محتوى: ${fmtPages(cov.missing)}` : ''}`);

  const num = checkNumbering(payload);
  if (num.checkedGroups === 0) console.log('○ تسلسل الترقيم: تخطّي — لا توجد رموز رقمية كافية للفحص');
  else {
    const ok = num.gaps.length === 0 && num.dups.length === 0;
    console.log(`${ok ? '✓' : '⚠'} تسلسل الترقيم: ${num.numberedSections} رمزاً في ${num.checkedGroups} مجموعة${ok ? '' : ''}`);
    for (const g of num.gaps.slice(0, 10)) console.log(`   فجوة: من "${g.from.code}" (${g.from.title}) إلى "${g.to.code}" (${g.to.title})`);
    for (const d of num.dups.slice(0, 10)) console.log(`   تكرار الرقم ${d.n}: "${d.sample.code}" (${d.sample.title}) — ${d.count} مرات`);
  }

  const toc = checkToc(payload, rawData);
  if (toc.skipped) console.log(`○ مطابقة الفهرس: تخطّي — ${toc.skipped}`);
  else console.log(`${toc.missing.length ? '⚠' : '✓'} مطابقة الفهرس: ${toc.total - toc.missing.length}/${toc.total}${toc.missing.length ? `، عناوين مفقودة: ${toc.missing.slice(0, 10).join(' | ')}` : ''}`);

  const ar = checkArabic(payload);
  if (ar.presentationForms.length) {
    hardFailure = true;
    console.log(`✗ تشوّه النص (حاسم): ${ar.presentationForms.length} نصاً يحوي محارف عرض عربية معطوبة`);
    for (const p of ar.presentationForms.slice(0, 5)) console.log(`   في "${p.where}": ${p.sample}`);
  }
  if (ar.badTokens.length) {
    hardFailure = true;
    console.log(`✗ ألفاظ معروفة الفساد (حاسم): ${ar.badTokens.length}`);
    for (const b of ar.badTokens.slice(0, 5)) console.log(`   "${b.bad}" (المقصود: "${b.fix}") في "${b.where}": ${b.sample}`);
  }
  if (!ar.presentationForms.length && !ar.badTokens.length) console.log(`✓ تشوّه النص: لا شيء حاسم في ${ar.scanned} نصاً`);
  if (ar.latinRuns.length) console.log(`⚠ حروف لاتينية داخل نص عربي: ${ar.latinRuns.length} موضعاً (راجعها؛ قد تكون اختصارات مقبولة)`);

  const ratio = await checkRatio(payload, opts.pdf);
  if (ratio.skipped) console.log(`○ نسبة الاستخراج: تخطّي — ${ratio.skipped}`);
  else {
    const pct = (ratio.ratio * 100).toFixed(0);
    const ok = ratio.ratio >= 0.5 && ratio.ratio <= 1.5;
    console.log(`${ok ? '✓' : '⚠'} نسبة الاستخراج: ${pct}% (مستخرج ${ratio.extractedLen} حرفاً من أصل ${ratio.sourceLen})`);
  }

  const blk = checkBlocks(payload);
  console.log(`${blk.empty ? '✗' : '✓'} عناصر فارغة: ${blk.empty}`);
  if (blk.duplicates.length) {
    console.log(`⚠ عناصر مكررة حرفياً: ${blk.duplicates.length}`);
    for (const d of blk.duplicates.slice(0, 5)) console.log(`   (${d.count}×) ${d.text}`);
  } else {
    console.log('✓ لا عناصر مكررة حرفياً');
  }

  console.log(hardFailure ? '=> فشل حاسم: لا يُفتح طلب دمج قبل إصلاح الاستخراج.' : '=> لا فشل حاسم.');
  return !hardFailure;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = opts.code ? guides.filter((g) => g.code === opts.code) : guides;
  if (opts.code && targets.length === 0) {
    console.error(`دليل غير معروف: ${opts.code}. المتاح: ${guides.map((g) => g.code).join(', ')}`);
    process.exit(2);
  }
  let ok = true;
  for (const adapter of targets) {
    ok = (await validateOne(adapter, opts)) && ok;
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nفشل الفحص: ${err.message}`);
  process.exit(2);
});
