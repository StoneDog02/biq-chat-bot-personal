// ===========================================================================
// Supabase client + document persistence + pgvector similarity search.
//
// This module is SERVER-ONLY. It uses the service-role key, which bypasses RLS.
// Never import it into client/widget code.
// ===========================================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  EmbeddedDocument,
  MatchedDocument,
  SimilaritySearchOptions,
} from "./types";

let client: SupabaseClient | null = null;

/** Lazily-instantiated singleton so we don't create a client at import time. */
export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    // TODO: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set",
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Map our camelCase domain object onto the snake_case table columns. */
function toRow(doc: EmbeddedDocument) {
  return {
    ...(doc.id ? { id: doc.id } : {}),
    content: doc.content,
    embedding: doc.embedding,
    source_type: doc.sourceType,
    source_url: doc.sourceUrl ?? null,
    source_handle: doc.sourceHandle ?? null,
    parent_handle: doc.parentHandle ?? null,
    metadata: doc.metadata ?? {},
  };
}

/**
 * Insert or update a single document + embedding. If `doc.id` is present the
 * row is updated (upsert on primary key); otherwise a new row is inserted.
 */
export async function upsertDocument(doc: EmbeddedDocument): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .upsert(toRow(doc), { onConflict: "id" });
  if (error) throw new Error(`upsertDocument failed: ${error.message}`);
}

/** Batch insert helper used by the re-embed / backfill flows. */
export async function insertDocuments(docs: EmbeddedDocument[]): Promise<void> {
  if (docs.length === 0) return;
  const { error } = await getSupabase()
    .from("documents")
    .insert(docs.map(toRow));
  if (error) throw new Error(`insertDocuments failed: ${error.message}`);
}

/** Remove every chunk previously stored for a given source handle. */
export async function deleteDocumentsBySourceHandle(
  sourceHandle: string,
): Promise<void> {
  const { error } = await getSupabase()
    .from("documents")
    .delete()
    .eq("source_handle", sourceHandle);
  if (error) {
    throw new Error(`deleteDocumentsBySourceHandle failed: ${error.message}`);
  }
}

/**
 * Idempotent re-ingest for chunked content: because one article maps to many
 * chunks (with no stable per-chunk key), the correct "upsert" for a source is
 * delete-all-then-insert. Used by the webhook and backfill paths so re-running
 * never leaves stale chunks behind.
 */
export async function replaceSourceDocuments(
  sourceHandle: string,
  docs: EmbeddedDocument[],
): Promise<void> {
  await deleteDocumentsBySourceHandle(sourceHandle);
  await insertDocuments(docs);
}

/**
 * Top-k cosine similarity search via the match_documents RPC.
 * Returns matches ordered most-similar first.
 */
export async function similaritySearch(
  queryEmbedding: number[],
  opts: SimilaritySearchOptions = {},
): Promise<MatchedDocument[]> {
  const { sourceType, limit = 8, matchThreshold = 0 } = opts;

  const { data, error } = await getSupabase().rpc("match_documents", {
    query_embedding: queryEmbedding,
    match_count: limit,
    match_threshold: matchThreshold,
    filter_source_type: sourceType ?? null,
  });

  if (error) throw new Error(`similaritySearch failed: ${error.message}`);
  return (data ?? []) as MatchedDocument[];
}
