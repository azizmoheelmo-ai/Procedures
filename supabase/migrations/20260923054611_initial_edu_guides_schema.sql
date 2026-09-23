-- ============================================================================
-- مخطط قاعدة بيانات موحّدة لمنصة "أدلة وزارة التعليم" (EduGuidesHub)
-- يدعم: دليل الإجراءات، اللوائح (سلوك/مواظبة/انضباط)، الأدلة التنظيمية،
--        الوصف الوظيفي، وأي دليل جديد — بدون تعديل بنية الجداول لاحقاً.
-- المتطلبات المعتمدة: استشهاد دقيق (صفحة/بند) لكل إجابة + نسخ متعددة عبر
--        الزمن (تحديثات الوزارة) + وصول عام مجاني للقراءة فقط.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists pg_trgm;

-- 1) guides
create table guides (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  name_ar      text not null,
  short_name   text,
  guide_type   text not null check (guide_type in (
                  'procedures', 'regulation', 'job_description', 'org_structure', 'other'
                )),
  authority    text default 'وزارة التعليم - الإدارة العامة للتطوير التنظيمي',
  description  text,
  created_at   timestamptz not null default now()
);

-- 2) guide_versions
create table guide_versions (
  id             uuid primary key default gen_random_uuid(),
  guide_id       uuid not null references guides(id) on delete cascade,
  version_label  text not null,
  issue_date     date,
  source_file    text,
  source_hash    text,
  total_pages    int,
  is_current     boolean not null default false,
  imported_at    timestamptz not null default now(),
  unique (guide_id, version_label)
);

create unique index one_current_version_per_guide
  on guide_versions (guide_id)
  where is_current;

-- 3) sections
create table sections (
  id                uuid primary key default gen_random_uuid(),
  guide_version_id  uuid not null references guide_versions(id) on delete cascade,
  parent_id         uuid references sections(id) on delete cascade,
  code              text,
  title             text not null,
  level             int not null default 1,
  order_index       int not null default 0,
  page_start        int,
  page_end          int,
  owner_role        text,
  objective         text,
  scope             text,
  created_at        timestamptz not null default now()
);

create index sections_guide_version_idx on sections(guide_version_id);
create index sections_parent_idx on sections(parent_id);

-- 4) content_blocks
create table content_blocks (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references sections(id) on delete cascade,
  block_type   text not null check (block_type in (
                  'step', 'raci', 'policy', 'input', 'output', 'form',
                  'kpi', 'article', 'task', 'system', 'note'
                )),
  seq          int,
  text_content text not null,
  page         int,
  metadata     jsonb default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index content_blocks_section_idx on content_blocks(section_id);
create index content_blocks_type_idx on content_blocks(block_type);
create index content_blocks_metadata_gin on content_blocks using gin (metadata);

-- 5) بحث عربي
alter table sections add column search_vector tsvector
  generated always as (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(objective,'') || ' ' || coalesce(code,''))
  ) stored;

alter table content_blocks add column search_vector tsvector
  generated always as (to_tsvector('simple', coalesce(text_content,''))) stored;

create index sections_search_idx on sections using gin (search_vector);
create index content_blocks_search_idx on content_blocks using gin (search_vector);
create index content_blocks_trgm_idx on content_blocks using gin (text_content gin_trgm_ops);
create index sections_title_trgm_idx on sections using gin (title gin_trgm_ops);

-- 6) دالة استشهاد
create or replace function get_citation(block_id uuid)
returns text
language sql
stable
as $$
  select g.short_name || '، ص ' || coalesce(cb.page, s.page_start) ||
         case when s.code is not null then '، بند ' || s.code else '' end
  from content_blocks cb
  join sections s on s.id = cb.section_id
  join guide_versions gv on gv.id = s.guide_version_id
  join guides g on g.id = gv.guide_id
  where cb.id = block_id;
$$;

-- 7) RLS: قراءة عامة، كتابة service_role فقط
alter table guides enable row level security;
alter table guide_versions enable row level security;
alter table sections enable row level security;
alter table content_blocks enable row level security;

create policy "public read guides" on guides for select using (true);
create policy "public read guide_versions" on guide_versions for select using (true);
create policy "public read sections" on sections for select using (true);
create policy "public read content_blocks" on content_blocks for select using (true);
