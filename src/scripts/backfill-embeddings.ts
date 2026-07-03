// ===========================================================================
// CLI backfill: embed all existing BODYiQ blog articles into Supabase.
//
// Run locally once (or after big content changes):
//   npm run backfill                 # all articles
//   npm run backfill -- --handle=foo # a single article
//   npm run backfill -- --dry-run    # fetch + chunk, but don't embed/write
//
// Unlike the API route, this logs per-article progress and isn't bound by
// serverless time limits, so it's the recommended path for the full corpus.
//
// NOTE: uses relative imports (not the "@/" alias) so it runs cleanly under tsx.
// ===========================================================================

import { config as loadEnv } from "dotenv";
// Prefer .env.local (Next convention), then fall back to .env.
loadEnv({ path: ".env.local" });
loadEnv();

import { chunkArticle } from "../lib/chunking";
import { embed } from "../lib/embeddings";
import {
  getAllArticles,
  getArticleByHandle,
  toChunkableArticle,
  type ShopifyArticle,
} from "../lib/shopify";
import { replaceSourceDocuments } from "../lib/supabase";
import type { EmbeddedDocument } from "../lib/types";

interface CliArgs {
  handle?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--handle=")) args.handle = arg.slice("--handle=".length);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a step with exponential backoff — a safety net on top of the per-client retries. */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  retries = 3,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      const backoff = 1000 * 2 ** attempt;
      console.warn(
        `  ↻ ${label} failed (attempt ${attempt + 1}/${retries + 1}); retrying in ${backoff}ms`,
        err instanceof Error ? err.message : err,
      );
      await sleep(backoff);
      attempt += 1;
    }
  }
}

async function ingestArticle(
  article: ShopifyArticle,
  dryRun: boolean,
): Promise<number> {
  const chunks = chunkArticle(toChunkableArticle(article));
  if (chunks.length === 0) {
    console.log(`  · ${article.handle}: no content, skipping`);
    return 0;
  }

  if (dryRun) {
    console.log(`  · ${article.handle}: ${chunks.length} chunks (dry run)`);
    return chunks.length;
  }

  const vectors = await withRetry(`embed ${article.handle}`, () =>
    embed(
      chunks.map((c) => c.content),
      "document",
    ),
  );

  const docs: EmbeddedDocument[] = chunks.map((c, i) => ({
    ...c,
    embedding: vectors[i],
  }));

  await withRetry(`upsert ${article.handle}`, () =>
    replaceSourceDocuments(article.handle, docs),
  );

  console.log(`  ✓ ${article.handle}: ${docs.length} chunks embedded`);
  return docs.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("BODYiQ embedding backfill");
  console.log(`  mode: ${args.dryRun ? "dry-run" : "write"}\n`);

  const articles = args.handle
    ? await (async () => {
        const a = await getArticleByHandle(args.handle!);
        return a ? [a] : [];
      })()
    : await getAllArticles();

  if (articles.length === 0) {
    console.error("No articles found. Check SHOPIFY_* env vars and the handle.");
    process.exit(1);
  }

  console.log(`Found ${articles.length} article(s). Starting...\n`);

  let totalChunks = 0;
  const failures: string[] = [];

  for (let i = 0; i < articles.length; i += 1) {
    const article = articles[i];
    console.log(`[${i + 1}/${articles.length}] ${article.title}`);
    try {
      totalChunks += await ingestArticle(article, args.dryRun);
    } catch (err) {
      failures.push(article.handle);
      console.error(`  ✗ ${article.handle}: ${err instanceof Error ? err.message : err}`);
    }
    // Gentle pacing to stay comfortably under Voyage/Shopify rate limits.
    await sleep(250);
  }

  console.log("\nDone.");
  console.log(`  articles processed: ${articles.length}`);
  console.log(`  chunks embedded:    ${totalChunks}`);
  if (failures.length > 0) {
    console.log(`  failures (${failures.length}): ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
