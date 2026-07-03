/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API routes stream responses and talk to external services (Anthropic,
  // Voyage, Supabase, Shopify). Nothing here is statically optimizable, so we
  // keep the default Node.js runtime and let each route opt into edge if needed.
  experimental: {
    // Allow slightly larger server action / route payloads for conversation
    // history without tripping the default body size guard.
    serverComponentsExternalPackages: ["@anthropic-ai/sdk"],
  },
};

module.exports = nextConfig;
