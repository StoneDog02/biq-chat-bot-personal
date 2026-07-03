// ===========================================================================
// POST /api/chat — the endpoint the storefront widget calls.
//
// Flow: validate body -> retrieval.buildContext -> stream Claude tokens back as
// Server-Sent Events -> emit a final structured event containing citations.
//
// CORS is locked to the storefront origin (ALLOWED_ORIGIN) and the widget asset
// origin (NEXT_PUBLIC_WIDGET_ORIGIN) only.
// ===========================================================================

import { NextRequest } from "next/server";
import { streamCompletion } from "@/lib/anthropic";
import { buildContext } from "@/lib/retrieval";
import { buildSystemPrompt } from "@/lib/prompts";
import type { ChatMessage, ChatRequestBody, Citation } from "@/lib/types";

// Anthropic SDK + streaming run on the Node runtime. Force dynamic so this is
// never statically cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keep a bounded window of history to control token cost and latency.
const MAX_HISTORY_TURNS = 10;

// --- CORS ------------------------------------------------------------------

function allowedOrigins(): string[] {
  return [process.env.ALLOWED_ORIGIN, process.env.NEXT_PUBLIC_WIDGET_ORIGIN]
    .filter((o): o is string => Boolean(o))
    .map((o) => o.replace(/\/$/, ""));
}

/** Build CORS headers, echoing the request origin only if it's allow-listed. */
function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin")?.replace(/\/$/, "") ?? "";
  const allowed = allowedOrigins();
  const headers: Record<string, string> = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

// --- Validation ------------------------------------------------------------

function sanitizeHistory(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return [];
  const cleaned: ChatMessage[] = [];
  for (const item of raw) {
    if (
      item &&
      typeof item === "object" &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim()
    ) {
      cleaned.push({ role: item.role, content: item.content });
    }
  }
  // Keep only the most recent turns.
  return cleaned.slice(-MAX_HISTORY_TURNS);
}

// --- SSE helpers -----------------------------------------------------------

const encoder = new TextEncoder();

/** Serialize one SSE `data:` frame. Our protocol is one JSON object per event. */
function sse(payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

// --- Handler ---------------------------------------------------------------

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req);

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400, headers: cors },
    );
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json(
      { error: "`message` is required" },
      { status: 400, headers: cors },
    );
  }

  const history = sanitizeHistory(body.conversationHistory);
  const pageContext = body.pageContext;

  // Retrieval happens before we open the stream so we can fail fast with a
  // clean error status if Voyage/Supabase are down.
  let context = "";
  let citations: Citation[] = [];
  try {
    const result = await buildContext(message, pageContext);
    context = result.context;
    citations = result.citations;
  } catch (err) {
    console.error("[chat] retrieval failed:", err);
    return Response.json(
      { error: "Retrieval failed" },
      { status: 502, headers: cors },
    );
  }

  const system = buildSystemPrompt(context, pageContext);
  const messages: ChatMessage[] = [...history, { role: "user", content: message }];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamCompletion({ system, messages })) {
          controller.enqueue(sse({ type: "token", text: delta }));
        }
        // Final structured chunk: citations for the widget's source cards.
        controller.enqueue(sse({ type: "citations", citations }));
        controller.enqueue(sse({ type: "done" }));
      } catch (err) {
        console.error("[chat] stream failed:", err);
        controller.enqueue(
          sse({ type: "error", message: "The assistant hit a snag. Please try again." }),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering so tokens flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
