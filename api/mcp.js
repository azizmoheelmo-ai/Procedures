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

function createServer() {
  const data = loadData();
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
