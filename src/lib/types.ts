// ===========================================================================
// Shared types for the BODYiQ AI assistant backend.
// ===========================================================================

/** Kind of content a stored document/chunk was derived from. */
export type SourceType = "blog" | "product" | "policy";

/**
 * A single retrievable chunk as stored in Supabase. Mirrors the `documents`
 * table (minus the raw embedding, which we never round-trip to the client).
 */
export interface DocumentRecord {
  id?: string;
  content: string;
  sourceType: SourceType;
  sourceUrl?: string | null;
  sourceHandle?: string | null;
  /** Pillar article handle for topic-cluster children; null otherwise. */
  parentHandle?: string | null;
  metadata: DocumentMetadata;
}

/** A DocumentRecord together with its embedding, ready to upsert. */
export interface EmbeddedDocument extends DocumentRecord {
  embedding: number[];
}

/**
 * Free-form per-chunk metadata. We keep a few well-known keys typed for
 * ergonomics but allow arbitrary extras (stored as jsonb).
 */
export interface DocumentMetadata {
  title?: string;
  heading?: string;
  /** 0-based position of this chunk within its source document. */
  chunkIndex?: number;
  /** Total chunks the source produced (useful for reassembly / debugging). */
  chunkTotal?: number;
  publishedAt?: string;
  /** Product-only: current price snapshot at embed time (display convenience). */
  price?: string;
  [key: string]: unknown;
}

/** Result row returned by the match_documents RPC. */
export interface MatchedDocument {
  id: string;
  content: string;
  source_type: SourceType;
  source_url: string | null;
  source_handle: string | null;
  parent_handle: string | null;
  metadata: DocumentMetadata;
  similarity: number;
}

/** Options accepted by supabase.similaritySearch. */
export interface SimilaritySearchOptions {
  sourceType?: SourceType;
  limit?: number;
  matchThreshold?: number;
}

/** A citation surfaced to the widget so it can render a source card. */
export interface Citation {
  title: string;
  url: string;
  sourceType: SourceType;
}

/** Where in the storefront the widget was mounted (drives retrieval bias). */
export interface PageContext {
  /** 'product' on a PDP, 'blog' on an article, undefined elsewhere. */
  type?: SourceType;
  /** Product handle or article handle for the current page. */
  handle?: string;
}

/** A single turn of conversation as sent by the widget. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Request body accepted by POST /api/chat. */
export interface ChatRequestBody {
  message: string;
  conversationHistory?: ChatMessage[];
  pageContext?: PageContext;
}

/** Assembled retrieval result handed to the model + widget. */
export interface RetrievalResult {
  /** Formatted context block injected into the system/user prompt. */
  context: string;
  citations: Citation[];
  /** Raw matches, exposed for logging/debugging. */
  matches: MatchedDocument[];
}
