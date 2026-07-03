// ===========================================================================
// POST /api/ingest/webhook — Shopify blog article webhook receiver.
//
// Subscribe this URL to articles/create, articles/update, and articles/delete.
// On create/update we re-fetch, re-chunk, re-embed, and replace the article's
// chunks. On delete we drop them. Every request's HMAC is verified first.
// ===========================================================================

import { NextRequest } from "next/server";
import crypto from "node:crypto";
import { chunkArticle } from "@/lib/chunking";
import { embed } from "@/lib/embeddings";
import { getArticleByHandle, toChunkableArticle } from "@/lib/shopify";
import {
  deleteDocumentsBySourceHandle,
  replaceSourceDocuments,
} from "@/lib/supabase";
import type { EmbeddedDocument } from "@/lib/types";

// crypto + external calls → Node runtime, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Constant-time compare of Shopify's HMAC header against a fresh digest of the
 * raw body. MUST run on the untouched raw bytes, so we read req.text() first
 * and never JSON.parse before verifying.
 */
function verifyHmac(rawBody: string, hmacHeader: string | null): boolean {
  // Shopify signs webhooks with the app's CLIENT SECRET. Accept an explicit
  // SHOPIFY_WEBHOOK_SECRET, but fall back to SHOPIFY_CLIENT_SECRET so the same
  // value doesn't have to be configured twice.
  const secret =
    process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret) {
    // TODO: set SHOPIFY_WEBHOOK_SECRET (= the app's Client secret), or
    // SHOPIFY_CLIENT_SECRET.
    throw new Error(
      "SHOPIFY_WEBHOOK_SECRET (or SHOPIFY_CLIENT_SECRET) is not set",
    );
  }
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const expected = Buffer.from(digest);
  const received = Buffer.from(hmacHeader);
  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const topic = req.headers.get("x-shopify-topic") ?? "";

  if (!verifyHmac(rawBody, req.headers.get("x-shopify-hmac-sha256"))) {
    // 401 tells Shopify the delivery failed; it will retry.
    return Response.json({ error: "Invalid HMAC signature" }, { status: 401 });
  }

  let payload: { handle?: string; id?: number | string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const handle = payload.handle;
  if (!handle) {
    return Response.json({ error: "Missing article handle" }, { status: 400 });
  }

  try {
    // Deletion: just drop the chunks for this handle.
    if (topic.endsWith("/delete")) {
      await deleteDocumentsBySourceHandle(handle);
      return Response.json({ ok: true, action: "deleted", handle });
    }

    // Create/update: re-fetch canonical article (gets latest body + metafields
    // like the cluster parent), re-chunk, embed, and atomically replace chunks.
    const article = await getArticleByHandle(handle);
    if (!article) {
      // Article no longer resolvable (e.g. unpublished). Clean up any stale
      // chunks so we don't serve outdated content.
      await deleteDocumentsBySourceHandle(handle);
      return Response.json({ ok: true, action: "purged", handle });
    }

    const chunks = chunkArticle(toChunkableArticle(article));
    if (chunks.length === 0) {
      await deleteDocumentsBySourceHandle(handle);
      return Response.json({ ok: true, action: "empty", handle });
    }

    const vectors = await embed(
      chunks.map((c) => c.content),
      "document",
    );
    const docs: EmbeddedDocument[] = chunks.map((c, i) => ({
      ...c,
      embedding: vectors[i],
    }));

    await replaceSourceDocuments(handle, docs);

    return Response.json({
      ok: true,
      action: "reembedded",
      handle,
      chunks: docs.length,
    });
  } catch (err) {
    console.error("[webhook] ingest failed:", err);
    // 500 so Shopify retries the delivery.
    return Response.json({ error: "Ingest failed" }, { status: 500 });
  }
}
