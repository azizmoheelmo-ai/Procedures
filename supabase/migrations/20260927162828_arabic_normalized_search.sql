-- ============================================================================
-- بحث عربي مطبَّع: يوحّد الهمزات والتاء المربوطة والألف المقصورة، ويزيل
-- التشكيل والتطويل، ويُسقط أداة التعريف (مع سوابق الواو/الباء/اللام/الفاء).
-- التطبيع يُطبَّق على النص المخزَّن (عمود مولَّد) وعلى نص البحث بنفس الدالة،
-- فلا يفترق الاثنان أبداً.
-- ============================================================================

create or replace function public.arabic_normalize(txt text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select regexp_replace(
    translate(
      regexp_replace(coalesce(txt, ''), '[ؐ-ًؚ-ٰٟۖ-ۭـ]', '', 'g'),
      'أإآىة', 'ااايه'
    ),
    '\m[وبلف]?ال', '', 'g'
  )
$$;

-- النص المطبَّع ومتجه بحثه، على عناصر المحتوى (حيث يبحث search_guides).
alter table content_blocks
  add column text_normalized text generated always as (arabic_normalize(text_content)) stored;

alter table content_blocks
  add column search_vector_norm tsvector generated always as (to_tsvector('simple', arabic_normalize(text_content))) stored;

create index content_blocks_search_norm_idx on content_blocks using gin (search_vector_norm);
create index content_blocks_trgm_norm_idx on content_blocks using gin (text_normalized extensions.gin_trgm_ops);

-- تطابق كامل عبر النص المطبَّع أولاً، ثم تقارب تقريبي (pg_trgm) عند قلة النتائج،
-- ودائماً بعد التطابق الكامل في الترتيب.
create or replace function public.search_guides(q text, guide text default null, max_results int default 20)
returns table (
  guide_code text,
  guide_name text,
  section_code text,
  section_title text,
  block_id uuid,
  block_type text,
  text_content text,
  page int,
  citation text,
  rank real
)
language sql
stable
set search_path = public, pg_temp
as $$
  with params as (
    select least(greatest(coalesce(max_results, 20), 1), 100) as lim,
           arabic_normalize(q) as nq,
           plainto_tsquery('simple', arabic_normalize(q)) as tsq
  ),
  full_hits as (
    select g.code as guide_code, g.short_name as guide_name, s.code as section_code, s.title as section_title,
           cb.id as block_id, cb.block_type, cb.text_content, coalesce(cb.page, s.page_start) as page,
           get_citation(cb.id) as citation, ts_rank(cb.search_vector_norm, params.tsq) as rank, 0 as phase
      from params, content_blocks cb
      join sections s on s.id = cb.section_id
      join guide_versions gv on gv.id = s.guide_version_id and gv.is_current
      join guides g on g.id = gv.guide_id
     where cb.search_vector_norm @@ params.tsq
       and (search_guides.guide is null or g.code = search_guides.guide)
       and cb.metadata->>'kind' is distinct from 'raw_text'
     order by rank desc, g.code, s.order_index, cb.seq
     limit (select lim from params)
  ),
  fallback_hits as (
    select g.code as guide_code, g.short_name as guide_name, s.code as section_code, s.title as section_title,
           cb.id as block_id, cb.block_type, cb.text_content, coalesce(cb.page, s.page_start) as page,
           get_citation(cb.id) as citation, extensions.similarity(cb.text_normalized, params.nq) as rank, 1 as phase
      from params, content_blocks cb
      join sections s on s.id = cb.section_id
      join guide_versions gv on gv.id = s.guide_version_id and gv.is_current
      join guides g on g.id = gv.guide_id
     where (select count(*) from full_hits) < (select lim from params)
       and extensions.similarity(cb.text_normalized, params.nq) > 0.3
       and cb.id not in (select block_id from full_hits)
       and (search_guides.guide is null or g.code = search_guides.guide)
       and cb.metadata->>'kind' is distinct from 'raw_text'
     order by rank desc
     limit (select lim from params) - (select count(*) from full_hits)
  )
  select guide_code, guide_name, section_code, section_title, block_id, block_type, text_content, page, citation, rank
    from (select * from full_hits union all select * from fallback_hits) z
   order by phase, rank desc
   limit (select lim from params);
$$;

grant execute on function public.search_guides(text, text, int) to anon, authenticated, service_role;
grant execute on function public.arabic_normalize(text) to anon, authenticated, service_role;
