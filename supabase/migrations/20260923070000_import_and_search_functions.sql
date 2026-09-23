-- ============================================================================
-- import_guide(): يستورد دليلاً كاملاً من حمولة JSON واحدة داخل معاملة واحدة
--   (إما يدخل كل شيء أو لا شيء). الحمولة تبنيها scripts/guides/*.mjs.
-- search_guides(): بحث نصي موحّد عبر النسخ الحالية لكل الأدلة مع الاستشهاد.
-- ============================================================================

create or replace function public.import_guide(payload jsonb, force boolean default false)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  g jsonb := payload->'guide';
  v jsonb := payload->'version';
  gid uuid;
  vid uuid;
  existing uuid;
  n_sections int;
  n_blocks int;
  n_level1 int;
  n_level2 int;
begin
  if payload->>'format' is distinct from '1' then
    raise exception 'unsupported payload format: %', payload->>'format';
  end if;

  insert into guides (code, name_ar, short_name, guide_type, description)
  values (g->>'code', g->>'name_ar', g->>'short_name', g->>'guide_type', g->>'description')
  on conflict (code) do update
    set name_ar = excluded.name_ar,
        short_name = excluded.short_name,
        guide_type = excluded.guide_type,
        description = coalesce(excluded.description, guides.description)
  returning id into gid;
  if g ? 'authority' then
    update guides set authority = g->>'authority' where id = gid;
  end if;

  -- Same source already imported → nothing to do unless forced.
  select id into existing from guide_versions where guide_id = gid and source_hash = v->>'source_hash';
  if existing is not null and not force then
    return jsonb_build_object('status', 'skipped', 'guide', g->>'code', 'version_id', existing);
  end if;
  delete from guide_versions
   where guide_id = gid and (source_hash = v->>'source_hash' or version_label = v->>'version_label');

  insert into guide_versions (guide_id, version_label, issue_date, source_file, source_hash, total_pages, is_current)
  values (gid, v->>'version_label', (v->>'issue_date')::date, v->>'source_file', v->>'source_hash',
          (v->>'total_pages')::int, false)
  returning id into vid;

  create temp table if not exists _import_sections (key text primary key, id uuid not null, j jsonb not null)
    on commit drop;
  truncate _import_sections;
  insert into _import_sections
  select s->>'key', gen_random_uuid(), s from jsonb_array_elements(payload->'sections') s;

  if exists (select 1 from _import_sections t
              where t.j->>'parent_key' is not null
                and not exists (select 1 from _import_sections p where p.key = t.j->>'parent_key')) then
    raise exception 'a section refers to an unknown parent_key';
  end if;

  insert into sections (id, guide_version_id, parent_id, code, title, level, order_index,
                        page_start, page_end, owner_role, objective, scope)
  select t.id, vid, p.id, t.j->>'code', t.j->>'title', coalesce((t.j->>'level')::int, 1),
         coalesce((t.j->>'order_index')::int, 0), (t.j->>'page_start')::int, (t.j->>'page_end')::int,
         t.j->>'owner_role', t.j->>'objective', t.j->>'scope'
    from _import_sections t
    left join _import_sections p on p.key = t.j->>'parent_key';
  get diagnostics n_sections = row_count;

  insert into content_blocks (section_id, block_type, seq, text_content, page, metadata)
  select t.id, b->>'block_type', (b->>'seq')::int, b->>'text_content', (b->>'page')::int,
         coalesce(b->'metadata', '{}'::jsonb)
    from _import_sections t, jsonb_array_elements(coalesce(t.j->'blocks', '[]'::jsonb)) b;
  get diagnostics n_blocks = row_count;

  -- Optional sanity counts from the adapter.
  select count(*) filter (where level = 1), count(*) filter (where level = 2)
    into n_level1, n_level2
    from sections where guide_version_id = vid;
  if (payload->'expected' ? 'level1' and (payload->'expected'->>'level1')::int <> n_level1)
     or (payload->'expected' ? 'level2' and (payload->'expected'->>'level2')::int <> n_level2) then
    raise exception 'count check failed: level1 % (expected %), level2 % (expected %)',
      n_level1, payload->'expected'->>'level1', n_level2, payload->'expected'->>'level2';
  end if;

  -- Two steps: one_current_version_per_guide is checked row by row.
  update guide_versions set is_current = false where guide_id = gid and id <> vid and is_current;
  update guide_versions set is_current = true where id = vid;

  return jsonb_build_object(
    'status', 'imported',
    'guide', g->>'code',
    'version_id', vid,
    'sections', n_sections,
    'level1', n_level1,
    'level2', n_level2,
    'blocks', n_blocks,
    'by_type', (select jsonb_object_agg(block_type, n order by block_type)
                  from (select cb.block_type, count(*) n
                          from content_blocks cb join sections s on s.id = cb.section_id
                         where s.guide_version_id = vid group by 1) z)
  );
end;
$$;

-- Writing is for the service role only (the import script); readers keep RLS read access.
revoke all on function public.import_guide(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.import_guide(jsonb, boolean) to service_role;


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
  select g.code, g.short_name, s.code, s.title, cb.id, cb.block_type, cb.text_content,
         coalesce(cb.page, s.page_start), get_citation(cb.id), ts_rank(cb.search_vector, query)
    from websearch_to_tsquery('simple', q) as query
    join content_blocks cb on cb.search_vector @@ query
    join sections s on s.id = cb.section_id
    join guide_versions gv on gv.id = s.guide_version_id and gv.is_current
    join guides g on g.id = gv.guide_id
   where (search_guides.guide is null or g.code = search_guides.guide)
     and cb.metadata->>'kind' is distinct from 'raw_text'
   order by ts_rank(cb.search_vector, query) desc, g.code, s.order_index, cb.seq
   limit least(greatest(coalesce(max_results, 20), 1), 100);
$$;

grant execute on function public.search_guides(text, text, int) to anon, authenticated, service_role;
