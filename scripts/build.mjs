import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });

execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  stdio: "inherit"
});

const common = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  sourcemap: false,
  treeShaking: true,
  legalComments: "none"
};

await build({
  ...common,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs"
});

await build({
  ...common,
  entryPoints: ["src/providers/openai-compatible.ts"],
  outfile: "dist/providers/openai-compatible.mjs"
});

await build({
  ...common,
  entryPoints: ["src/providers/anthropic.ts"],
  outfile: "dist/providers/anthropic.mjs"
});
