// ===========================================================================
// Bundles the widget into a single self-contained IIFE for the Shopify theme.
//
//   npm run build:widget
//
// Outputs:
//   public/widget.js   (minified IIFE, exposes window.BODYiQAssistant)
//   public/widget.css  (copied verbatim)
//
// These are served statically by Next from the deployed Vercel domain
// (NEXT_PUBLIC_WIDGET_ORIGIN), which the Liquid snippet points at.
// ===========================================================================

import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

async function main() {
  // Run from the project root (npm scripts do), so resolve against cwd rather
  // than __dirname/import.meta to stay CJS/ESM agnostic under tsx.
  const root = process.cwd();
  const widgetDir = path.join(root, "src", "widget");
  const outDir = path.join(root, "public");

  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [path.join(widgetDir, "chat-widget.ts")],
    outfile: path.join(outDir, "widget.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2018"],
    minify: true,
    sourcemap: true,
    logLevel: "info",
  });

  await copyFile(
    path.join(widgetDir, "chat-widget.css"),
    path.join(outDir, "widget.css"),
  );

  console.log("Widget built → public/widget.js, public/widget.css");
}

main().catch((err) => {
  console.error("Widget build failed:", err);
  process.exit(1);
});
