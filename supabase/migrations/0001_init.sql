-- ===========================================================================
-- BODYiQ AI Assistant — initial schema
-- pgvector-backed document store for RAG over blog posts, products, policies.
-- ===========================================================================

-- 1. Extensions -------------------------------------------------------------
-- pgvector powers similarity search. On Supabase this lives in the `extensions`
-- schema; `create extension if not exists` is idempotent.
create extension if not exists vector;

-- 2. Enums ------------------------------------------------------------------
-- Guard against re-running: only create the enum if it doesn't already exist.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_source_type') then
    create type document_source_type as enum ('blog', 'product', 'policy');
  end if;
end
$$;

-- 3. Documents table --------------------------------------------------------
-- One row per *chunk*. A single blog article typically produces several rows,
-- all sharing the same source_handle. voyage-3 emits 1024-dim vectors.
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  content       text                  not null,
  embedding     vector(1024)          not null,
  source_type   document_source_type  not null,
  source_url    text,
  -- Handle of the entity this chunk belongs to (e.g. blog article handle,
  -- product handle). Multiple chunks share one handle.
  source_handle text,
  -- For BODYiQ's topic-cluster content model: a "child" article points at its
  -- pillar/parent article via parent_handle so retrieval can pull sibling
  -- context. Null for pillar articles, products, and policies.
  parent_handle text,
  -- Free-form: chunk_index, heading, article title, published_at, price, etc.
  metadata      jsonb                 not null default '{}'::jsonb,
  created_at    timestamptz           not null default now(),
  updated_at    timestamptz           not null default now()
);

-- Fast lookups when re-embedding or deleting all chunks for one source.
create index if not exists documents_source_handle_idx
  on public.documents (source_handle);
create index if not exists documents_parent_handle_idx
  on public.documents (parent_handle);
create index if not exists documents_source_type_idx
  on public.documents (source_type);

-- 4. Vector index -----------------------------------------------------------
-- ivfflat with cosine distance. `lists` is a tuning knob: rule of thumb is
-- rows/1000 (min 1). With ~106 posts × a few chunks each we're in the low
-- thousands of rows, so a small list count is appropriate. Re-tune (and
-- re-index) as the corpus grows. IMPORTANT: ivfflat needs data present to build
-- a good index — if you build on an empty table, reindex after backfill.
create index if not exists documents_embedding_ivfflat_idx
  on public.documents
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 10);

-- 5. updated_at trigger -----------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
-- Pin search_path so the function isn't role-mutable (security hardening).
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

-- 6. Similarity search RPC --------------------------------------------------
-- Called from the app via supabase.rpc('match_documents', {...}).
-- Returns cosine *similarity* (1 - distance) as `similarity`, filtered by an
-- optional source_type and a minimum similarity threshold.
--
-- The `<=>` operator is cosine DISTANCE (0 = identical, 2 = opposite), so
-- similarity = 1 - distance. We order by distance ascending (closest first).
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
-- Pin search_path so the function isn't role-mutable (security hardening).
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

-- 7. Row Level Security -----------------------------------------------------
-- The app only ever hits this table with the service-role key (server-side),
-- which bypasses RLS. We still enable RLS and add NO permissive policies so
-- that the anon/public key can never read or write documents directly.
alter table public.documents enable row level security;
