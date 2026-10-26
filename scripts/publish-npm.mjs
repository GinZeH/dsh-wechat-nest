// Retrying must never accept different tarball bytes at the same version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archive = join(root, "release-assets", `${pkg.name}-${pkg.version}.tgz`);
const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
const response = await fetch(url);
if (response.ok) {
  assert.equal((await response.json()).dist.integrity, integrity, "npm already contains different bytes at this version");
  console.log(`${pkg.name}@${pkg.version} is already published with identical bundle bytes`);
} else {
  assert.equal(response.status, 404, `Cannot check npm: HTTP ${response.status}`);
  const args = ["publish", archive, "--access", "public", "--ignore-scripts"];
  if (process.env.GITHUB_ACTIONS) args.push("--provenance");
  if (process.env.npm_execpath) {
    execFileSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: "inherit" });
  } else {
    assert.notEqual(process.platform, "win32", "On Windows run npm run publish:release");
    execFileSync("npm", args, { stdio: "inherit" });
  }
  const published = await fetch(url);
  assert.equal(published.status, 200, "Publication not yet visible; check npm before retrying");
  assert.equal((await published.json()).dist.integrity, integrity, "Published tarball integrity mismatch");
  console.log(`Verified npm publication: ${pkg.name}@${pkg.version}`);
}
