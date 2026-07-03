// ===========================================================================
// Voyage AI embeddings wrapper.
//
// We call Voyage's REST endpoint directly (no SDK) to keep the dependency
// surface small and the runtime edge/Node agnostic. voyage-3 returns 1024-dim
// vectors, which matches the `vector(1024)` column in Supabase.
// ===========================================================================

const VOYAGE_ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/** voyage-3 → 1024 dims. Keep in sync with the SQL migration's vector(1024). */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Voyage caps a single request at 128 inputs (and a token budget across the
 * batch). We stay well under both by batching to 96 items per request.
 */
const MAX_BATCH_SIZE = 96;

/**
 * Voyage distinguishes between embedding a search *query* and a stored
 * *document*; using the right input_type measurably improves retrieval. We
 * expose it so callers embed documents at ingest time and queries at chat time.
 */
export type VoyageInputType = "query" | "document";

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { total_tokens: number };
}

function getConfig() {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    // TODO: set VOYAGE_API_KEY in .env.local / Vercel project settings.
    throw new Error("VOYAGE_API_KEY is not set");
  }
  const model = process.env.VOYAGE_MODEL || "voyage-3";
  return { apiKey, model };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level single-request call with retry/backoff for 429 + 5xx. Voyage
 * returns embeddings in an arbitrary order tagged with `index`; we re-sort so
 * output[i] always corresponds to input[i].
 */
async function embedBatch(
  inputs: string[],
  inputType: VoyageInputType,
  maxRetries = 4,
): Promise<number[][]> {
  const { apiKey, model } = getConfig();

  let attempt = 0;
  // Exponential backoff: 0.5s, 1s, 2s, 4s ...
  for (;;) {
    const res = await fetch(VOYAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: inputs,
        model,
        input_type: inputType,
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as VoyageEmbeddingResponse;
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxRetries) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Voyage embed failed (${res.status} ${res.statusText}): ${body}`,
      );
    }

    // Honor Retry-After when present, otherwise exponential backoff.
    const retryAfter = Number(res.headers.get("retry-after"));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : 500 * 2 ** attempt;
    await sleep(backoff);
    attempt += 1;
  }
}

/**
 * Embed one or many texts. Automatically chunks large arrays into
 * Voyage-sized batches. Returns vectors in the same order as `input`.
 */
export async function embed(
  input: string | string[],
  inputType: VoyageInputType = "document",
): Promise<number[][]> {
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) return [];

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const vectors = await embedBatch(batch, inputType);
    results.push(...vectors);
  }
  return results;
}

/** Convenience: embed a single query string, returning one vector. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embed(text, "query");
  return vector;
}

/** Convenience: embed a single document string, returning one vector. */
export async function embedDocument(text: string): Promise<number[]> {
  const [vector] = await embed(text, "document");
  return vector;
}
