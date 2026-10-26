/**
 * Multi-bot manager.
 *
 * One DSH profile can host several iLink bot accounts at the same time. Each
 * bot gets its own storage directory (`~/.dsh-wechat-nest/bots/<id>/`) containing
 * its token, long-poll cursor, config, user state and outbound queues, and its
 * own `WeChatDSHBridge` instance. Nothing user-visible is shared between bots:
 * different bot accounts can serve different WeChat users with independent
 * sessions, workspaces and memory.
 *
 * A tiny registry at `~/.dsh-wechat-nest/bots.json` remembers the account list so
 * the next DSH start brings every bot back. The legacy single-bot layout
 * (token/state/config at the storage root) is migrated to the `main` bot on
 * first load.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WeChatDSHBridge } from "./bridge.js";
import type { BridgeContext } from "../dsh/sessions.js";
import { ConfigStore, type EditableConfig } from "../config-store.js";
import type { WeChatDSHConfig } from "../config.js";
import { ensurePrivateDir, writePrivateFile } from "../utils/secure-fs.js";
import { botWorkspaceDir, effectiveWorkspaceRoot } from "../workspace-paths.js";

interface BotRecord {
  id: string;
  label: string;
  createdAt: number;
  /** The iLink bot account id, once the QR login has completed. */
  accountId?: string;
}

interface BotRuntime {
  record: BotRecord;
  dir: string;
  workspace: string;
  store: ConfigStore;
  bridge: WeChatDSHBridge;
}

interface RegistryFile {
  version: 1;
  bots: BotRecord[];
}

const REGISTRY_VERSION = 1;

function safeBotId(): string {
  return `bot-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

export class WeChatBotManager {
  private readonly ctx: BridgeContext;
  private readonly baseConfig: WeChatDSHConfig;
  private readonly rootDir: string;
  private readonly botsDir: string;
  private readonly registryPath: string;
  /** Root config, used as the seed for every newly created bot account. */
  private readonly rootStore: ConfigStore;
  private readonly runtimes = new Map<string, BotRuntime>();
  private started = false;
  private commands: Parameters<WeChatDSHBridge["attachCommands"]>[0] = null;

  constructor(ctx: BridgeContext, baseConfig: WeChatDSHConfig) {
    this.ctx = ctx;
    this.baseConfig = baseConfig;
    this.rootDir = baseConfig.storageDir;
    this.botsDir = path.join(this.rootDir, "bots");
    this.registryPath = path.join(this.rootDir, "bots.json");
    this.rootStore = new ConfigStore(this.rootDir);
  }

  // ─── Registry ───

  private loadRegistry(): BotRecord[] {
    try {
      if (fs.existsSync(this.registryPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.registryPath, "utf-8")) as RegistryFile;
        if (parsed && Array.isArray(parsed.bots)) {
          const seen = new Set<string>();
          return parsed.bots.filter((bot): bot is BotRecord =>
            !!bot && typeof bot.id === "string"
            && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(bot.id)
            && !seen.has(bot.id.toLowerCase())
            && !!seen.add(bot.id.toLowerCase()));
        }
      }
    } catch {
      // fall through to migration
    }
    return this.migrateLegacy();
  }

  /**
   * First run of the multi-bot version. If the old single-bot files exist,
   * copy them into `bots/main/`; otherwise create an empty `main` bot so the
   * existing "install → scan QR" flow still works.
   */
  private migrateLegacy(): BotRecord[] {
    const record: BotRecord = {
      id: "main",
      label: "Bot 1",
      createdAt: Date.now(),
    };
    const dir = path.join(this.botsDir, record.id);
    ensurePrivateDir(dir);
    for (const relative of ["auth/token.json", "state.json", "config.json", "sync-buf.json"]) {
      const source = path.join(this.rootDir, relative);
      const target = path.join(dir, relative);
      try {
        if (!fs.existsSync(source)) continue;
        ensurePrivateDir(path.dirname(target));
        fs.copyFileSync(source, target);
      } catch {
        // best effort: a missing copy just starts that bot from defaults
      }
    }
    this.writeRegistry([record]);
    return [record];
  }

  private writeRegistry(bots: BotRecord[]): void {
    ensurePrivateDir(this.rootDir);
    const data: RegistryFile = { version: REGISTRY_VERSION, bots };
    writePrivateFile(this.registryPath, JSON.stringify(data, null, 2));
  }

  private saveRecord(record: BotRecord): void {
    const records = this.records().map((item) => item.id === record.id ? record : item);
    this.writeRegistry(records);
  }

  private records(): BotRecord[] {
    return [...this.runtimes.values()].map((runtime) => runtime.record);
  }

  // ─── Lifecycle ───

  private createRuntime(record: BotRecord, seedFromRoot: boolean): BotRuntime {
    const dir = path.join(this.botsDir, record.id);
    ensurePrivateDir(dir);
    const store = new ConfigStore(dir);
    if (seedFromRoot) {
      const seed = this.rootStore.stored();
      if (Object.keys(seed).length > 0) store.update(seed);
    }
    const config = store.resolve({
      ...this.baseConfig,
      storageDir: dir,
    });
    // The automatic workspace root is shared by all bots in this install.
    // A per-bot config can override it; empty means `<root>/workspaces`.
    if (!config.workspaceRoot) config.workspaceRoot = path.join(this.rootDir, "workspaces");
    const workspace = botWorkspaceDir(
      effectiveWorkspaceRoot(config.workspaceRoot, config.storageDir),
      record.id,
    );
    try {
      ensurePrivateDir(workspace);
    } catch (err) {
      console.error(`[dsh-wechat-nest] bot ${record.id} workspace create failed: ${String(err)}`);
    }
    const bridge = new WeChatDSHBridge(this.ctx, config, undefined, store, record.id);
    bridge.attachCommands(this.commands);
    const runtime: BotRuntime = { record, dir, workspace, store, bridge };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  /** Create every configured bot and start those that have a token / QR flow. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const records = this.loadRegistry();
    for (const record of records) {
      const runtime = this.createRuntime(record, false);
      void runtime.bridge.start().catch((err) => {
        console.error(`[dsh-wechat-nest] bot ${record.id} start failed: ${String(err)}`);
      });
    }
    // Refresh labels/account ids once the QR flows have had a moment to run.
    setTimeout(() => this.refreshAccountIds(), 1500).unref?.();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.bridge.stop().catch(() => {})));
    this.runtimes.clear();
    this.started = false;
  }

  /** Update registry account ids after a login completes. */
  private refreshAccountIds(): void {
    for (const runtime of this.runtimes.values()) {
      const accountId = runtime.bridge.getStatus().botId;
      if (typeof accountId === "string" && accountId && accountId !== runtime.record.accountId) {
        runtime.record.accountId = accountId;
        try {
          this.saveRecord(runtime.record);
        } catch {
          // registry write failure is non-fatal
        }
      }
    }
  }

  // ─── Views / lookups ───

  private view(runtime: BotRuntime): Record<string, unknown> {
    const status = runtime.bridge.getStatus();
    const accountId = typeof status.botId === "string" ? status.botId : runtime.record.accountId;
    if (accountId && accountId !== runtime.record.accountId) {
      runtime.record.accountId = accountId;
      try {
        this.saveRecord(runtime.record);
      } catch {
        // non-fatal
      }
    }
    return {
      id: runtime.record.id,
      label: runtime.record.label,
      accountId: accountId ?? null,
      createdAt: runtime.record.createdAt,
      ...status,
    };
  }

  listBots(): Array<Record<string, unknown>> {
    return [...this.runtimes.values()].map((runtime) => this.view(runtime));
  }

  getStatus(): Record<string, unknown> {
    const bots = this.listBots();
    return {
      count: bots.length,
      bots,
      // Kept for the standalone QR page and older tooling: the first bot's
      // login phase, if there is one.
      ...(bots[0] ?? {}),
    };
  }

  private runtime(botId: string): BotRuntime | undefined {
    return this.runtimes.get(botId);
  }

  private soleOrNamed(botId?: string): BotRuntime | undefined {
    if (botId) return this.runtime(botId);
    const all = [...this.runtimes.values()];
    return all.length === 1 ? all[0] : undefined;
  }

  // ─── Bot actions ───

  async addBot(label?: string): Promise<Record<string, unknown>> {
    const record: BotRecord = {
      id: safeBotId(),
      label: label?.trim() || `Bot ${this.runtimes.size + 1}`,
      createdAt: Date.now(),
    };
    const runtime = this.createRuntime(record, true);
    // A new bot starts with its own fallback workspace, not the root/default
    // directory another bot may be using. New users then get a per-user
    // subdirectory under it (autoUserWorkspace).
    try {
      runtime.store.update({ cwd: runtime.workspace });
      await runtime.bridge.updateConfig({ cwd: runtime.workspace });
    } catch (err) {
      console.error(`[dsh-wechat-nest] bot ${record.id} workspace init failed: ${String(err)}`);
    }
    this.saveRecord(record);
    void runtime.bridge.start().catch((err) => {
      console.error(`[dsh-wechat-nest] bot ${record.id} start failed: ${String(err)}`);
    });
    return this.view(runtime);
  }

  async removeBot(botId: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtime(botId);
    if (!runtime) return { ok: false, message: `未找到 bot ${botId}` };
    await runtime.bridge.stop().catch(() => {});
    this.runtimes.delete(botId);
    try {
      this.writeRegistry(this.records());
    } catch (err) {
      return { ok: false, message: `已停止，但保存 bots.json 失败: ${String(err)}` };
    }
    return { ok: true, message: "已移除该 bot（磁盘上的登录与状态文件保留，便于恢复）" };
  }

  async relogin(botId: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtime(botId);
    if (!runtime) return { ok: false, message: `未找到 bot ${botId}` };
    return runtime.bridge.relogin();
  }

  async logout(botId: string): Promise<{ ok: boolean; message: string }> {
    const runtime = this.runtime(botId);
    if (!runtime) return { ok: false, message: `未找到 bot ${botId}` };
    return runtime.bridge.logout();
  }

  getQrUrl(botId?: string): string | undefined {
    const runtime = this.soleOrNamed(botId);
    if (runtime) {
      const qr = runtime.bridge.getStatus().qrUrl;
      if (typeof qr === "string" && qr) return qr;
      return undefined;
    }
    for (const candidate of this.runtimes.values()) {
      const qr = candidate.bridge.getStatus().qrUrl;
      if (typeof qr === "string" && qr) return qr;
    }
    return undefined;
  }

  async updateConfig(botId: string | undefined, patch: Partial<EditableConfig>): Promise<{ config: Record<string, unknown>; message: string }> {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) throw new Error(botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId");
    const stored = runtime.store.update(patch);
    return runtime.bridge.updateConfig(stored);
  }

  updateUserConfig(botId: string | undefined, userId: string, patch: Parameters<WeChatDSHBridge["updateUserConfig"]>[1]) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId" };
    return runtime.bridge.updateUserConfig(userId, patch);
  }

  removeUser(botId: string | undefined, userId: string) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId" };
    return runtime.bridge.removeUser(userId);
  }

  setUserAllowlisted(botId: string | undefined, userId: string, allowed: boolean) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId", allowedUsers: [] };
    return runtime.bridge.setUserAllowlisted(userId, allowed);
  }

  setUserWorkspace(botId: string | undefined, userId: string, cwd: string) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId" };
    return runtime.bridge.setUserWorkspace(userId, cwd);
  }

  /** Give an existing user the automatic `<workspaceRoot>/<bot>/<user>` folder. */
  isolateUserWorkspace(botId: string | undefined, userId: string) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId" };
    return runtime.bridge.isolateUserWorkspace(userId);
  }

  newUserSession(botId: string | undefined, userId: string) {
    const runtime = this.soleOrNamed(botId);
    if (!runtime) return { ok: false, message: botId ? `未找到 bot ${botId}` : "存在多个 bot，请指定 botId" };
    return runtime.bridge.newUserSession(userId);
  }

  // ─── Session routing (all events / tool calls) ───

  available(): boolean {
    return this.runtimes.size > 0;
  }

  private ownerFor(sessionId: string): BotRuntime | undefined {
    if (!sessionId) return undefined;
    for (const runtime of this.runtimes.values()) {
      if (runtime.bridge.ownsSessionId(sessionId)) return runtime;
    }
    return undefined;
  }

  handleSessionEvent(sessionId: string, event: { type: string; [k: string]: unknown }): void {
    for (const runtime of this.runtimes.values()) runtime.bridge.handleSessionEvent(sessionId, event);
  }

  handleAssistantStream(sessionId: string, frame: Parameters<WeChatDSHBridge["handleAssistantStream"]>[1]): void {
    for (const runtime of this.runtimes.values()) runtime.bridge.handleAssistantStream(sessionId, frame);
  }

  handleAgentStatus(sessionId: string, status: string): void {
    for (const runtime of this.runtimes.values()) runtime.bridge.handleAgentStatus(sessionId, status);
  }

  handleAgentError(agentId: string, error: unknown): void {
    for (const runtime of this.runtimes.values()) runtime.bridge.handleAgentError(agentId, error);
  }

  clearSessionOutput(sessionId: string): void {
    for (const runtime of this.runtimes.values()) runtime.bridge.clearSessionOutput(sessionId);
  }

  attachCommands(commands: unknown): void {
    this.commands = commands as Parameters<WeChatDSHBridge["attachCommands"]>[0];
    for (const runtime of this.runtimes.values()) runtime.bridge.attachCommands(commands as never);
  }

  applyModelOverride(config: { provider: string; model: string }, agentId: string) {
    const owner = this.ownerFor(agentId);
    if (!owner) return config;
    return owner.bridge.applyModelOverride(config, agentId);
  }

  surfaceSourceFor(sessionId: string): "wechat" | "gui" | undefined {
    const owner = this.ownerFor(sessionId);
    return owner?.bridge.surfaceSourceFor(sessionId);
  }

  surfacePromptFor(sessionId: string): { enabled: boolean; prompt: string } {
    const owner = this.ownerFor(sessionId);
    if (owner) return owner.bridge.surfacePromptFor(sessionId);
    return { enabled: false, prompt: "" };
  }

  private sessionIdOfRequest(req: { agent?: { id?: string; session?: { header?: { id?: string }; id?: string } } }): string {
    const agent = req.agent;
    return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? "";
  }

  async answerApprovalRequest(
    req: Parameters<WeChatDSHBridge["answerApprovalRequest"]>[0],
    next: Parameters<WeChatDSHBridge["answerApprovalRequest"]>[1],
  ) {
    const owner = this.ownerFor(this.sessionIdOfRequest(req as never));
    if (!owner) return next();
    return owner.bridge.answerApprovalRequest(req, next);
  }

  async answerQuestionRequest(
    req: Parameters<WeChatDSHBridge["answerQuestionRequest"]>[0],
    next: Parameters<WeChatDSHBridge["answerQuestionRequest"]>[1],
  ) {
    const owner = this.ownerFor(this.sessionIdOfRequest(req as never));
    if (!owner) return next();
    return owner.bridge.answerQuestionRequest(req, next);
  }

  async handleSendWeChat(agentId: string, args: { text?: string; file_path?: string }) {
    const owner = this.ownerFor(agentId);
    if (owner) return owner.bridge.handleSendWeChat(agentId, args);
    const all = [...this.runtimes.values()];
    if (all.length === 1) return all[0]!.bridge.handleSendWeChat(agentId, args);
    return {
      ok: false,
      message: "this session is not owned by any WeChat bot; send a message to the intended bot first",
    };
  }
}
