// ===========================================================================
// Query -> embedding -> vector search -> assembled context + citations.
//
// CLUSTER-AWARE RETRIEVAL BIAS (the interesting part):
//   Plain top-k cosine search ignores *where the shopper is* and *how BODYiQ's
//   content is organized*. We improve relevance two ways:
//
//   1. Page bias — when the widget passes pageContext (e.g. the shopper is on a
//      specific product or article), we nudge matches from that same entity or
//      content type to the top. The shopper's question is almost always "about
//      the thing in front of them," so a small, capped boost meaningfully
//      improves perceived relevance without drowning out a clearly better
//      cross-topic match.
//
//   2. Cluster (sibling) pull — BODYiQ's blog is a set of topic clusters: a
//      pillar article plus children that all share a parent_handle. Once we
//      identify the "focus cluster" from the strongest blog match, we boost its
//      siblings/pillar so the model gets coherent context from across the whole
//      cluster instead of several near-duplicate chunks of one article.
//
//   Both are implemented as bounded re-ranking over a deliberately WIDE
//   candidate pool (so siblings are actually present to be boosted), never as
//   hard filters — a great off-topic answer can still win.
// ===========================================================================

import { embedQuery } from "./embeddings";
import { similaritySearch } from "./supabase";
import type {
  Citation,
  MatchedDocument,
  PageContext,
  RetrievalResult,
} from "./types";

// Pool/selection sizes.
const CANDIDATE_LIMIT = 16; // wide pool so cluster siblings show up to be boosted
const TOP_K = 6; // chunks actually injected into the prompt
const MATCH_THRESHOLD = 0.3; // minimum cosine similarity to consider at all

// Re-ranking boosts (added to a base cosine similarity in [~0,1]).
const BOOST_SAME_HANDLE = 0.12; // match is literally the page's product/article
const BOOST_SAME_CLUSTER = 0.08; // match shares the page's (or focus) cluster
const BOOST_SAME_TYPE = 0.04; // match is the same source_type as the page

interface ScoredMatch extends MatchedDocument {
  score: number;
}

/** The cluster a chunk belongs to: its pillar handle, else its own handle. */
function clusterHandleOf(m: MatchedDocument): string | null {
  return m.parent_handle ?? m.source_handle ?? null;
}

/**
 * Embed the query, gather a wide candidate pool (optionally biased toward the
 * page's source_type), re-rank with page + cluster boosts, and assemble the
 * context string and citations from the top matches.
 */
export async function buildContext(
  query: string,
  pageContext?: PageContext,
): Promise<RetrievalResult> {
  const queryEmbedding = await embedQuery(query);

  // --- Gather candidates ---------------------------------------------------
  // Always run a broad search. If we know the page's content type, run a
  // second search scoped to that type and merge, guaranteeing on-type coverage
  // even when the corpus is dominated by another type.
  const searches: Promise<MatchedDocument[]>[] = [
    similaritySearch(queryEmbedding, {
      limit: CANDIDATE_LIMIT,
      matchThreshold: MATCH_THRESHOLD,
    }),
  ];
  if (pageContext?.type) {
    searches.push(
      similaritySearch(queryEmbedding, {
        sourceType: pageContext.type,
        limit: Math.ceil(CANDIDATE_LIMIT / 2),
        matchThreshold: MATCH_THRESHOLD,
      }),
    );
  }

  const merged = new Map<string, MatchedDocument>();
  for (const results of await Promise.all(searches)) {
    for (const m of results) if (!merged.has(m.id)) merged.set(m.id, m);
  }
  const candidates = [...merged.values()];
  if (candidates.length === 0) {
    return { context: "", citations: [], matches: [] };
  }

  // --- Identify the focus cluster -----------------------------------------
  // Prefer the page's own cluster; otherwise fall back to the cluster of the
  // best-scoring blog match so we still pull coherent sibling context.
  const bestBlog = candidates
    .filter((m) => m.source_type === "blog")
    .sort((a, b) => b.similarity - a.similarity)[0];
  const focusCluster =
    (pageContext?.type === "blog" ? pageContext.handle : undefined) ??
    (bestBlog ? clusterHandleOf(bestBlog) : null);

  // --- Re-rank -------------------------------------------------------------
  const scored: ScoredMatch[] = candidates.map((m) => {
    let score = m.similarity;

    if (pageContext?.handle) {
      if (m.source_handle === pageContext.handle) score += BOOST_SAME_HANDLE;
      // Children of the page (page is a pillar) or the page's own pillar.
      else if (m.parent_handle === pageContext.handle) score += BOOST_SAME_CLUSTER;
    }
    if (pageContext?.type && m.source_type === pageContext.type) {
      score += BOOST_SAME_TYPE;
    }
    // Sibling pull: anything in the focus cluster gets a nudge so a coherent
    // slice of the cluster surfaces rather than one article's chunks only.
    if (
      focusCluster &&
      m.source_handle !== pageContext?.handle &&
      clusterHandleOf(m) === focusCluster
    ) {
      score += BOOST_SAME_CLUSTER;
    }

    return { ...m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, TOP_K);

  // --- Assemble context + citations ---------------------------------------
  const context = top
    .map((m, i) => {
      const label = m.metadata.title || m.metadata.heading || m.source_handle || "Source";
      return `[Source ${i + 1}] ${label} (${m.source_type})\n${m.content}`;
    })
    .join("\n\n---\n\n");

  const citations = dedupeCitations(top);

  return { context, citations, matches: top };
}

/** Build citation cards (one per unique URL), preserving rank order. */
function dedupeCitations(matches: ScoredMatch[]): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];

  for (const m of matches) {
    if (!m.source_url) continue; // nothing to link to
    if (seen.has(m.source_url)) continue;
    seen.add(m.source_url);

    citations.push({
      title: m.metadata.title || m.metadata.heading || m.source_handle || "Learn more",
      url: m.source_url,
      sourceType: m.source_type,
    });
  }
  return citations;
}
