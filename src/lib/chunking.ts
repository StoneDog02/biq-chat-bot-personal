// ===========================================================================
// Blog post -> semantically coherent chunks.
//
// CHUNKING STRATEGY (why it looks the way it does):
//   1. We split on HTML headings first. Headings are the author's own semantic
//      boundaries, so a chunk never straddles two topics. Each chunk carries a
//      breadcrumb ("<Article Title> — <Heading>") at the top so the embedding
//      captures *where* in the article the text came from — critical when a
//      short passage would otherwise be ambiguous out of context.
//   2. Within a section we greedily pack paragraphs (falling back to sentences
//      for oversized paragraphs) into ~300-500 token windows. Chunks that are
//      too small retrieve poorly (not enough signal); chunks that are too large
//      dilute the embedding and waste the model's context budget. 300-500 is a
//      good middle ground for prose.
//   3. Token counts are ESTIMATED at ~4 chars/token. This is deliberately
//      dependency-free; it's close enough for windowing and we never rely on it
//      for billing. Swap in a real tokenizer later if precision matters.
//
// CLUSTER AWARENESS:
//   BODYiQ's blog is organized as topic clusters (a "pillar" article with
//   several "child" articles linking back to it). Each chunk records the
//   article's `parentHandle` (the pillar's handle). We do NOT flatten the
//   hierarchy into the text; instead retrieval.ts uses parent_handle to
//   optionally pull sibling/pillar context around a strong match.
// ===========================================================================

import type { DocumentRecord } from "./types";

/** Minimal article shape needed to chunk. Shopify types map onto this. */
export interface ChunkableArticle {
  handle: string;
  title: string;
  /** Raw article body HTML (Shopify `Article.body`/`bodyHtml`). */
  contentHtml: string;
  /** Canonical public URL of the article on bodyiq.com. */
  url: string;
  publishedAt?: string;
  /** Pillar article handle if this is a cluster child; null/undefined if not. */
  parentHandle?: string | null;
}

// Token windows (see strategy note above). Char thresholds derive from these.
const TARGET_TOKENS = 400;
const MAX_TOKENS = 500;
const MIN_TOKENS = 120;
const CHARS_PER_TOKEN = 4;

/** Rough token estimate. Good enough for windowing; not for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// --- HTML helpers ----------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201C",
  rdquo: "\u201D",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1]?.toLowerCase() === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Strip tags to readable plain text, preserving paragraph/list breaks. */
function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "\u2022 ")
      .replace(
        /<\/(p|div|li|ul|ol|blockquote|section|article|table|tr|h[1-6])>/gi,
        "\n\n",
      )
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface Section {
  heading: string | null;
  text: string;
}

/**
 * Split article HTML into sections keyed by their preceding heading. Text
 * before the first heading becomes an intro section (heading = null).
 */
function splitIntoSections(html: string): Section[] {
  // Drop script/style blocks entirely before parsing.
  const clean = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const headingRe = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;

  const sections: Section[] = [];
  let lastIndex = 0;
  let currentHeading: string | null = null;
  let match: RegExpExecArray | null;

  while ((match = headingRe.exec(clean)) !== null) {
    const bodyBefore = clean.slice(lastIndex, match.index);
    sections.push({ heading: currentHeading, text: stripHtml(bodyBefore) });
    currentHeading = stripHtml(match[1]) || null;
    lastIndex = headingRe.lastIndex;
  }
  sections.push({ heading: currentHeading, text: stripHtml(clean.slice(lastIndex)) });

  return sections.filter((s) => s.text.length > 0 || s.heading);
}

// --- Packing ---------------------------------------------------------------

/** Split an oversized paragraph into sentences (best-effort). */
function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  return (matches ?? [paragraph]).map((s) => s.trim()).filter(Boolean);
}

/** Break section text into pack units: paragraphs, or sentences if too big. */
function toUnits(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const units: string[] = [];
  for (const p of paragraphs) {
    if (estimateTokens(p) <= MAX_TOKENS) units.push(p);
    else units.push(...splitSentences(p));
  }
  return units;
}

/** Greedily combine units into TARGET..MAX token chunks. */
function packUnits(units: string[]): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;

    if (estimateTokens(candidate) <= MAX_TOKENS) {
      current = candidate;
      // Flush once we've hit the target so chunks stay tight.
      if (estimateTokens(current) >= TARGET_TOKENS) {
        chunks.push(current);
        current = "";
      }
    } else {
      if (current) chunks.push(current);
      // A single unit larger than MAX (rare, e.g. one giant sentence) has to
      // stand alone even if it slightly exceeds the window.
      current = unit;
      if (estimateTokens(current) > MAX_TOKENS) {
        chunks.push(current);
        current = "";
      }
    }
  }
  if (current.trim()) chunks.push(current);

  // Fold a tiny trailing chunk back into its predecessor if it fits — avoids
  // low-signal orphan chunks like a lone closing sentence.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (
      estimateTokens(last) < MIN_TOKENS &&
      estimateTokens(`${prev}\n\n${last}`) <= MAX_TOKENS
    ) {
      chunks.splice(chunks.length - 2, 2, `${prev}\n\n${last}`);
    }
  }
  return chunks;
}

// --- Public API ------------------------------------------------------------

/**
 * Convert an article into embed-ready DocumentRecords (no embedding yet).
 * Each record's `content` is prefixed with a "<Title> — <Heading>" breadcrumb
 * so the vector captures its position in the article's structure.
 */
export function chunkArticle(article: ChunkableArticle): DocumentRecord[] {
  const sections = splitIntoSections(article.contentHtml);

  const raw: Array<{ heading: string | null; text: string }> = [];
  for (const section of sections) {
    if (!section.text) continue;
    for (const chunk of packUnits(toUnits(section.text))) {
      raw.push({ heading: section.heading, text: chunk });
    }
  }

  const total = raw.length;
  return raw.map((rc, index) => {
    const breadcrumb = rc.heading
      ? `${article.title} — ${rc.heading}`
      : article.title;

    return {
      content: `${breadcrumb}\n\n${rc.text}`,
      sourceType: "blog",
      sourceUrl: article.url,
      sourceHandle: article.handle,
      parentHandle: article.parentHandle ?? null,
      metadata: {
        title: article.title,
        heading: rc.heading ?? undefined,
        chunkIndex: index,
        chunkTotal: total,
        publishedAt: article.publishedAt,
      },
    } satisfies DocumentRecord;
  });
}
