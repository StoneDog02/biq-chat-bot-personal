// ===========================================================================
// Shopify Admin API (GraphQL) client.
//
// Provides just what this phase needs: live product data (price/inventory),
// single-article fetch for webhook re-embeds, and full article listing for the
// backfill. Order/account lookups are intentionally out of scope (phase 3).
// ===========================================================================

import type { ChunkableArticle } from "./chunking";

// --- Config ----------------------------------------------------------------

/**
 * Pinned default; bump deliberately. Overridable via SHOPIFY_API_VERSION.
 * Keep this aligned with the app's "Webhooks API version" in the Shopify dev
 * dashboard, and within Shopify's ~1-year supported window.
 */
const DEFAULT_API_VERSION = "2026-07";

// TODO: confirm the brand's actual cluster convention. We read the pillar
// article handle from an article metafield; adjust namespace/key to match how
// BODYiQ tags cluster relationships in the Shopify admin.
const CLUSTER_METAFIELD_NAMESPACE = "custom";
const CLUSTER_METAFIELD_KEY = "parent_article";

function getStoreDomain(): string {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) {
    // TODO: set SHOPIFY_STORE_DOMAIN (the *.myshopify.com domain).
    throw new Error("SHOPIFY_STORE_DOMAIN must be set");
  }
  return domain;
}

function getGraphqlEndpoint(): string {
  const apiVersion = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  return `https://${getStoreDomain()}/admin/api/${apiVersion}/graphql.json`;
}

// --- Access tokens (client credentials grant) ------------------------------
//
// As of Shopify's Jan 2026 changes, Dev Dashboard apps no longer expose a
// long-lived `shpat_` Admin API token. Instead we exchange the app's Client ID
// + Client secret for a SHORT-LIVED (24h) access token via the client
// credentials grant, then send it as X-Shopify-Access-Token.
//   docs: https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens
//
// This only works when the app and store are in the same Shopify org (the case
// for a first-party custom app). Cross-org apps must use OAuth/token exchange.
//
// Backwards compatible: if a static SHOPIFY_ADMIN_API_TOKEN is provided (legacy
// custom app), we use it directly and skip the exchange.

interface CachedToken {
  token: string;
  /** epoch ms when the token should be considered expired. */
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/** Force a refresh on the next call (e.g. after a 401). */
function invalidateAccessToken(): void {
  cachedToken = null;
}

async function getAccessToken(): Promise<string> {
  // Legacy long-lived token, if present, always wins.
  const explicit = process.env.SHOPIFY_ADMIN_API_TOKEN;
  if (explicit) return explicit;

  const now = Date.now();
  // Reuse the cached token until ~1 min before expiry to avoid edge races.
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) {
    return cachedToken.token;
  }

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    // TODO: set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (from the app's
    // Settings page in the Shopify Dev Dashboard), or a legacy
    // SHOPIFY_ADMIN_API_TOKEN.
    throw new Error(
      "Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or a legacy SHOPIFY_ADMIN_API_TOKEN)",
    );
  }

  const res = await fetch(
    `https://${getStoreDomain()}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Shopify token exchange failed (${res.status} ${res.statusText}): ${body}`,
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  // Default to 24h if the response omits expires_in.
  const ttlMs = (json.expires_in ?? 86_400) * 1000;
  cachedToken = { token: json.access_token, expiresAt: now + ttlMs };
  return cachedToken.token;
}

/**
 * Public storefront base for building canonical article/product URLs.
 * The Admin API doesn't always expose a public URL for articles, so we compose
 * one. Defaults to ALLOWED_ORIGIN (bodyiq.com).
 */
function storefrontBaseUrl(): string {
  // TODO: if the storefront lives on a path or subdomain, adjust here.
  return (process.env.ALLOWED_ORIGIN || "https://bodyiq.com").replace(/\/$/, "");
}

// --- Low-level GraphQL executor -------------------------------------------

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable: number;
        maximumAvailable: number;
        restoreRate: number;
      };
    };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a GraphQL query against the Admin API with throttle-aware retries.
 * Shopify uses a leaky-bucket rate limiter and returns THROTTLED errors when
 * the query cost exceeds the available budget; we back off and retry those.
 */
export async function shopifyGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  maxRetries = 4,
): Promise<T> {
  const endpoint = getGraphqlEndpoint();

  let attempt = 0;
  for (;;) {
    // Fetched inside the loop so a 401 can transparently force a fresh token.
    const token = await getAccessToken();
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    // Expired/revoked token: drop the cache and retry with a fresh one.
    if (res.status === 401 && attempt < maxRetries) {
      invalidateAccessToken();
      attempt += 1;
      continue;
    }

    // HTTP-level throttling.
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2;
      await sleep(retryAfter * 1000);
      attempt += 1;
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Shopify HTTP ${res.status} ${res.statusText}: ${body}`);
    }

    const json = (await res.json()) as GraphQLResponse<T>;

    // GraphQL-level throttling comes back as 200 + a THROTTLED error code.
    const throttled = json.errors?.some(
      (e) => e.extensions?.code === "THROTTLED",
    );
    if (throttled && attempt < maxRetries) {
      await sleep(1000 * 2 ** attempt);
      attempt += 1;
      continue;
    }

    if (json.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!json.data) throw new Error("Shopify GraphQL returned no data");
    return json.data;
  }
}

// --- Products --------------------------------------------------------------

export interface ShopifyProductVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
}

export interface ShopifyProduct {
  handle: string;
  title: string;
  description: string;
  descriptionHtml: string;
  url: string | null;
  price: string;
  currencyCode: string;
  totalInventory: number | null;
  variants: ShopifyProductVariant[];
}

const PRODUCT_QUERY = /* GraphQL */ `
  query ProductByHandle($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        handle
        title
        description
        descriptionHtml
        onlineStoreUrl
        totalInventory
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
        }
        variants(first: 20) {
          nodes {
            id
            title
            sku
            price
            availableForSale
            inventoryQuantity
          }
        }
      }
    }
  }
`;

interface ProductQueryResult {
  products: {
    nodes: Array<{
      handle: string;
      title: string;
      description: string;
      descriptionHtml: string;
      onlineStoreUrl: string | null;
      totalInventory: number | null;
      priceRangeV2: { minVariantPrice: { amount: string; currencyCode: string } };
      variants: {
        nodes: Array<{
          id: string;
          title: string;
          sku: string | null;
          price: string;
          availableForSale: boolean;
          inventoryQuantity: number | null;
        }>;
      };
    }>;
  };
}

/** Fetch live product data (price, inventory, description) by handle. */
export async function getProductByHandle(
  handle: string,
): Promise<ShopifyProduct | null> {
  const data = await shopifyGraphQL<ProductQueryResult>(PRODUCT_QUERY, {
    // Exact handle match via Shopify search syntax.
    query: `handle:${handle}`,
  });

  const node = data.products.nodes[0];
  if (!node || node.handle !== handle) return null;

  return {
    handle: node.handle,
    title: node.title,
    description: node.description,
    descriptionHtml: node.descriptionHtml,
    url: node.onlineStoreUrl,
    price: node.priceRangeV2.minVariantPrice.amount,
    currencyCode: node.priceRangeV2.minVariantPrice.currencyCode,
    totalInventory: node.totalInventory,
    variants: node.variants.nodes,
  };
}

// --- Articles --------------------------------------------------------------

export interface ShopifyArticle {
  id: string;
  handle: string;
  title: string;
  bodyHtml: string;
  summary: string | null;
  publishedAt: string | null;
  blogHandle: string;
  tags: string[];
  parentHandle: string | null;
  url: string;
}

// Fragment reused by single-article and list queries. `body` is the article's
// HTML content in the GraphQL Admin API (2024-07+).
const ARTICLE_FIELDS = /* GraphQL */ `
  fragment ArticleFields on Article {
    id
    handle
    title
    body
    summary
    publishedAt
    tags
    blog { handle }
    parentMeta: metafield(
      namespace: "${CLUSTER_METAFIELD_NAMESPACE}"
      key: "${CLUSTER_METAFIELD_KEY}"
    ) {
      value
    }
  }
`;

interface RawArticle {
  id: string;
  handle: string;
  title: string;
  body: string | null;
  summary: string | null;
  publishedAt: string | null;
  tags: string[];
  blog: { handle: string } | null;
  parentMeta: { value: string } | null;
}

function mapArticle(raw: RawArticle): ShopifyArticle {
  const blogHandle = raw.blog?.handle ?? "news";
  return {
    id: raw.id,
    handle: raw.handle,
    title: raw.title,
    bodyHtml: raw.body ?? "",
    summary: raw.summary,
    publishedAt: raw.publishedAt,
    blogHandle,
    tags: raw.tags ?? [],
    parentHandle: raw.parentMeta?.value?.trim() || null,
    url: `${storefrontBaseUrl()}/blogs/${blogHandle}/${raw.handle}`,
  };
}

/** Turn a ShopifyArticle into the chunker's input shape. */
export function toChunkableArticle(article: ShopifyArticle): ChunkableArticle {
  return {
    handle: article.handle,
    title: article.title,
    contentHtml: article.bodyHtml,
    url: article.url,
    publishedAt: article.publishedAt ?? undefined,
    parentHandle: article.parentHandle,
  };
}

const ARTICLE_BY_HANDLE_QUERY = /* GraphQL */ `
  ${ARTICLE_FIELDS}
  query ArticleByHandle($query: String!) {
    articles(first: 1, query: $query) {
      nodes { ...ArticleFields }
    }
  }
`;

/** Re-fetch a single article by handle (used on webhook trigger). */
export async function getArticleByHandle(
  handle: string,
): Promise<ShopifyArticle | null> {
  const data = await shopifyGraphQL<{ articles: { nodes: RawArticle[] } }>(
    ARTICLE_BY_HANDLE_QUERY,
    { query: `handle:${handle}` },
  );
  const node = data.articles.nodes.find((n) => n.handle === handle);
  return node ? mapArticle(node) : null;
}

const ALL_ARTICLES_QUERY = /* GraphQL */ `
  ${ARTICLE_FIELDS}
  query AllArticles($cursor: String) {
    articles(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ...ArticleFields }
    }
  }
`;

interface AllArticlesResult {
  articles: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: RawArticle[];
  };
}

/**
 * Fetch every blog article, transparently paging through the connection.
 * Used by the backfill to embed all existing posts.
 */
export async function getAllArticles(): Promise<ShopifyArticle[]> {
  const out: ShopifyArticle[] = [];
  let cursor: string | null = null;

  for (;;) {
    const data: AllArticlesResult = await shopifyGraphQL<AllArticlesResult>(
      ALL_ARTICLES_QUERY,
      { cursor },
    );

    out.push(...data.articles.nodes.map(mapArticle));

    if (!data.articles.pageInfo.hasNextPage) break;
    cursor = data.articles.pageInfo.endCursor;
  }

  return out;
}
