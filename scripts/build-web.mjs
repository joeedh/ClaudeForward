import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const srcWeb = path.join(root, "src/web");
const outWeb = path.join(root, "dist/web");

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [path.join(srcWeb, "app.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: outWeb,
  sourcemap: true,
  minify: !watch,
  loader: { ".css": "css" },
  logLevel: "info",
};

async function copyStatic() {
  await mkdir(outWeb, { recursive: true });
  for (const file of ["index.html", "style.css"]) {
    await cp(path.join(srcWeb, file), path.join(outWeb, file));
  }
}

await rm(outWeb, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("[build-web] watching…");
} else {
  await build(buildOptions);
}
