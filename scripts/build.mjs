import * as esbuild from "esbuild";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One version for everything: package.json. The plugin manifest must match it.
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;
const pluginVersion = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8")).version;
if (pluginVersion !== VERSION) {
  console.error(`Version mismatch: package.json ${VERSION}, .claude-plugin/plugin.json ${pluginVersion}. Run: npm run set-version -- ${VERSION}`);
  process.exit(1);
}
const define = { __SUMI_VERSION__: JSON.stringify(VERSION) };

const watch = process.argv.includes("--watch");

/** Overlay: injected into the reviewed page. Self-contained IIFE, no runtime deps. */
const overlay = {
  entryPoints: ["src/overlay/index.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: "dist/overlay.js",
  // Figma-exported icons are imported as markup and parsed into inline SVG (src/overlay/icons.ts).
  loader: { ".svg": "text" },
  define,
  sourcemap: false,
  // Minified: smaller to parse on every page load. It bundles no npm code; the notices for the icons
  // drawn from Lucide are in dist/THIRD_PARTY_NOTICES.txt, which the banner points to.
  minify: true,
  legalComments: "none",
  banner: { js: `/*! Sumi ${VERSION} overlay | MIT License | third-party notices: THIRD_PARTY_NOTICES.txt */` },
  metafile: true,
};

// Runs before any bundled code: a clear message instead of a syntax or API error on old Node.
const NODE_CHECK =
  'if (Number(process.versions.node.split(".")[0]) < 22) { process.stderr.write("sumi: Node.js 22 or newer is required (this is " + process.version + "). Install the current LTS from https://nodejs.org and try again.\\n"); process.exit(1); }';

/** CLI + proxy server + MCP server: one Node entry. */
const cli = {
  entryPoints: ["src/cli/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  outfile: "dist/cli.js",
  define,
  // Self-contained: the plugin ships dist/ with no node_modules, so bundle every dependency.
  // createRequire lets bundled CommonJS code call require() inside this ESM file.
  banner: {
    js: `#!/usr/bin/env node\n${NODE_CHECK}\nimport { createRequire as __sumiCreateRequire } from "node:module";\nconst require = __sumiCreateRequire(import.meta.url);`,
  },
  sourcemap: false,
  metafile: true,
};

// ---------------------------------------------------------------- third-party notices

const LUCIDE_NOTICE = `Lucide icons (https://lucide.dev)
The dock icons brush, send, close, more and marquee are based on Lucide icons.
License: ISC

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

/** node_modules/<pkg> (scoped or not) for every bundled input file. */
function bundledPackages(metafiles) {
  const dirs = new Set();
  for (const meta of metafiles) {
    for (const input of Object.keys(meta.inputs)) {
      const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
      if (m) dirs.add(m[1]);
    }
  }
  return [...dirs].sort();
}

function licenseText(dir) {
  const names = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f)).sort();
  return names.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
}

function writeNotices(metafiles) {
  const seen = new Map();
  for (const dir of bundledPackages(metafiles)) {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    const id = `${p.name}@${p.version}`;
    if (seen.has(id)) continue;
    const license = typeof p.license === "string" ? p.license : p.license?.type ?? "see package";
    const text = licenseText(dir);
    if (!text) console.warn(`sumi: no license file found for ${id} (${license})`);
    seen.set(id, `${id}\nLicense: ${license}\n${p.homepage ? `Homepage: ${p.homepage}\n` : ""}\n${text || `(no license file shipped; the package declares ${license})`}\n`);
  }
  // Lucide is not an npm dependency (the icons were redrawn from it), so its notice is added here.
  const lucide = existsSync("node_modules/lucide/LICENSE") ? readFileSync("node_modules/lucide/LICENSE", "utf8") : null;
  const parts = [
    `Sumi ${VERSION} - third-party notices`,
    "",
    "dist/cli.js and dist/overlay.js bundle the following open-source software. Each is used under the",
    "license reproduced below.",
    "",
    ...[...seen.values()].flatMap((t) => ["=".repeat(78), t]),
    "=".repeat(78),
    lucide ? LUCIDE_NOTICE.replace(/ISC License\n[\s\S]*$/, lucide.trim() + "\n") : LUCIDE_NOTICE,
  ];
  writeFileSync("dist/THIRD_PARTY_NOTICES.txt", parts.join("\n"));
  return seen.size;
}

if (watch) {
  const ctxs = await Promise.all([esbuild.context(overlay), esbuild.context(cli)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("sumi: watching src/ …");
} else {
  const results = await Promise.all([esbuild.build(overlay), esbuild.build(cli)]);
  const n = writeNotices(results.map((r) => r.metafile));
  console.log(`sumi ${VERSION}: built dist/overlay.js, dist/cli.js and dist/THIRD_PARTY_NOTICES.txt (${n} bundled packages)`);
}
