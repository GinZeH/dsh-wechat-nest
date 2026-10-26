import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, name } from "../src/index.js";
import { defaultStorageDir } from "../src/config.js";
import { WeChatBotManager } from "../src/bridge/manager.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

afterEach(() => vi.restoreAllMocks());

describe("WeChat Nest host/client identity", () => {
  it("uses the same identity for the package, host export, bundle and client loader", () => {
    expect(pkg.name).toBe("dsh-wechat-nest");
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].name).toBe(pkg.name);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(name).toBe(pkg.name);
    const patch = fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8");
    expect(patch).toContain(`id: ${pkg.name}`);
    expect(patch).toContain(`name: '${pkg.name}'`);
    const client = fs.readFileSync(path.join(root, "src/client.js"), "utf8");
    let moduleId: string | undefined;
    new Function("window", client)({
      __ModuleLoader__: { load: (spec: { id: string }) => { moduleId = spec.id; } },
    });
    expect(moduleId).toBe(pkg.name);
    expect(defaultStorageDir()).toBe(path.join(os.homedir(), `.${pkg.name}`));
    expect(pkg.repository.url).toBe("git+https://github.com/GinZeH/dsh-wechat-nest.git");
  });

  it("serves the branded QR page and API exclusively under the new namespace", async () => {
    vi.spyOn(WeChatBotManager.prototype, "start").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => void }> = [];
    const tools: string[] = [];
    const effects: Array<() => void> = [];
    const contexts: string[] = [];
    const services: Record<string, unknown> = {
      webServer: { register: (route: (typeof routes)[number]) => routes.push(route) },
      tools: { register: (definition: { name: string }) => { tools.push(definition.name); return () => {}; } },
      systemPrompt: { context: (entry: { name: string }) => contexts.push(entry.name) },
    };
    const ctx = {
      get: (key: string) => services[key],
      on: () => () => {},
      inject: (_deps: string[], callback: (context: unknown) => unknown) => callback(ctx),
      effect: (callback: () => unknown) => {
        const dispose = callback();
        if (typeof dispose === "function") effects.push(dispose as () => void);
      },
    };
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-nest-brand-"));
    const stop = apply(ctx, { storageDir });
    try {
      expect(tools).toEqual(["wechat_nest_send"]);
      expect(contexts).toEqual(["dsh-wechat-nest-surface"]);
      expect(routes.length).toBeGreaterThan(5);
      expect(routes.every(route => route.path.startsWith("/wechat-nest/"))).toBe(true);
      expect(new Set(routes.map(route => route.path)).size).toBe(routes.length);
      const qr = routes.find(route => route.path === "/wechat-nest/qr")!;
      let body = "";
      qr.handler({}, { setHeader: () => {}, end: (value: string) => { body = value; } });
      expect(body).toContain("微巢");
      expect(body).toContain("fetch('/wechat-nest/status')");
      expect(body).toContain("/wechat-nest/api/qr-image");
      expect(body).not.toContain("/wechat/");
      const client = fs.readFileSync(path.join(root, "src/client.js"), "utf8");
      expect(client).toContain('fetch("/wechat-nest/api" + path');
      expect(client).not.toContain('fetch("/wechat/api"');
    } finally {
      await stop();
      for (const dispose of effects) dispose();
    }
  });
});
