/**
 * Multi-user isolation.
 *
 * One iLink bot can be messaged by several WeChat users. Each peer must get
 * its own conversation, outbound window/queue, and behaviour preferences —
 * none of them may see or consume another peer's state.
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

vi.mock("../src/weixin/api.js", () => ({
  sendTyping: () => Promise.resolve(undefined),
  getConfig: () => Promise.resolve({ typing_ticket: "tk" }),
  isSessionTimeoutError: () => false,
  isMessageLimitError: () => false,
  isInvalidRequestError: () => false,
}));

import { WeChatDSHBridge } from "../src/bridge/bridge.js";
import { defaultConfig } from "../src/config.js";
import { MessageType } from "../src/weixin/types.js";
import { StateStore, type UserState } from "../src/state.js";

function textMessage(from: string, text: string) {
  return {
    message_type: MessageType.USER,
    from_user_id: from,
    context_token: `ctx-${from}`,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

function makeBridge(storageDir?: string) {
  const dir = storageDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-multi-"));
  const live = new Map<string, unknown>();
  const agentsService = {
    create: async ({ sessionId }: { sessionId: string }) => {
      const agent = {
        id: sessionId,
        status: "idle",
        options: { provider: "deepseek", model: "deepseek-chat" },
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
        session: { header: { id: sessionId } },
      };
      live.set(sessionId, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId }: { resumeSessionId: string }) => {
      const agent = live.get(resumeSessionId) ?? {
        id: resumeSessionId,
        status: "idle",
        options: { provider: "deepseek", model: "deepseek-chat" },
        followup: () => {},
        steer: () => {},
        cancel: () => {},
        whenIdle: async () => {},
        session: { header: { id: resumeSessionId } },
      };
      live.set(resumeSessionId, agent);
      return { agent };
    },
    get: (id: string) => live.get(id),
    list: () => [...live.values()],
  };
  const ctx = {
    get: (name: string) => (name === "agents" ? agentsService : undefined),
    on: () => () => {},
  };
  const cfg = defaultConfig();
  cfg.storageDir = dir;
  cfg.mergeSilenceMs = 0;
  const bridge = new WeChatDSHBridge(ctx, cfg);
  (bridge as unknown as { token: unknown }).token = {
    baseUrl: "https://gw",
    token: "t",
    accountId: "b1",
    userId: "u",
    savedAt: "",
  };
  return { bridge, storageDir: dir };
}

type Internals = {
  handleMessage(m: unknown): Promise<void>;
  sendReply(userId: string, text: string): Promise<void>;
  channel(userId: string): { messageCount: number; queue: Array<{ kind: string; text: string }>; contextToken?: string };
  persistOutboundState(userId?: string): void;
  listRecentSessions(user: UserState): Promise<Array<{ header: { id: string } }>>;
  getStatus(): {
    users: Array<{
      userId: string;
      disabled: boolean;
      allowed: boolean;
      outbound?: { messageCount: number; queue: number };
      crossSessionNotify: boolean;
    }>;
  };
  updateUserConfig(userId: string, patch: Record<string, unknown>): { ok: boolean; message: string };
  removeUser(userId: string): { ok: boolean; message: string };
  setUserWorkspace(userId: string, cwd: string): { ok: boolean; message: string };
  isolateUserWorkspace(userId: string): { ok: boolean; message: string };
  newUserSession(userId: string): { ok: boolean; message: string };
  setUserAllowlisted(userId: string, allowed: boolean): { ok: boolean; message: string; allowedUsers: string[] };
  config: { silent: boolean; finalOnly: boolean; allowedUsers: string[] };
  state: {
    all(): UserState[];
    getUser(id: string): UserState | undefined;
    update(id: string, patch: Partial<UserState>): void;
    watchSession(id: string, sessionId: string): void;
    updatePrefs(id: string, patch: Record<string, unknown>): void;
  };
  outboundChannels: Map<string, { messageCount: number; queue: unknown[] }>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("multi-user: independent conversations", () => {
  it("serves two WeChat users with separate user state and session bindings", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;

    await b.handleMessage(textMessage("u1", "第一个人的任务"));
    await b.handleMessage(textMessage("u2", "第二个人的任务"));

    const users = b.state.all();
    expect(users.map((u) => u.userId).sort()).toEqual(["u1", "u2"]);
    const u1 = users.find((u) => u.userId === "u1")!;
    const u2 = users.find((u) => u.userId === "u2")!;
    expect(u1.sessionId).not.toBe("");
    expect(u2.sessionId).not.toBe("");
    expect(u1.sessionId).not.toBe(u2.sessionId);
  });

  it("gives every new user an automatic workspace under the bot's workspace", async () => {
    const { bridge, storageDir } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    const u1 = b.state.getUser("u1")!.cwd;
    const u2 = b.state.getUser("u2")!.cwd;
    expect(u1).not.toBe(u2);
    // <storageDir>/workspaces/<bot>-<hash>/<user>-<hash>
    expect(path.dirname(path.dirname(u1))).toBe(path.join(storageDir, "workspaces"));
    expect(path.dirname(path.dirname(u2))).toBe(path.join(storageDir, "workspaces"));
    expect(path.basename(path.dirname(u1))).toMatch(/^main-[0-9a-f]{8}$/);
    expect(path.basename(u1)).toMatch(/^u1-[0-9a-f]{8}$/);
    expect(fs.statSync(u1).isDirectory()).toBe(true);
    expect(fs.statSync(u2).isDirectory()).toBe(true);
  });

  it("does not let one user's exhausted window swallow another user's reply", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));

    // u1 has spent the whole 10-message window; u2 has not.
    b.channel("u1").messageCount = 10;
    await b.sendReply("u1", "a1");
    expect(b.channel("u1").queue).toHaveLength(1);
    expect(sendTextMessage).not.toHaveBeenCalled();

    await b.sendReply("u2", "b1");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0]![0]).toBe("u2");
    expect(b.channel("u2").messageCount).toBe(1);
    expect(b.channel("u1").queue).toHaveLength(1);
  });

  it("persists each user's send window and FIFO independently", async () => {
    const { bridge, storageDir } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));

    b.channel("u1").messageCount = 7;
    b.channel("u1").queue.push({ kind: "text", text: "u1-pending" });
    b.channel("u2").messageCount = 2;
    b.channel("u2").queue.push({ kind: "text", text: "u2-pending" });
    b.persistOutboundState();

    const restarted = makeBridge(storageDir).bridge as unknown as Internals;
    expect(restarted.channel("u1").messageCount).toBe(7);
    expect(restarted.channel("u2").messageCount).toBe(2);
    expect(restarted.channel("u1").queue).toEqual([{ kind: "text", text: "u1-pending" }]);
    expect(restarted.channel("u2").queue).toEqual([{ kind: "text", text: "u2-pending" }]);
  });
});

describe("multi-user: independent preferences", () => {
  it("/silent on for one user does not silence another (and does not rewrite the default)", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "/silent on"));
    expect(b.state.all()).toHaveLength(1);
    await b.handleMessage(textMessage("u2", "/silent status"));

    const texts = sendTextMessage.mock.calls.map((c) => String(c[1]));
    expect(texts.some((t) => t.includes("静默模式已开启"))).toBe(true);
    const u2Status = texts.find((t) => t.includes("静默模式:"));
    expect(u2Status).toContain("off");
    // With two peers, a per-user toggle must leave the deployment default alone.
    expect(b.config.silent).toBe(false);
    expect(b.state.all().find((u) => u.userId === "u1")!.prefs?.silent).toBe(true);
    expect(b.state.all().find((u) => u.userId === "u2")!.prefs?.silent).toBeUndefined();
  });

  it("/status shows every user's own effective switches", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    b.state.updatePrefs("u1", { silent: true, finalOnly: true });

    await b.handleMessage(textMessage("u1", "/status"));
    const replies = sendTextMessage.mock.calls.map((c) => String(c[1]));
    const status = replies.reverse().find((t) => t.includes("静默模式"));
    expect(status).toBeDefined();
    expect(status).toMatch(/静默模式: .*on/);
    expect(status).toMatch(/结论模式: .*on/);
  });
});

describe("multi-user: session ownership", () => {
  it("lists only the sessions the user owns once there is more than one peer", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    const u1 = b.state.all().find((u) => u.userId === "u1")!;
    const u2 = b.state.all().find((u) => u.userId === "u2")!;

    // Three sessions exist in DSH; each user owns one of them.
    const ops = (bridge as unknown as {
      ops: {
        listSessions: () => Promise<unknown[]>;
        readSessionListFacts: () => Promise<unknown>;
        lastUserMessageTime: () => Promise<number>;
        listPresets: () => Promise<unknown[]>;
      };
    }).ops;
    ops.listSessions = async () => [
      { header: { id: "s-u1", cwd: "C:\\work", createdAt: 1 }, live: true, persisted: true },
      { header: { id: "s-u2", cwd: "C:\\work", createdAt: 2 }, live: true, persisted: true },
      { header: { id: "s-other", cwd: "C:\\work", createdAt: 3 }, live: true, persisted: true },
    ];
    ops.readSessionListFacts = async () => ({ title: "t" });
    ops.lastUserMessageTime = async () => 1;
    ops.listPresets = async () => [];
    b.state.watchSession("u1", "s-u1");
    b.state.watchSession("u2", "s-u2");

    const u1Rows = await b.listRecentSessions(u1);
    const u2Rows = await b.listRecentSessions(u2);
    expect(u1Rows.map((r) => r.header.id)).toEqual(["s-u1"]);
    expect(u2Rows.map((r) => r.header.id)).toEqual(["s-u2"]);
  });
});

describe("multi-user: account management", () => {
  it("pauses one account without touching the other", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    const u1Session = b.state.getUser("u1")!.sessionId;

    expect(b.updateUserConfig("u1", { disabled: true }).ok).toBe(true);
    sendTextMessage.mockClear();

    await b.handleMessage(textMessage("u1", "这条应该被忽略"));
    await b.sendReply("u1", "这条也不该发出");
    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(b.state.getUser("u1")!.sessionId).toBe(u1Session);

    // u2 is unaffected.
    await b.sendReply("u2", "u2 still works");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0]![0]).toBe("u2");

    const row = b.getStatus().users.find((u) => u.userId === "u1")!;
    expect(row.disabled).toBe(true);
    expect(row.crossSessionNotify).toBe(false);

    // Enabling it again restores delivery without recreating the binding.
    expect(b.updateUserConfig("u1", { disabled: false }).ok).toBe(true);
    await b.sendReply("u1", "welcome back");
    expect(sendTextMessage).toHaveBeenCalledWith("u1", "welcome back", expect.anything());
  });

  it("removes bridge state and the queue without deleting other users", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    b.channel("u1").queue.push({ kind: "text", text: "pending" });

    const result = b.removeUser("u1");
    expect(result.ok).toBe(true);
    expect(b.state.getUser("u1")).toBeUndefined();
    expect(b.outboundChannels.has("u1")).toBe(false);
    expect(b.state.getUser("u2")).toBeDefined();
    expect(b.getStatus().users.map((u) => u.userId)).toEqual(["u2"]);
  });

  it("manages the allowlist per user and refuses to empty it", () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    expect(b.config.allowedUsers).toEqual([]);

    expect(b.setUserAllowlisted("u1", true).allowedUsers).toEqual(["u1"]);
    // Removing the only entry would flip the list back to "open to all",
    // the opposite of revoking it.
    expect(b.setUserAllowlisted("u1", false).ok).toBe(false);
    expect(b.config.allowedUsers).toEqual(["u1"]);
    expect(b.setUserAllowlisted("u2", true).allowedUsers).toEqual(["u1", "u2"]);
    expect(b.setUserAllowlisted("u1", false).allowedUsers).toEqual(["u2"]);
  });

  it("changes one account's workspace without touching the other", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    await b.handleMessage(textMessage("u2", "hi"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-ws-"));
    const beforeU2 = b.state.getUser("u2")!.cwd;
    // Automatic per-user workspaces already gave the two accounts different
    // directories on first contact.
    expect(b.state.getUser("u1")!.cwd).not.toBe(beforeU2);

    const result = b.setUserWorkspace("u1", other);
    expect(result.ok).toBe(true);
    expect(b.state.getUser("u1")!.cwd).toBe(other);
    expect(b.state.getUser("u1")!.sessionId).toBe("");
    // The other account keeps its own workspace and binding.
    expect(b.state.getUser("u2")!.cwd).toBe(beforeU2);
    expect(b.state.getUser("u2")!.sessionId).not.toBe("");

    expect(b.setUserWorkspace("u1", path.join(other, "does-not-exist")).ok).toBe(false);
  });

  it("can give an existing account its automatic isolated workspace", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    const custom = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-custom-"));
    b.setUserWorkspace("u1", custom);
    const before = b.state.getUser("u1")!.cwd;
    const result = b.isolateUserWorkspace("u1");
    expect(result.ok).toBe(true);
    const after = b.state.getUser("u1")!.cwd;
    expect(after).not.toBe(before);
    expect(path.basename(after)).toMatch(/^u1-[0-9a-f]{8}$/);
    expect(b.state.getUser("u1")!.sessionId).toBe("");
    expect(fs.statSync(after).isDirectory()).toBe(true);
  });

  it("starts a fresh context for one account while keeping its old session in DSH", async () => {
    const { bridge } = makeBridge();
    const b = bridge as unknown as Internals;
    await b.handleMessage(textMessage("u1", "hi"));
    const old = b.state.getUser("u1")!.sessionId;

    const result = b.newUserSession("u1");
    expect(result.ok).toBe(true);
    expect(b.state.getUser("u1")!.sessionId).toBe("");
    // The old session id remains in the owned history; it is unbound, not deleted.
    expect(b.state.getUser("u1")!.watchedSessions).toContain(old);
  });
});

describe("multi-user: allowlist seeding", () => {
  it("keeps a fresh empty allowlist open across restarts (schema-marked state)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-multi-seed-"));
    const store = new StateStore(dir);
    store.ensureUser("u1", "C:\\work");
    // A file written by the current version must NOT trigger the one-time
    // upgrade seeding, otherwise an open install would silently lock itself
    // down after the first restart.
    expect(new StateStore(dir).needsAllowlistSeed()).toBe(false);
  });

  it("still seeds a pre-multi-user state file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wx-multi-seed-"));
    const store = new StateStore(dir);
    store.ensureUser("u1", "C:\\work");
    const statePath = path.join(dir, "state.json");
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Record<string, unknown>;
    delete raw.schemaVersion;
    fs.writeFileSync(statePath, JSON.stringify(raw), "utf-8");
    expect(new StateStore(dir).needsAllowlistSeed()).toBe(true);
  });
});
