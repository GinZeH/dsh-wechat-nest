// Inspect the exact prebuilt bundle shipped to Desktop and npm.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "release-assets");
mkdirSync(out, { recursive: true });
assert.ok(process.env.npm_execpath, "Run through npm run pack:release");
const [pack] = JSON.parse(execFileSync(process.execPath, [
  process.env.npm_execpath, "pack", "--json", "--ignore-scripts", "--pack-destination", out,
], { cwd: root, encoding: "utf8" }));
const paths = pack.files.map(file => file.path);
for (const required of ["dist/index.js", "dist/client.js", "dist/dsh/session-log.cjs", "cordis.patch.yml", "LICENSE", "NOTICE"]) {
  assert.ok(paths.includes(required), `Missing bundle file: ${required}`);
}
assert.ok(!paths.some(file => /(^|\/)(node_modules|resources|src|tests|auth|bots|workspaces)(\/|$)|(^|\/)\.env|\.tsbuildinfo$|(^|\/)(state|config|sync-buf)\.json$|audit\.jsonl/.test(file)), "Unexpected private or development file in bundle");
const archive = join(out, pack.filename);
const temp = mkdtempSync(join(tmpdir(), "wechat-nest-bundle-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", temp]);
  const extracted = join(temp, "package");
  const manifest = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"));
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.ok(readFileSync(join(extracted, manifest.dsh.bundle.patch), "utf8").includes(`name: '${pkg.name}'`));
  const host = await import(pathToFileURL(resolve(extracted, manifest.main)).href);
  assert.equal(host.name, pkg.name);
  assert.equal(typeof host.apply, "function");
  let clientId;
  new Function("window", readFileSync(join(extracted, "dist/client.js"), "utf8"))({
    __ModuleLoader__: { load: spec => { clientId = spec.id; } },
  });
  assert.equal(clientId, pkg.name);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(join(out, "SHA256SUMS"), `${sha256}  ${pack.filename}\n`);
console.log(`Verified Desktop bundle: ${pkg.name}@${pkg.version} (${paths.length} files)`);
console.log(`SHA256 ${sha256}`);
