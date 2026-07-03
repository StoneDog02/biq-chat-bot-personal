-- ===========================================================================
-- Security hardening: pin search_path on functions.
--
-- Supabase's linter flags functions with a role-mutable search_path
-- (lint 0011_function_search_path_mutable). Re-declare both functions with a
-- fixed `search_path = public` so they can't be hijacked via search_path.
-- Idempotent (create or replace); already folded into 0001 for fresh installs.
-- ===========================================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.match_documents (
  query_embedding vector(1024),
  match_count     int    default 8,
  match_threshold float  default 0.0,
  filter_source_type text default null
)
returns table (
  id            uuid,
  content       text,
  source_type   document_source_type,
  source_url    text,
  source_handle text,
  parent_handle text,
  metadata      jsonb,
  similarity    float
)
language sql
stable
set search_path = public
as $$
  select
    d.id,
    d.content,
    d.source_type,
    d.source_url,
    d.source_handle,
    d.parent_handle,
    d.metadata,
    1 - (d.embedding <=> query_embedding) as similarity
  from public.documents d
  where
    (filter_source_type is null
      or d.source_type = filter_source_type::document_source_type)
    and (1 - (d.embedding <=> query_embedding)) >= match_threshold
  order by d.embedding <=> query_embedding
  limit greatest(match_count, 1);
$$;
