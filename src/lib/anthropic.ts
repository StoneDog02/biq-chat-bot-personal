// ===========================================================================
// Anthropic (Claude) client + streaming helper.
//
// The chat route consumes `streamCompletion` as an async generator of text
// deltas, which it re-encodes as Server-Sent Events for the widget.
// ===========================================================================

import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage } from "./types";

/** Per the spec. Overridable via ANTHROPIC_MODEL for easy model bumps. */
export const DEFAULT_MODEL = "claude-sonnet-5";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // TODO: set ANTHROPIC_API_KEY in .env.local / Vercel project settings.
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client = new Anthropic({ apiKey });
  return client;
}

export interface StreamOptions {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * Stream a Claude completion as plain text deltas.
 *
 * Yields incremental text as it arrives so the caller can forward tokens to
 * the browser immediately. Only text deltas are surfaced; other event types
 * (message_start, tool use, etc.) are intentionally ignored for this phase.
 */
export async function* streamCompletion(
  opts: StreamOptions,
): AsyncGenerator<string, void, unknown> {
  const { system, messages, maxTokens = 1024, temperature = 0.3 } = opts;
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const stream = getAnthropic().messages.stream({
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
