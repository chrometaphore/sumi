// Usage: npm run set-version -- 1.2.0
// Writes the version to package.json, package-lock.json and .claude-plugin/plugin.json
// (they must always match; the build refuses to run otherwise).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v || "")) {
  console.error("Usage: npm run set-version -- <major.minor.patch>");
  process.exit(1);
}
// package.json + package-lock.json, without a git commit or tag.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["version", v, "--no-git-tag-version", "--allow-same-version"], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`package.json, package-lock.json: ${v}`);
const file = ".claude-plugin/plugin.json";
const json = JSON.parse(readFileSync(file, "utf8"));
json.version = v;
writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
console.log(`${file}: ${v}`);
