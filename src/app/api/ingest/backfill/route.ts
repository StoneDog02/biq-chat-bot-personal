// ===========================================================================
// POST /api/ingest/backfill — admin-triggered one-shot ingest of every article.
//
// Protected by a bearer token (BACKFILL_ADMIN_TOKEN). For the full 106-post run
// prefer the CLI script (src/scripts/backfill-embeddings.ts), which has richer
// logging and isn't bound by serverless execution limits. This route is a
// convenient trigger for smaller re-syncs.
// ===========================================================================

import { NextRequest } from "next/server";
import { chunkArticle } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";
import { getAllArticles, toChunkableArticle } from "@/lib/shopify";
import { replaceSourceDocuments } from "@/lib/supabase";
import type { EmbeddedDocument } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Give the run headroom. Requires a Vercel plan that permits long functions;
// the CLI script is the fallback when this isn't enough.
export const maxDuration = 300;

function isAuthorized(req: NextRequest): boolean {
  const token = process.env.BACKFILL_ADMIN_TOKEN;
  if (!token) {
    // TODO: set BACKFILL_ADMIN_TOKEN so this route can't be triggered anonymously.
    throw new Error("BACKFILL_ADMIN_TOKEN is not set");
  }
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  // Constant-time-ish compare; token length is not secret here.
  return provided.length === token.length && provided === token;
}

export async function POST(req: NextRequest) {
  let authorized: boolean;
  try {
    authorized = isAuthorized(req);
  } catch (err) {
    console.error("[backfill]", err);
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!authorized) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const articles = await getAllArticles();

    let embeddedChunks = 0;
    const failures: Array<{ handle: string; error: string }> = [];

    for (const article of articles) {
      try {
        const chunks = chunkArticle(toChunkableArticle(article));
        if (chunks.length === 0) continue;

        const vectors = await embed(
          chunks.map((c) => c.content),
          "document",
        );
        const docs: EmbeddedDocument[] = chunks.map((c, i) => ({
          ...c,
          embedding: vectors[i],
        }));

        await replaceSourceDocuments(article.handle, docs);
        embeddedChunks += docs.length;
      } catch (err) {
        failures.push({
          handle: article.handle,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return Response.json({
      ok: failures.length === 0,
      articles: articles.length,
      embeddedChunks,
      failures,
    });
  } catch (err) {
    console.error("[backfill] failed:", err);
    return Response.json({ error: "Backfill failed" }, { status: 500 });
  }
}
