-- تثبيت search_path للدالة (يمنع اختطاف المسار)
alter function public.get_citation(uuid) set search_path = public, pg_temp;

-- نقل pg_trgm من public إلى مخطط extensions مخصص (ممارسة أفضل أمنياً)
create schema if not exists extensions;
alter extension pg_trgm set schema extensions;
