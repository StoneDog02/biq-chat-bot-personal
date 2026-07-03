// ===========================================================================
// GET /api/health — lightweight liveness/readiness probe.
//
// Reports whether each required piece of configuration is present WITHOUT
// leaking secret values. Useful for uptime checks and post-deploy smoke tests.
// ===========================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    voyage: Boolean(process.env.VOYAGE_API_KEY),
    supabase: Boolean(
      process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    shopify: Boolean(
      process.env.SHOPIFY_STORE_DOMAIN &&
        // Either the client-credentials pair (Dev Dashboard apps) or a legacy
        // static admin token.
        ((process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET) ||
          process.env.SHOPIFY_ADMIN_API_TOKEN),
    ),
    webhookSecret: Boolean(
      process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET,
    ),
  };

  const ok = Object.values(config).every(Boolean);

  return Response.json(
    { status: ok ? "ok" : "degraded", config, time: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
