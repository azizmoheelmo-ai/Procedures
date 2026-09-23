# مجمّع أدلة وزارة التعليم (EduGuidesHub)

مستودع يجمع أدلة وزارة التعليم في قاعدة بيانات واحدة على Supabase (مشروع
`edu-guides-hub`)، مع بحث عربي موحّد واستشهاد دقيق بالصفحة والبند لكل نتيجة.

| الدليل | الرمز | النوع | المصدر |
|---|---|---|---|
| دليل إجراءات العمل بمدارس التعليم العام | `procedures_manual` | procedures | `data/procedures.json` |
| الدليل التنظيمي لمدارس التعليم العام (دليل الأهداف والمهام) | `org_manual` | org_structure | `data/org_manual.json` |

المستودع يحتوي أيضاً على واجهة الويب (`index.html`) وموصّل MCP (`api/mcp.js`)،
وكلاهما يقرأ ملفات `data/` مباشرة عند التشغيل.

## مصدر الحقيقة الواحد

**ملفات `data/*.json` في GitHub هي المكان الوحيد الذي يُعدَّل فيه محتوى الأدلة.**
كل ما سواها نسخ تُولَّد منها:

```
data/*.json (GitHub) ──► supabase/payloads ──► قاعدة Supabase
        │
        └──────────────► واجهة الويب وموصّل MCP (يقرآن الملفات مباشرة)
```

- لتصحيح خطأ في دليل: عدّل ملفه في `data/` بطلب دمج، ثم `npm run build-payloads`.
  بعد الدمج تُحدَّث القاعدة (الجدول اليومي يستورد ما دُمج).
- لا تعدّل محتوى الأدلة في Supabase مباشرة، ولا تضمّن البيانات داخل `index.html`.
- `npm run check-drift` يتحقق أن النسخة الحالية لكل دليل في القاعدة مطابقة للمستودع
  (أو `npm run check-drift -- --sql` لطباعة استعلام يُشغَّل في محرر SQL).

## بنية قاعدة البيانات

```
guides           الدليل (رمز، اسم، اسم مختصر للاستشهاد، نوع)
└─ guide_versions  نسخة من الدليل (إصدار، تاريخ، بصمة الملف، عدد الصفحات، is_current)
   └─ sections       أقسام شجرية (level 1 → level 2)، مع صفحة البداية والنهاية
      └─ content_blocks  عناصر المحتوى: step, raci, policy, input, output, form,
                         kpi, article, task, system, note (+ metadata jsonb)
```

- لكل دليل نسخة حالية واحدة فقط (`is_current`)، وتبقى النسخ القديمة إن اختلف إصدارها.
- `note` تُميَّز بـ `metadata.kind`، مثل `related_procedure`، `org_link`، `qualification`، `member`، `staffing`.
- القراءة متاحة للجميع (RLS)، والكتابة لمفتاح `service_role` فقط.
- المخطط كاملاً في `supabase/migrations/`.

### دوال جاهزة

| الدالة | الاستخدام |
|---|---|
| `search_guides(q, guide default null, max_results default 20)` | بحث في النسخ الحالية لكل الأدلة (أو دليل واحد)، ويرجع النص والاستشهاد |
| `get_citation(block_id)` | نص الاستشهاد، مثل «دليل الإجراءات، ص 15، بند س-1-ا-1» |
| `import_guide(payload, force default false)` | يستورد دليلاً كاملاً في معاملة واحدة (service_role فقط) |

```sql
select guide_code, left(text_content, 60), citation from search_guides('الخطة التشغيلية');
select * from search_guides('رئيس اللجنة', 'org_manual', 10);
```

ومن التطبيق: `supabase.rpc('search_guides', { q: 'الخطة التشغيلية' })`.

## الاستيراد

```bash
npm install
cp .env.example .env                  # ضع SUPABASE_SERVICE_ROLE_KEY
npm run import-supabase               # كل الأدلة
npm run import-supabase -- org_manual # دليل واحد
npm run import-supabase -- --dry-run  # فحص بدون كتابة
```

- إعادة التشغيل آمنة: إذا استُورد الملف نفسه من قبل (نفس البصمة) يتخطاه.
  استعمل `--force` لإعادة استيراده.
- ملف جديد بنفس الإصدار يحلّ محل النسخة السابقة، وإصدار جديد يُضاف ويصبح هو الحالي.
- لاستيراد ملف آخر لنفس الدليل:
  `npm run import-supabase -- procedures_manual --file procedures-db.json`

### بدون مفتاح (من محرر SQL في Supabase)

`npm run build-payloads` يكتب حمولة كل دليل في `supabase/payloads/`. بعد رفعها
إلى GitHub يمكن استيرادها من محرر SQL:

```sql
create extension if not exists http with schema extensions;
select import_guide(content::jsonb)
  from extensions.http_get('https://raw.githubusercontent.com/azizmoheelmo-ai/Procedures/<commit>/supabase/payloads/org_manual.json');
drop extension http;
```

## إضافة دليل جديد

1. ضع ملف بيانات الدليل في `data/` (JSON).
2. اكتب محوّلاً في `scripts/guides/<name>.mjs` يصدّر
   `{ code, source, build(raw, file) }`، حيث تُرجع `build` حمولة بالشكل الموضّح
   في `scripts/guides/payload.mjs` (الدليل، النسخة، الأقسام وعناصرها). الدوال
   `section()` و`block()` هناك تبني الأقسام والعناصر.
3. أضفه إلى `scripts/guides/index.mjs`.
4. `npm run import-supabase -- <code> --dry-run` للفحص، ثم بدون `--dry-run` للاستيراد.

لا يحتاج الدليل الجديد أي تعديل على الجداول. إن احتاج نوع عنصر جديد فالأفضل
استعمال `note` مع `metadata.kind` بدل تعديل قيد `block_type`.
