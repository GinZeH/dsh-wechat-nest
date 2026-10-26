import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const release = read(".github/workflows/release.yml");
const ci = read(".github/workflows/ci.yml");
const publishDoc = read("PUBLISH.md");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

/** The `jobs:` block of a workflow, split into one string per job. */
function jobBlocks(yaml: string): Record<string, string> {
  const jobs: Record<string, string> = {};
  const start = yaml.search(/^jobs:/m);
  if (start === -1) return jobs;
  const body = yaml.slice(start);
  // A job starts at a 2-space-indented key; its body runs until the next one.
  const re = /^ {2}([A-Za-z0-9_-]+):\s*$/gm;
  const marks: Array<{ name: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) marks.push({ name: match[1]!, index: match.index });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : body.length;
    jobs[mark.name] = body.slice(mark.index, end);
  });
  return jobs;
}

const releaseJobs = jobBlocks(release);
const ciJobs = jobBlocks(ci);

/**
 * Strip YAML comment lines before asserting on content.
 *
 * The workflows carry long explanatory comments — including the ones that
 * document the very bugs these tests guard (e.g. a comment saying "no
 * separate `npm run build`"). Matching against raw text would make those
 * comments trip their own assertions.
 */
const code = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("release workflow: verified bundle and npm publication", () => {
  it("accepts version tags and explicit release branches, without publishing on main pushes", () => {
    expect(release).toContain("tags: ['v*']");
    expect(release).toContain("branches: ['release/v*']");
    expect(release).not.toMatch(/branches:.*main/);
    expect(release).toContain("workflow_dispatch:");
  });
  it("verifies version, tests and packs before creating a Release", () => {
    expect(releaseJobs.bundle).toContain("package.json");
    expect(releaseJobs.bundle).toContain("GITHUB_REF_NAME");
    expect(releaseJobs.bundle).toContain("npm ci");
    expect(releaseJobs.bundle).toContain("npm test");
    expect(releaseJobs.bundle).toContain("npm run pack:release");
    expect(releaseJobs.release).toMatch(/needs: bundle/);
    expect(release).not.toContain("actions/runs?head_sha");
  });
  it("uploads the prebuilt bundle and checksum as release assets", () => {
    expect(releaseJobs.bundle).toContain("actions/upload-artifact@v4");
    expect(releaseJobs.release).toContain("name: desktop-bundle");
    expect(releaseJobs.release).toContain("release-assets/*.tgz");
    expect(releaseJobs.release).toContain("release-assets/SHA256SUMS");
    expect(releaseJobs.release).toContain("Tag already points elsewhere");
  });
  it("publishes only after the Release and reuses the same artifact", () => {
    const publish = releaseJobs["publish-npm"]!;
    expect(publish).toMatch(/needs: \[bundle, release\]/);
    expect(publish).toContain("name: desktop-bundle");
    expect(publish).toContain("node scripts/publish-npm.mjs");
    expect(publish).not.toContain("npm ci");
    expect(publish).not.toContain("npm run build");
    expect(pkg.scripts["pack:release"]).toContain("npm run build");
    expect(ciJobs.build).toContain("npm run pack:release");
  });
  it("supports OIDC and the documented token fallback", () => {
    const publish = releaseJobs["publish-npm"]!;
    expect(publish).toContain("id-token: write");
    expect(publish).toContain("NODE_AUTH_TOKEN: ${{ secrets.DSH_WECHAT_NEST_NPM_TOKEN }}");
    expect(publishDoc).toContain("DSH_WECHAT_NEST_NPM_TOKEN");
    expect(publish).not.toContain("NPM_PUBLISH_ENABLED");
  });
  it("refuses an existing npm version whose bytes differ", () => {
    const script=read("scripts/publish-npm.mjs");
    expect(script).toContain("dist.integrity");
    expect(script).toContain('assert.equal(response.status, 404');
    expect(script).toContain('"--ignore-scripts"');
  });
  it("serializes publications and bounds every job", () => {
    expect(release).toContain("group: release");
    expect(release).toContain("cancel-in-progress: false");
    for (const block of [...Object.values(releaseJobs), ...Object.values(ciJobs)]) {
      expect(block).toContain("timeout-minutes:");
    }
  });
});

describe("release script", () => {
  it("is wired to npm run release", () => {
    expect(pkg.scripts.release).toBe("node scripts/release.mjs");
  });

  it("keeps push opt-in", () => {
    // PUBLISH.md requires a human confirmation before anything leaves the
    // machine, so the default path must stop after the tag.
    const script = read("scripts/release.mjs");
    expect(script).toContain('"--push"');
    expect(script).toMatch(/if \(push\)/);
  });

  it("survives npm swallowing --dry-run and --push", () => {
    // `npm run release patch --dry-run` never delivers the flag to the
    // script: npm claims it as its own config. Before this fallback existed,
    // that command performed a REAL release (version bump, commit, tag).
    // npm exports each flag as `npm_config_<name>`, which is the recovery
    // path — both spellings must therefore be honoured.
    const script = read("scripts/release.mjs");
    expect(script).toContain("npm_config_dry_run");
    expect(script).toContain("npm_config_push");
    expect(script).toMatch(/npmFlag\("dry_run"\)/);
    expect(script).toMatch(/npmFlag\("push"\)/);
  });

  it("tells maintainers to use the -- separator", () => {
    // The documented command must be the safe one, not merely a working one.
    // The unsafe spelling may still appear inside the warning that explains
    // it — but never as a bare instruction line in a shell block.
    expect(publishDoc).toContain("npm run release -- patch --dry-run");
    expect(publishDoc).toContain("npm run release -- patch --push");
    const commandLines = publishDoc
      .split("\n")
      .filter((line) => /^npm run release/.test(line.trim()));
    expect(commandLines.length).toBeGreaterThan(0);
    for (const line of commandLines) {
      expect(line, `missing "--": ${line}`).toMatch(/npm run release -- /);
    }
  });

  it("explains why the separator is required", () => {
    expect(publishDoc).toMatch(/`--` 不能省/);
  });

  it("refuses an empty [Unreleased] section", () => {
    // An empty section means empty GitHub Release notes, which the
    // changelog query would otherwise accept silently.
    const script = read("scripts/release.mjs");
    expect(script).toContain("Unreleased");
    expect(script).toContain("没有任何条目");
  });

  it("keeps both version fields in sync via npm version", () => {
    // package-lock.json carries the version twice; editing package.json by
    // hand is how the two drift apart.
    const script = read("scripts/release.mjs");
    expect(script).toContain("--no-git-tag-version");
    expect(script).toContain("--allow-same-version");
  });
});

describe("PUBLISH.md describes the bundle pipeline", () => {
  it("names the one-command release path", () => {
    expect(publishDoc).toContain("npm run release");
  });

  it("no longer tells maintainers to wait for CI after pushing a tag", () => {
    // The old instructions described a flow that could not work for a
    // standalone tag push. Mentioning `ci-green` in the "why this changed"
    // note is fine; presenting it as a pipeline step is not.
    expect(publishDoc).not.toMatch(/推 tag 后[^\n]*等 ?CI/);
    expect(publishDoc).not.toMatch(/^\s*\d+\.\s+\*\*`ci-green`\*\*/m);
  });

  it("documents the bundle → release → publish-npm chain", () => {
    expect(publishDoc).toMatch(/bundle → release → publish-npm/);
    // The drift guard must be stated where maintainers will read it.
    expect(publishDoc).toMatch(/`publish-npm` 等的是 `release`/);
  });
});
