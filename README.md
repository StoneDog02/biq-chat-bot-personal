# BODYiQ AI Assistant

A Next.js 14 (App Router, TypeScript) backend for the **BODYiQ** AI shopping /
support / education assistant. It powers a lightweight, embeddable chat widget
on the Shopify storefront: retrieval-augmented answers over BODYiQ's blog,
products, and policies, streamed from Claude.

> Deployed on Vercel. Called by the storefront widget in
> `theme-snippet/ai-chat-widget.liquid`.

## Stack

| Concern      | Choice                                             |
| ------------ | -------------------------------------------------- |
| Framework    | Next.js 14 (App Router) on Vercel                  |
| LLM          | Anthropic Claude (`claude-sonnet-5`), streaming    |
| Embeddings   | Voyage AI (`voyage-3`, 1024-dim)                   |
| Vector store | Supabase + pgvector (cosine, ivfflat)              |
| Commerce     | Shopify Admin API (GraphQL)                        |
| Widget       | Vanilla TS → single IIFE bundle (esbuild)          |

## Architecture

```
Shopify storefront (Liquid snippet)
        │  loads widget.js/.css from NEXT_PUBLIC_WIDGET_ORIGIN
        ▼
Embeddable widget  ──POST /api/chat (SSE)──▶  Next.js API
                                                  │
                     retrieval.buildContext ──────┤
                        │  embed query (Voyage)    │
                        │  vector search (Supabase)│
                        ▼                          ▼
                   assembled context ───▶  Claude (stream) ──▶ tokens + citations
```

Ingestion keeps the vector store fresh:

- **Backfill** (`/api/ingest/backfill` or the CLI script) embeds all existing
  posts once.
- **Webhook** (`/api/ingest/webhook`) re-embeds a single article whenever it's
  created/updated/deleted in Shopify.

## Retrieval design notes

- **Chunking** (`src/lib/chunking.ts`) splits on HTML headings first, then packs
  paragraphs into ~300-500 token windows, prefixing each chunk with a
  `"<Title> — <Heading>"` breadcrumb so the embedding captures structural
  context.
- **Cluster awareness**: BODYiQ's blog is organized as topic clusters (a pillar
  article + children). Each chunk stores its `parent_handle`. Retrieval
  (`src/lib/retrieval.ts`) re-ranks a wide candidate pool with bounded boosts
  for (a) the shopper's current page and (b) the "focus cluster," so answers
  draw coherent context from across a cluster rather than one article.

## Getting started

### 1. Install

```bash
npm install
cp .env.example .env.local   # then fill in real values (see comments)
```

### 2. Provision Supabase

Run the migration against your Supabase project (via the SQL editor or the
Supabase CLI):

```bash
# supabase CLI
supabase db push
# or paste supabase/migrations/0001_init.sql into the SQL editor
```

This enables pgvector, creates the `documents` table + ivfflat index, and the
`match_documents` RPC used for similarity search.

### 3. Backfill embeddings

```bash
npm run backfill                 # all articles
npm run backfill -- --handle=foo # a single article
npm run backfill -- --dry-run    # chunk only, no writes
```

> Tip: rebuild the ivfflat index after the first large backfill so it's built
> against real data.

### 4. Run the API

```bash
npm run dev
# health check:
curl http://localhost:3000/api/health
```

### 5. Build & deploy the widget

```bash
npm run build:widget   # → public/widget.js, public/widget.css
```

Deploy the app to Vercel. The widget assets are served from
`NEXT_PUBLIC_WIDGET_ORIGIN` (e.g. `https://assistant.bodyiq.com/widget.js`).
Add `snippets/ai-chat-widget.liquid` to the Shopify theme and render it where
you want the assistant to appear inline:

```liquid
{% render 'ai-chat-widget' %}
```

Set a theme setting `assistant_origin` equal to `NEXT_PUBLIC_WIDGET_ORIGIN`.

## Shopify webhook

Create webhooks for `articles/create`, `articles/update`, and `articles/delete`
pointing at:

```
https://<your-domain>/api/ingest/webhook
```

Use the webhook signing secret as `SHOPIFY_WEBHOOK_SECRET`. Every request's HMAC
is verified before processing.

## Environment variables

See `.env.example` for the full annotated list:

`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`,
`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_API_VERSION`, `SHOPIFY_WEBHOOK_SECRET`
(optional; defaults to `SHOPIFY_CLIENT_SECRET`), `BACKFILL_ADMIN_TOKEN`,
`ALLOWED_ORIGIN`, `NEXT_PUBLIC_WIDGET_ORIGIN`.

### Shopify auth (Dev Dashboard apps)

Apps created at `dev.shopify.com` no longer expose a static `shpat_` token
(deprecated Jan 2026). This service uses the **client credentials grant**: it
exchanges `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET` for a short-lived (24h)
Admin API token, caches it, and refreshes automatically. The app must be
installed on the store, and app + store must be in the same Shopify org. A
legacy `SHOPIFY_ADMIN_API_TOKEN`, if set, takes precedence.

## API reference

| Method | Route                   | Purpose                                        |
| ------ | ----------------------- | ---------------------------------------------- |
| POST   | `/api/chat`             | Streaming (SSE) chat. Body: `{ message, conversationHistory?, pageContext? }`. CORS-locked to `ALLOWED_ORIGIN` + `NEXT_PUBLIC_WIDGET_ORIGIN`. |
| POST   | `/api/ingest/webhook`   | Shopify article webhook (HMAC-verified).       |
| POST   | `/api/ingest/backfill`  | Admin-triggered full backfill (Bearer `BACKFILL_ADMIN_TOKEN`). |
| GET    | `/api/health`           | Config/liveness probe.                         |

### `/api/chat` SSE protocol

One JSON object per `data:` frame:

```
data: {"type":"token","text":"..."}      // repeated as tokens arrive
data: {"type":"citations","citations":[]} // final structured chunk
data: {"type":"done"}
data: {"type":"error","message":"..."}    // on failure
```

## Guardrails

The system prompt (`src/lib/prompts.ts`) enforces BODYiQ's voice (knowledgeable,
direct, no hype) and hard medical guardrails: no disease/treatment/diagnostic
claims about supplements, and a recommendation to consult a healthcare provider
(via **CareValidate**) for anything symptom- or medication-specific.

## Non-goals (this phase)

- No order/account lookup or auth (phase 3).
- No Triple Whale integration.
- No admin UI beyond the backfill trigger.
```
