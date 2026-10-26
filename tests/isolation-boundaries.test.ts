import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { WeChatBotManager } from "../src/bridge/manager.js";
import { defaultConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-boundary-"));
  const own = path.join(root, "alice");
  const other = path.join(root, "bob");
  fs.mkdirSync(own);
  fs.mkdirSync(other);
  const config = { ...defaultConfig(), storageDir: path.join(root, "store"), cwd: own };
  const bridge = new WeChatDSHBridge({ get: () => undefined, on: () => () => {} }, config);
  // Private entry points are exercised with synthetic host services only.
  const b = bridge as any;
  const user = b.state.ensureUser("alice", own);
  b.state.update("alice", { sessionId: "alice-current", watchedSessions: ["alice-current", "alice-old"] });
  const records = [
    { header: { id: "alice-current", cwd: own, createdAt: 1 } },
    { header: { id: "alice-old", cwd: own, createdAt: 2 } },
    { header: { id: "bob-private", cwd: other, createdAt: 3 } },
    { header: { id: "gui-private", cwd: own, createdAt: 4 } },
  ];
  b.ops.listSessions = async () => records;
  b.ops.lastUserMessageTime = async () => undefined;
  b.ops.pinnedSessionIds = () => [];
  b.ops.archivedSessionIds = () => [];
  b.ops.listWorkspaces = () => [
    { id: "own", path: own, title: "Alice", sessionIds: ["alice-old", "gui-private"] },
    { id: "other", path: other, title: "Bob", sessionIds: ["bob-private"] },
  ];
  b.ops.findSessionRecord = async (id: string) => records.find(r => r.header.id === id);
  b.ops.inspectSessionActivity = async () => ({ ok: true });
  b.sendReply = vi.fn().mockResolvedValue(undefined);
  return { b, bridge, config, user, root, own, other };
}

describe("session boundaries", () => {
  it("never exposes another bot or GUI session when this bot has only one user", async () => {
    const { b, user } = fixture();
    expect(b.state.all()).toHaveLength(1);
    expect((await b.listRecentSessions(user)).map((r: any) => r.header.id).sort())
      .toEqual(["alice-current", "alice-old"]);
    expect(b.recipientForSession("bob-private")).toBeUndefined();
    expect(b.resolveUserForAgent("gui-private")).toBeUndefined();
  });

  it("rejects a stale list snapshot containing a session no longer owned", async () => {
    const { b, user } = fixture();
    b.lastSessionListByUser.set("alice", { sessionIds: ["alice-old", "bob-private"] });
    expect(await b.sessionsFromLastList(user)).toBeUndefined();
  });

  it("does not restore or reuse a foreign session even in the same directory", async () => {
    const { b, user, own } = fixture();
    b.state.update("alice", { sessionId: "", watchedSessions: [] });
    expect(await b.switchUserWorkspace(user, own)).toBe("");
    expect(await b.findBlankSession(own, user)).toBeUndefined();
  });

  it("filters native session-reference candidates and accepts owned candidates", async () => {
    const { b, user } = fixture();
    b.agents.get = () => ({ id: "alice-current" });
    b.ops.sessionReferenceResolver = () => ({ listCandidates: async () => [
      { sessionId: "bob-private", label: "Private" },
      { sessionId: "alice-old", label: "Mine" },
    ] });
    expect(await b.resolveAtSessionTarget(user, "report")).toMatchObject({ kind: "ok", sessionId: "alice-old" });
    b.ops.sessionReferenceResolver = () => ({ listCandidates: async () => [
      { sessionId: "bob-private", label: "Private" },
    ] });
    expect(await b.resolveAtSessionTarget(user, "private")).toMatchObject({ kind: "error" });
  });

  it("checks final reference ownership even if a resolver returns a foreign session", async () => {
    const { b, user } = fixture();
    b.ops.sessionReferenceResolver = () => ({});
    b.resolveAtSessionTarget = async () => ({ kind: "ok", sessionId: "bob-private" });
    await b.stageSessionRef("alice", user, "private");
    expect(b.sendReply).toHaveBeenCalledWith("alice", expect.stringContaining("只能引用你自己的会话"));
    expect(b.pendingRefs.get("alice")).toBeUndefined();
  });
});

describe("assigned workspace boundaries", () => {
  it("lists only assigned workspaces and rejects an external switch or add before creating it", async () => {
    const { b, other } = fixture();
    b.ops.createWorkspace = vi.fn();
    await b.handleWorkspaceCommand("alice", { kind: "list" });
    expect(b.sendReply.mock.calls.at(-1)[1]).toContain("Alice");
    expect(b.sendReply.mock.calls.at(-1)[1]).not.toContain("Bob");
    for (const kind of ["switch", "add"]) {
      await b.handleWorkspaceCommand("alice", { kind, target: other, path: other });
      expect(b.sendReply.mock.calls.at(-1)[1]).toContain("超出管理员分配的目录范围");
    }
    expect(b.ops.createWorkspace).not.toHaveBeenCalled();
  });

  it("keeps its assigned root through a child switch and restart", async () => {
    const { b, user, config, own } = fixture();
    const child = path.join(own, "child");
    fs.mkdirSync(child);
    await b.switchUserWorkspace(user, child);
    expect(await b.userPathAllowed(user, own)).toBe(true);
    const restored = new StateStore(config.storageDir).getUser("alice")!;
    expect(restored.cwd).toBe(child);
    expect(restored.workspaceRoot).toBe(own);
    await b.switchUserWorkspace(restored, own);
    expect(restored.cwd).toBe(own);
  });

  it("allows an administrator to reassign the root, clearing pending references", async () => {
    const { b, user, other, own, config } = fixture();
    b.pendingRefs.set("alice", { files: [], sessions: [] });
    expect(b.setUserWorkspace("alice", other).ok).toBe(true);
    expect(b.pendingRefs.has("alice")).toBe(false);
    expect(await b.userPathAllowed(user, own)).toBe(false);
    expect(new StateStore(config.storageDir).getUser("alice")!.workspaceRoot).toBe(other);
  });

  it("rejects other registered workspace files and accepts the calling owner's file", async () => {
    const { b, other, own } = fixture();
    const privateFile = path.join(other, "private.txt");
    const ownFile = path.join(own, "report.txt");
    fs.writeFileSync(privateFile, "synthetic private data");
    fs.writeFileSync(ownFile, "synthetic report");
    expect(await b.guardOutgoingFile("alice-current", privateFile)).toContain("refused");
    expect(await b.guardOutgoingFile("alice-current", ownFile)).toBeUndefined();
    expect(await b.guardOutgoingFile("unknown-session", ownFile)).toContain("refused");
  });

  it("rejects traversal and symlink/junction escapes for files, refs and workspace selection", async () => {
    const { b, user, other, own } = fixture();
    const link = path.join(own, "shortcut");
    fs.symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(other, "private.txt");
    fs.writeFileSync(target, "synthetic data");
    expect(await b.guardOutgoingFile("alice-current", path.join(link, "private.txt"))).toContain("refused");
    expect(await b.userPathAllowed(user, link)).toBe(false);
    expect(await b.userPathAllowed(user, path.join(own, "..", "bob"))).toBe(false);
    await b.stageFileRef("alice", user, path.join(link, "private.txt"));
    expect(b.sendReply.mock.calls.at(-1)[1]).toContain("超出管理员分配的目录范围");
    expect(b.pendingRefs.get("alice")).toBeUndefined();
  });

  it("drops a persisted file queue after the administrator revokes its directory", async () => {
    const { b, other, own } = fixture();
    const file = path.join(own, "queued.txt");
    fs.writeFileSync(file, "synthetic data");
    b.channel("alice").queue.push({ kind: "file", filePath: file, fileName: "queued.txt" });
    b.persistOutboundState("alice");
    b.setUserWorkspace("alice", other);
    b.token = { token: "synthetic", baseUrl: "https://invalid.example" };
    await b.flushPending("alice", { silent: true });
    expect(b.channel("alice").queue).toEqual([]);
    expect(b.channel("alice").messageCount).toBe(0);
  });
});

describe("bot command injection lifecycle", () => {
  it.each([true, false])("retains command service when attached before start=%s and on new bots", async (beforeStart) => {
    vi.spyOn(WeChatDSHBridge.prototype, "start").mockResolvedValue(undefined);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-commands-"));
    const manager = new WeChatBotManager({ get: () => undefined, on: () => () => {} }, {
      ...defaultConfig(), storageDir: root,
    });
    const commands = { find: vi.fn(() => ({})), execute: vi.fn(async () => ({ result: { kind: "success", text: "native reply" } })) };
    if (beforeStart) manager.attachCommands(commands);
    manager.start();
    if (!beforeStart) manager.attachCommands(commands);
    await manager.addBot("New bot");
    try {
      for (const runtime of (manager as any).runtimes.values()) {
        const b = runtime.bridge;
        const user = b.state.ensureUser("alice", root);
        b.agents.ensure = async () => ({ agent: { id: "own-session" } });
        b.sendReply = vi.fn().mockResolvedValue(undefined);
        expect(await b.tryNativeCommand(user, "alice", "/plan on")).toBe(true);
        expect(b.sendReply).toHaveBeenCalledWith("alice", "native reply");
      }
      expect(commands.execute).toHaveBeenCalledTimes(2);
      manager.attachCommands(null);
      for (const runtime of (manager as any).runtimes.values()) expect(runtime.bridge.commandsCtx).toBeNull();
    } finally {
      await manager.stop();
    }
  });
});
