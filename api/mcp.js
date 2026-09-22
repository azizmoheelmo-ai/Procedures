import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let dataCache;
function loadData() {
  if (!dataCache) {
    const p = path.join(process.cwd(), 'data', 'procedures.json');
    dataCache = JSON.parse(readFileSync(p, 'utf-8'));
  }
  return dataCache;
}

let orgDataCache;
function loadOrgData() {
  if (!orgDataCache) {
    const p = path.join(process.cwd(), 'data', 'org_manual.json');
    orgDataCache = JSON.parse(readFileSync(p, 'utf-8'));
  }
  return orgDataCache;
}

// Job-description roles and committees share the same shape for our purposes
// (a title, a page range, and a numbered task list) so they can be searched together.
function orgUnits(orgData) {
  const roles = Object.values(orgData.job_descriptions.roles).map((r) => ({
    ...r,
    kind: 'وظيفة',
  }));
  const committees = Object.values(orgData.committees).map((c) => ({
    ...c,
    kind: 'لجنة/فريق عمل',
  }));
  return [...roles, ...committees];
}

// Normalizes Arabic text for matching: strips diacritics/tatweel, unifies
// hamza/alef and ya/ta-marbuta variants. Word-level "ال" (the definite
// article) is stripped separately in findOrgUnit/textIncludes, since titles
// in the manual inconsistently include it (e.g. "محضر مختبر" vs a query for
// "محضر المختبر").
function normalizeArabic(s) {
  return (s || '')
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function stripAl(word) {
  return word.startsWith('ال') && word.length > 2 ? word.slice(2) : word;
}

function textIncludes(haystack, needle) {
  const nHay = normalizeArabic(haystack);
  const nNeedle = normalizeArabic(needle);
  return nHay.includes(nNeedle) || nHay.includes(stripAl(nNeedle));
}

function findOrgUnit(units, role) {
  const nRole = normalizeArabic(role);
  const exact = units.find((u) => normalizeArabic(u.title) === nRole);
  if (exact) return exact;
  const substr = units.find(
    (u) => textIncludes(u.title, role) || textIncludes(role, u.title)
  );
  if (substr) return substr;
  const tokens = nRole.split(/[\s/]+/).filter(Boolean).map(stripAl);
  return units.find((u) => {
    const nTitle = normalizeArabic(u.title);
    return tokens.every((t) => nTitle.includes(t) || nTitle.includes('ال' + t));
  });
}

function createServer() {
  const data = loadData();
  const orgData = loadOrgData();
  const server = new McpServer(
    { name: 'procedures-guide', version: '1.0.0' },
    {
      instructions:
        'دليل إجراءات العمل بمدارس التعليم العام. ابحث عن إجراء بالاسم أو الرمز عبر search_procedures، أو اعرض تفاصيله الكاملة عبر get_procedure، أو استعرض الأدوار الوظيفية عبر list_roles.',
    }
  );

  server.registerTool(
    'search_procedures',
    {
      title: 'بحث في الإجراءات',
      description:
        'يبحث في دليل إجراءات العمل بمدارس التعليم العام عن إجراء بالاسم أو الرمز أو المجموعة، مع إمكانية التصفية حسب الدور الوظيفي المسؤول أو المشارك.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('نص للبحث في اسم الإجراء أو رمزه أو مرجعه أو مجموعته (اختياري عند تمرير role)'),
        role: z
          .string()
          .optional()
          .describe('اسم دور وظيفي أو لجنة لتصفية النتائج، يجب أن يطابق أحد الأدوار في list_roles'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .describe('أقصى عدد نتائج تُعاد (افتراضي 10)'),
      },
    },
    async ({ query, role, limit }) => {
      let results = data.procedures;

      if (role) {
        const idx = data.role_index[role];
        if (!idx) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `لا يوجد دور بهذا الاسم: "${role}". استخدم list_roles لعرض الأدوار المتاحة.`,
              },
            ],
          };
        }
        const codes = new Set([...idx.owner_of, ...idx.contributes_to]);
        results = results.filter((p) => codes.has(p.code));
      }

      if (query && query.trim()) {
        const q = query.trim();
        results = results.filter(
          (p) =>
            p.name.includes(q) ||
            p.code.includes(q) ||
            (p.ref || '').includes(q) ||
            (p.group || '').includes(q)
        );
      }

      results = results.slice(0, limit || 10);

      if (!results.length) {
        return { content: [{ type: 'text', text: 'لا توجد نتائج مطابقة.' }] };
      }

      const text = results
        .map(
          (p) =>
            `• [${p.code}] ${p.name} — ${p.group} (المالك: ${p.owner}, ص ${p.page_start}-${p.page_end})`
        )
        .join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'get_procedure',
    {
      title: 'تفاصيل إجراء',
      description:
        'يعرض التفاصيل الكاملة لإجراء معيّن من دليل إجراءات العمل بمدارس التعليم العام باستخدام رمزه (مثل 1.1.1)، بما في ذلك الهدف والمدخلات والمخرجات والنماذج وخطوات التنفيذ.',
      inputSchema: {
        code: z.string().describe('رمز الإجراء، مثل 1.1.1'),
      },
    },
    async ({ code }) => {
      const p = data.procedures.find((x) => x.code === code);
      if (!p) {
        return {
          isError: true,
          content: [{ type: 'text', text: `لا يوجد إجراء بالرمز ${code}` }],
        };
      }

      const lines = [];
      lines.push(`# [${p.code}] ${p.name}`);
      lines.push(
        `المجموعة: ${p.group} | المرجع: ${p.ref} | الصفحات: ${p.page_start}-${p.page_end}`
      );
      lines.push(`المالك: ${p.owner}`);
      if (p.objective) lines.push(`\nالهدف: ${p.objective}`);
      if (p.scope) lines.push(`النطاق: ${p.scope}`);
      if (p.inputs?.length)
        lines.push(`\nالمدخلات:\n${p.inputs.map((x) => `- ${x}`).join('\n')}`);
      if (p.outputs?.length)
        lines.push(`\nالمخرجات:\n${p.outputs.map((x) => `- ${x}`).join('\n')}`);
      if (p.forms?.length)
        lines.push(`\nالنماذج المستخدمة:\n${p.forms.map((x) => `- ${x}`).join('\n')}`);
      if (p.steps?.length) {
        lines.push('\nخطوات التنفيذ:');
        for (const s of p.steps) {
          lines.push(`${s.printed_seq}. ${s.heading} (المسؤول: ${s.responsible || '-'})`);
          for (const b of s.bullets || []) lines.push(`   - ${b}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'list_roles',
    {
      title: 'قائمة الأدوار الوظيفية',
      description:
        'يعرض كل الأدوار الوظيفية واللجان الواردة في الدليل مع عدد الإجراءات التي كل دور مالك لها أو مشارك فيها.',
      inputSchema: {},
    },
    async () => {
      const lines = data.roles.map((r) => {
        const idx = data.role_index[r];
        return `• ${r} — مالك: ${idx.owner_of.length}, مشارك: ${idx.contributes_to.length}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'search_job_description',
    {
      title: 'بحث في الوصف الوظيفي والمهام',
      description:
        'يبحث في "الدليل التنظيمي لمدارس التعليم العام" (دليل الأهداف والمهام) عن مهام واختصاصات أي وظيفة مدرسية أو لجنة/فريق عمل، مع رقم الصفحة ورقم البند لكل مهمة. استخدمه لأسئلة مثل "ما مهام وكيل شؤون الطلاب؟" أو "من المسؤول عن متابعة الغياب؟".',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('نص للبحث في نصوص المهام أو الهدف (اختياري عند تمرير role)'),
        role: z
          .string()
          .optional()
          .describe(
            'اسم وظيفة أو لجنة/فريق عمل لتصفية النتائج، يجب أن يطابق أحد الأسماء في list_org_units'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('أقصى عدد نتائج تُعاد (افتراضي 15)'),
      },
    },
    async ({ query, role, limit }) => {
      let units = orgUnits(orgData);

      if (role) {
        const match = findOrgUnit(units, role);
        if (!match) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `لا توجد وظيفة أو لجنة بهذا الاسم: "${role}". استخدم list_org_units لعرض الأسماء المتاحة.`,
              },
            ],
          };
        }
        units = [match];
      }

      const q = (query || '').trim();
      const hits = [];
      for (const u of units) {
        for (const t of u.tasks || []) {
          if (
            !q ||
            textIncludes(t.text, q) ||
            textIncludes(u.title, q) ||
            textIncludes(u.objective || u.goal || '', q)
          ) {
            hits.push({ unit: u, task: t });
          }
        }
      }

      const sliced = hits.slice(0, limit || 15);
      if (!sliced.length) {
        return { content: [{ type: 'text', text: 'لا توجد نتائج مطابقة.' }] };
      }

      const text = sliced
        .map(
          ({ unit, task }) =>
            `• ${task.text} (${unit.kind === 'لجنة/فريق عمل' ? 'مهام' : 'الوصف الوظيفي لـ'}${unit.title}، ص. ${unit.page_start}، البند رقم ${task.seq})`
        )
        .join('\n');
      return { content: [{ type: 'text', text }] };
    }
  );

  server.registerTool(
    'get_job_description',
    {
      title: 'تفاصيل الوصف الوظيفي أو اللجنة',
      description:
        'يعرض التفاصيل الكاملة لوظيفة مدرسية أو لجنة/فريق عمل من "الدليل التنظيمي لمدارس التعليم العام": الهدف/الغاية، الارتباط التنظيمي أو الأعضاء، الحد الأدنى للمؤهلات (للوظائف)، وقائمة كل المهام مرقّمة مع الاستشهاد.',
      inputSchema: {
        role: z
          .string()
          .describe('اسم الوظيفة أو اللجنة/فريق العمل كما يظهر في list_org_units'),
      },
    },
    async ({ role }) => {
      const units = orgUnits(orgData);
      const u = findOrgUnit(units, role);
      if (!u) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `لا توجد وظيفة أو لجنة بهذا الاسم: "${role}". استخدم list_org_units لعرض الأسماء المتاحة.`,
            },
          ],
        };
      }

      const lines = [];
      lines.push(`# ${u.title} (${u.kind})`);
      lines.push(`الصفحات: ${u.page_start}-${u.page_end}`);
      if (u.org_link?.length) lines.push(`\nالارتباط التنظيمي:\n${u.org_link.map((x) => `- ${x}`).join('\n')}`);
      if (u.objective) lines.push(`\nالهدف الوظيفي: ${u.objective}`);
      if (u.goal) lines.push(`\nالهدف/الغاية: ${u.goal}`);
      if (u.members?.length)
        lines.push(
          `\nالأعضاء:\n${u.members.map((m) => `- ${m.text}${m.role ? ` (${m.role})` : ''}`).join('\n')}`
        );
      if (u.min_quals?.length)
        lines.push(`\nالحد الأدنى للمؤهلات والخبرات:\n${u.min_quals.map((x) => `- ${x}`).join('\n')}`);
      if (u.formation_rules?.length)
        lines.push(`\nضوابط التشكيل:\n${u.formation_rules.map((x) => `- ${x}`).join('\n')}`);
      if (u.meetings?.length)
        lines.push(`\nالاجتماعات:\n${u.meetings.map((x) => `- ${x}`).join('\n')}`);
      if (u.tasks?.length) {
        lines.push(`\nالمهام (ص. ${u.page_start}-${u.page_end}):`);
        for (const t of u.tasks) lines.push(`${t.seq}. ${t.text}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  server.registerTool(
    'list_org_units',
    {
      title: 'قائمة الوظائف واللجان',
      description:
        'يعرض كل الوظائف المدرسية واللجان/فرق العمل الواردة في الدليل التنظيمي، مع عدد المهام والصفحات لكل واحدة. استخدمه لمعرفة الاسم الدقيق قبل استدعاء get_job_description أو search_job_description بمعامل role.',
      inputSchema: {},
    },
    async () => {
      const units = orgUnits(orgData);
      const lines = units.map(
        (u) => `• ${u.title} (${u.kind}) — ${u.tasks?.length || 0} مهمة، ص. ${u.page_start}-${u.page_end}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
  );

  return server;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Mcp-Session-Id, mcp-protocol-version'
  );
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
