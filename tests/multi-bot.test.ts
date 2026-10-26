/**
 * Multiple bot accounts online at once.
 *
 * Each bot gets its own storage directory and `WeChatDSHBridge`, so users,
 * sessions, workspaces, queues and config never cross between bot accounts.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const sendTextMessage = vi.fn().mockResolvedValue(undefined);
const sendMediaMessage = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/weixin/send.js", () => ({
  sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
  sendMediaMessage: (...args: unknown[]) => sendMediaMessage(...args),
  splitText: (text: string, maxLen: number) =>
    text.length <= maxLen ? [text] : [text.slice(0, maxLen), text.slice(maxLen)],
}));

vi.mock("../src/weixin/monitor.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/weixin/monitor.js")>();
  return {
    ...orig,
    startMonitor: vi.fn(async () => {}),
  };
});

import { WeChatBotManager } from "../src/bridge/manager.js";
import { defaultConfig } from "../src/config.js";

function token(accountId: string) {
  return {
    token: `t-${accountId}`,
    baseUrl: "https://gw",
    accountId,
    userId: "user",
    savedAt: "",
  };
}

function seedBot(root: string, id: string, accountId: string, userId: string, cwd: string) {
  const dir = path.join(root, "bots", id);
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "auth", "token.json"), JSON.stringify(token(accountId)), "utf-8");
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    schemaVersion: 2,
    botAccountId: accountId,
    users: {
      [userId]: {
        userId,
        sessionId: `session-${id}`,
        cwd,
        silent: false,
        crossSessionNotify: "inherit",
        watchedSessions: [`session-${id}`],
        prefs: {},
      },
    },
    outboundByUser: {},
  }, null, 2), "utf-8");
  return { id, label: `Bot ${id}`, createdAt: Date.now(), accountId };
}

function makeManager() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-bots-"));
  const bots = [
    seedBot(root, "alpha", "acct-alpha", "user-alpha", path.join(root, "ws-alpha")),
    seedBot(root, "beta", "acct-beta", "user-beta", path.join(root, "ws-beta")),
  ];
  fs.writeFileSync(path.join(root, "bots.json"), JSON.stringify({ version: 1, bots }, null, 2), "utf-8");
  const cfg = defaultConfig();
  cfg.storageDir = root;
  cfg.cwd = root;
  const manager = new WeChatBotManager({ get: () => undefined, on: () => () => {} }, cfg);
  manager.start();
  return { manager, root, bots };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("multi-bot manager", () => {
  it("ignores unsafe or duplicate bot ids before constructing storage paths", () => {
    const { manager, root } = makeManager();
    const records = [
      { id: "../outside", label: "escape", createdAt: 1 },
      { id: "..\\outside", label: "escape", createdAt: 1 },
      { id: "alpha", label: "one", createdAt: 1 },
      { id: "ALPHA", label: "same on Windows", createdAt: 1 },
      { id: "alpha", label: "duplicate", createdAt: 1 },
    ];
    fs.writeFileSync(path.join(root, "bots.json"), JSON.stringify({ version: 1, bots: records }));
    expect((manager as any).loadRegistry().map((record: any) => record.id)).toEqual(["alpha"]);
  });
  it("loads every bot from bots.json with its own account and user set", () => {
    const { manager, root } = makeManager();
    const bots = manager.listBots();
    expect(bots).toHaveLength(2);
    const alpha = bots.find((b) => b.id === "alpha") as any;
    const beta = bots.find((b) => b.id === "beta") as any;
    expect(alpha.accountId).toBe("acct-alpha");
    expect(beta.accountId).toBe("acct-beta");
    expect(alpha.users.map((u: any) => u.userId)).toEqual(["user-alpha"]);
    expect(beta.users.map((u: any) => u.userId)).toEqual(["user-beta"]);
    expect(alpha.users[0].cwd).toBe(path.join(root, "ws-alpha"));
    expect(beta.users[0].cwd).toBe(path.join(root, "ws-beta"));
    expect(alpha.users[0].sessionId).not.toBe(beta.users[0].sessionId);
  });

  it("routes a session to its owning bot only", () => {
    const { manager } = makeManager();
    const alpha = manager.listBots().find((b) => b.id === "alpha") as any;
    const beta = manager.listBots().find((b) => b.id === "beta") as any;
    // The prompt/session lookups only answer for the owning bot.
    expect(manager.surfaceSourceFor(alpha.users[0].sessionId)).toBeUndefined();
    expect(manager.surfacePromptFor(alpha.users[0].sessionId).enabled).toBe(false);
    expect(manager.surfacePromptFor("session-unknown").enabled).toBe(false);
    expect(beta.users[0].sessionId).not.toBe(alpha.users[0].sessionId);
  });

  it("migrates a legacy single-bot layout into bots/main", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-bots-legacy-"));
    fs.mkdirSync(path.join(root, "auth"), { recursive: true });
    fs.writeFileSync(path.join(root, "auth", "token.json"), JSON.stringify(token("legacy-acct")), "utf-8");
    fs.writeFileSync(path.join(root, "state.json"), JSON.stringify({
      schemaVersion: 2,
      users: {
        legacy: {
          userId: "legacy",
          sessionId: "session-legacy",
          cwd: root,
          silent: false,
          crossSessionNotify: "inherit",
          watchedSessions: ["session-legacy"],
          prefs: {},
        },
      },
    }), "utf-8");
    const cfg = defaultConfig();
    cfg.storageDir = root;
    const manager = new WeChatBotManager({ get: () => undefined, on: () => () => {} }, cfg);
    manager.start();
    const bots = manager.listBots();
    expect(bots).toHaveLength(1);
    expect(bots[0]!.id).toBe("main");
    expect((bots[0] as any).accountId).toBe("legacy-acct");
    expect((bots[0] as any).users.map((u: any) => u.userId)).toEqual(["legacy"]);
    // Copied, not moved, so the legacy files remain as a backup.
    expect(fs.existsSync(path.join(root, "auth", "token.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "bots", "main", "auth", "token.json"))).toBe(true);
  });

  it("removes one bot without touching the other", async () => {
    const { manager } = makeManager();
    const result = await manager.removeBot("alpha");
    expect(result.ok).toBe(true);
    expect(manager.listBots().map((b) => b.id)).toEqual(["beta"]);
    expect(fs.existsSync(path.join((manager as any).botsDir, "alpha"))).toBe(true);
  });
});
