/**
 * Durable per-user bridge state: session mapping, silent mode, and workspace
 * choices. The default preset deliberately lives in the DSH settings
 * document (`agent-presets` namespace), not here — the GUI settings page and
 * WeChat's `/preset switch` share that one source of truth.
 *
 * Mirrors the reference project's UserState (wechat-opencode) but keeps
 * ONLY what the DSH bridge needs. Persisted to `~/.dsh-wechat-nest/state.json`
 * so restarts restore the WeChat user → DSH session mapping.
 */

import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./utils/secure-fs.js";

/**
 * Per-user behaviour preferences. Every field is optional: an absent field
 * falls back to the deployment default in `config.json`, which is the value
 * the settings page edits. Writing one here makes that user's choice
 * independent of every other WeChat user.
 *
 * The model / preset / permission trio is snapshotted when the user is first
 * seen, so a later default change made by someone else (or from the GUI) does
 * not silently follow a different user into their next session.
 */
export interface UserPrefs {
  /** Silent mode: only send the final text of each turn. */
  silent?: boolean;
  /** 结论模式: hold across rounds and deliver one conclusion per task. */
  finalOnly?: boolean;
  /** 打字合并: batch consecutive messages into one turn. */
  mergeEnabled?: boolean;
  /** 图片/文件与文字合并. */
  mediaMergeEnabled?: boolean;
  /** Attachment pointer spelling: `@引用` vs plain path. */
  mediaAtRefEnabled?: boolean;
  /** WeChat channel prompt injection. */
  surfacePromptEnabled?: boolean;
  /** Cross-session decision cards (permission/question). */
  crossSessionNotify?: "inherit" | "on" | "off";
  /** Cross-session task completion/error notices. */
  notifyTaskEvents?: boolean;
  /** Busy-time delivery: queue a follow-up turn or steer the running one. */
  busyEnter?: "queue" | "steer";
  /**
   * Operator-level pause for this account. A disabled account's inbound is
   * ignored and its outbound is suppressed, while its state (sessions,
   * preferences, queue) is kept for a later re-enable.
   */
  disabled?: boolean;
  /** Default model for sessions created by this user. */
  model?: { provider: string; model: string; reasoningEffort?: string };
  /** Default agent preset for sessions created by this user. */
  presetId?: string;
  /** Default permission preset for sessions created by this user. */
  permissionPreset?: string;
}

export interface UserState {
  /** The WeChat user id this state belongs to. */
  userId: string;
  /** Bound DSH session id. */
  sessionId: string;
  /** Working directory the bound session was created with. */
  cwd: string;
  /** Administrator-assigned directory boundary; WeChat commands cannot widen it. */
  workspaceRoot?: string;
  /**
    * Whether the user explicitly switched workspaces (/workspace, /session
    * switch). Explicit choices are NOT overwritten by the settings-page cwd
    * default; users without this flag follow the settings default.
    */
  cwdExplicit?: boolean;
  /** Silent mode (legacy mirror of `prefs.silent`; kept for old state files). */
  silent: boolean;
  /**
   * True once the user personally toggled silent mode. Without it, the
   * settings-page global default keeps applying (the pre-multi-user
   * behaviour); with it, the user's own choice wins.
   */
  silentExplicit?: boolean;
  /** Cross-session notification preference (default inherit -> follows global config). */
  crossSessionNotify?: "inherit" | "on" | "off";
  /** Sessions this user owns / has ever been bound to. */
  watchedSessions?: string[];
  /** Independent behaviour and default choices for this user. */
  prefs?: UserPrefs;
}

/** One WeChat peer's ordered outbound queue and send-window budget. */
export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "file"; filePath: string; fileName: string };

/**
 * Soft cap for the outbound FIFO. Reaching it makes `parkOutbound` try to
 * force-send the oldest item instead of dropping it, so a full queue means
 * "try harder", not "discard".
 */
export const MAX_OUTBOUND_QUEUE = 100;

/**
 * Hard ceiling for the outbound FIFO — the actual memory bound.
 *
 * The soft cap alone cannot bound memory: when the force-send fails (invalid
 * token, gateway rejection, closed message window) nothing leaves the queue,
 * yet the caller still appends. Without a ceiling the queue — and the
 * `state.json` snapshot written from it — grows without limit for as long as
 * the outage lasts. This ceiling is the point where the oldest item is
 * dropped *with a loud log* instead, trading the least-recent message for a
 * bounded process. It sits well above the soft cap so the force-send path has
 * room to work before any loss is contemplated.
 */
export const MAX_OUTBOUND_QUEUE_HARD = MAX_OUTBOUND_QUEUE * 4;

/** Per-user outbound snapshot (v2, the multi-user format). */
export interface UserOutboundState {
  version: 2;
  messageCount: number;
  queue: OutboundMessage[];
}

/** Legacy single-peer snapshot, read once and migrated into `outboundByUser`. */
export interface OutboundState {
  version: 1;
  peerUserId: string;
  messageCount: number;
  queue: OutboundMessage[];
}

export interface BridgeStateFile {
  /**
   * On-disk schema marker. Absent in pre-multi-user files (which are migrated
   * on load and get the allowlist-seeding upgrade path); new files always
   * carry 2, so a fresh multi-user install can keep `allowedUsers: []` open
   * across restarts instead of being retroactively locked down.
   */
  schemaVersion?: number;
  /**
   * The iLink bot account these users belong to. Re-scanning the SAME bot
   * keeps them; logging in as a different bot must not inherit them.
   */
  botAccountId?: string;
  users: Record<string, UserState>;
  /** Per-user send-window/queue state (multi-user format). */
  outboundByUser?: Record<string, UserOutboundState>;
  /** Legacy single-peer snapshot; migrated on load and removed afterwards. */
  outbound?: OutboundState;
}

export const STATE_SCHEMA_VERSION = 2;

function normalizeQueue(raw: unknown): OutboundMessage[] {
  const queue: OutboundMessage[] = [];
  if (!Array.isArray(raw)) return queue;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    if (candidate.kind === "text" && typeof candidate.text === "string") {
      queue.push({ kind: "text", text: candidate.text });
    } else if (
      candidate.kind === "file" &&
      typeof candidate.filePath === "string" && candidate.filePath &&
      typeof candidate.fileName === "string" && candidate.fileName
    ) {
      queue.push({ kind: "file", filePath: candidate.filePath, fileName: candidate.fileName });
    }
  }
  return queue.slice(-MAX_OUTBOUND_QUEUE_HARD);
}

function normalizeUserOutbound(value: unknown): UserOutboundState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { version?: unknown; messageCount?: unknown; queue?: unknown };
  if (raw.version !== 2) return undefined;
  const count = typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount)
    ? Math.max(0, Math.min(10, Math.floor(raw.messageCount)))
    : 0;
  return { version: 2, messageCount: count, queue: normalizeQueue(raw.queue) };
}

function normalizeOutbound(value: unknown): OutboundState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { version?: unknown; peerUserId?: unknown; messageCount?: unknown; queue?: unknown };
  if (raw.version !== 1 || typeof raw.peerUserId !== "string" || !raw.peerUserId) return undefined;

  const count = typeof raw.messageCount === "number" && Number.isFinite(raw.messageCount)
    ? Math.max(0, Math.min(10, Math.floor(raw.messageCount)))
    : 0;

  return {
    version: 1,
    peerUserId: raw.peerUserId,
    messageCount: count,
    // The reload cap MUST match the runtime hard ceiling, not the soft cap:
    // the runtime queue legally holds up to `MAX_OUTBOUND_QUEUE_HARD` (400)
    // entries, so keeping only the last 100 here silently discarded items
    // 101–400 of a full queue on every restart. `persistOutboundState` writes
    // the whole bounded set, so a reload restores exactly what was saved.
    queue: normalizeQueue(raw.queue),
  };
}

/**
 * Drop malformed persisted preference values instead of trusting them: a
 * hand-edited `userPrefs.finalOnly: "no"` is truthy, and a non-string model
 * would be handed to the host as a route.
 */
function normalizePrefs(value: unknown): UserPrefs {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const out: UserPrefs = {};
  for (const key of ["silent", "finalOnly", "mergeEnabled", "mediaMergeEnabled", "mediaAtRefEnabled", "surfacePromptEnabled", "notifyTaskEvents", "disabled"] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  if (raw.crossSessionNotify === "on" || raw.crossSessionNotify === "off" || raw.crossSessionNotify === "inherit") {
    out.crossSessionNotify = raw.crossSessionNotify;
  }
  if (raw.busyEnter === "queue" || raw.busyEnter === "steer") out.busyEnter = raw.busyEnter;
  if (typeof raw.presetId === "string" && raw.presetId) out.presetId = raw.presetId;
  if (typeof raw.permissionPreset === "string" && raw.permissionPreset) out.permissionPreset = raw.permissionPreset;
  const model = raw.model as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | undefined;
  if (model && typeof model.provider === "string" && model.provider && typeof model.model === "string" && model.model) {
    out.model = {
      provider: model.provider,
      model: model.model,
      ...(typeof model.reasoningEffort === "string" && model.reasoningEffort
        ? { reasoningEffort: model.reasoningEffort }
        : {}),
    };
  }
  return out;
}

export class StateStore {
  private readonly filePath: string;
  private state: BridgeStateFile;
  /** True when this process loaded a pre-multi-user state file with users. */
  private loadedLegacy = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "state.json");
    this.state = this.load();
  }

  /**
   * Whether the one-time upgrade seeding should run: only for a state file
   * written by a pre-multi-user version that already has peers. A fresh
   * install (no state file) and every file written by this version answer
   * false, so `allowedUsers: []` genuinely stays "open to all" across
   * restarts.
   */
  needsAllowlistSeed(): boolean {
    return this.loadedLegacy && Object.keys(this.state.users ?? {}).length > 0;
  }

  private load(): BridgeStateFile {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as BridgeStateFile;
        if (parsed && typeof parsed === "object" && parsed.users) {
          if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) this.loadedLegacy = true;
          parsed.schemaVersion = STATE_SCHEMA_VERSION;
          for (const user of Object.values(parsed.users)) {
            if (typeof user.workspaceRoot !== "string" || !user.workspaceRoot.trim()) {
              user.workspaceRoot = user.cwd;
            }
            if (!Array.isArray(user.watchedSessions)) {
              // Seed history with current binding so old users get at least their present session
              user.watchedSessions = user.sessionId ? [user.sessionId] : [];
            }
            if (user.crossSessionNotify !== "on" && user.crossSessionNotify !== "off") {
              user.crossSessionNotify = "inherit";
            }
            user.prefs = normalizePrefs(user.prefs);
          }
          // Migrate the legacy single-peer snapshot into the per-user map.
          const legacy = normalizeOutbound(parsed.outbound);
          if (legacy) {
            parsed.outboundByUser = parsed.outboundByUser ?? {};
            if (!parsed.outboundByUser[legacy.peerUserId]) {
              parsed.outboundByUser[legacy.peerUserId] = {
                version: 2,
                messageCount: legacy.messageCount,
                queue: legacy.queue,
              };
            }
            delete parsed.outbound;
          }
          if (parsed.outboundByUser) {
            const normalized: Record<string, UserOutboundState> = {};
            for (const [userId, value] of Object.entries(parsed.outboundByUser)) {
              const item = normalizeUserOutbound(value);
              if (item && userId) normalized[userId] = item;
            }
            parsed.outboundByUser = normalized;
          }
          return parsed;
        }
      }
    } catch {
      // fall through to fresh state
    }
    return { schemaVersion: STATE_SCHEMA_VERSION, users: {} };
  }

  private save(): void {
    ensurePrivateDir(path.dirname(this.filePath));
    this.state.schemaVersion = STATE_SCHEMA_VERSION;
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      // 0o600 on both the temp file and the renamed target: the state file
      // carries the WeChat↔session mapping and the queued outbound bodies.
      writePrivateFile(tempPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // best effort cleanup
      }
      throw err;
    }
  }

  ensureUser(userId: string, cwd: string, opts?: { silent?: boolean }): UserState {
    let user = this.state.users[userId];
    if (!user) {
      user = {
        userId,
        sessionId: "",
        cwd,
        workspaceRoot: cwd,
        silent: opts?.silent === true,
        crossSessionNotify: "inherit",
        watchedSessions: [],
        prefs: {},
      };
      this.state.users[userId] = user;
      this.save();
    } else {
      // Backfill missing fields for users created before this feature
      let changed = false;
      if (user.crossSessionNotify !== "on" && user.crossSessionNotify !== "off" && user.crossSessionNotify !== "inherit") {
        user.crossSessionNotify = "inherit";
        changed = true;
      }
      if (!Array.isArray(user.watchedSessions)) {
        user.watchedSessions = user.sessionId ? [user.sessionId] : [];
        changed = true;
      }
      if (user.prefs === undefined) {
        user.prefs = {};
        changed = true;
      }
      if (changed) this.save();
    }
    return user;
  }

  getUser(userId: string): UserState | undefined {
    return this.state.users[userId];
  }

  update(userId: string, patch: Partial<UserState>): void {
    const user = this.state.users[userId];
    if (!user) return;
    Object.assign(user, patch);
    this.save();
  }

  /** Record that `userId` has been bound to `sessionId` (for cross-session recipient resolution). */
  watchSession(userId: string, sessionId: string): void {
    if (!sessionId) return;
    const user = this.state.users[userId];
    if (!user) return;
    if (!Array.isArray(user.watchedSessions)) user.watchedSessions = [];
    if (!user.watchedSessions.includes(sessionId)) {
      user.watchedSessions.push(sessionId);
      // Cap history to avoid unbounded growth
      if (user.watchedSessions.length > 100) user.watchedSessions = user.watchedSessions.slice(-100);
      this.save();
    }
  }

  /** Merge one user's preference patch and persist it. */
  updatePrefs(userId: string, patch: Partial<UserPrefs>): UserState | undefined {
    const user = this.state.users[userId];
    if (!user) return undefined;
    user.prefs = normalizePrefs({ ...(user.prefs ?? {}), ...patch });
    this.save();
    return user;
  }

  /** Drop one user's bridge state and durable outbound snapshot. */
  removeUser(userId: string): boolean {
    if (!this.state.users[userId]) return false;
    delete this.state.users[userId];
    if (this.state.outboundByUser) {
      delete this.state.outboundByUser[userId];
      if (Object.keys(this.state.outboundByUser).length === 0) delete this.state.outboundByUser;
    }
    this.save();
    return true;
  }

  /** Defensive copy of one user's outbound snapshot. */
  outboundFor(userId: string): UserOutboundState | undefined {
    const value = this.state.outboundByUser?.[userId];
    if (!value) return undefined;
    return { ...value, queue: value.queue.map((item) => ({ ...item })) };
  }

  /** Every persisted peer's outbound snapshot, defensively copied. */
  allOutbound(): Record<string, UserOutboundState> {
    const out: Record<string, UserOutboundState> = {};
    for (const [userId, value] of Object.entries(this.state.outboundByUser ?? {})) {
      out[userId] = { ...value, queue: value.queue.map((item) => ({ ...item })) };
    }
    return out;
  }

  /** Replace and durably save one user's outbound snapshot. */
  setOutboundFor(userId: string, value: Omit<UserOutboundState, "version">): void {
    const normalized = normalizeUserOutbound({ ...value, version: 2 });
    if (!normalized) throw new Error("invalid outbound state");
    this.state.outboundByUser = this.state.outboundByUser ?? {};
    this.state.outboundByUser[userId] = normalized;
    this.save();
  }

  /** Remove one user's durable outbound budget and queue. */
  clearOutboundFor(userId: string): void {
    if (!this.state.outboundByUser?.[userId]) return;
    delete this.state.outboundByUser[userId];
    if (Object.keys(this.state.outboundByUser).length === 0) delete this.state.outboundByUser;
    this.save();
  }

  /** Remove every peer's durable outbound budget and queue. */
  clearOutbound(): void {
    if (!this.state.outboundByUser && !this.state.outbound) return;
    delete this.state.outboundByUser;
    delete this.state.outbound;
    this.save();
  }

  /**
   * Legacy single-peer accessors. Kept so pre-multi-user callers (and the
   * regression tests that pin the durable-queue format) keep working; the
   * bridge itself uses the per-user methods above.
   */
  outbound(): OutboundState | undefined {
    const entries = Object.entries(this.state.outboundByUser ?? {});
    const first = entries[0];
    if (!first) return undefined;
    const [userId, value] = first;
    return {
      version: 1,
      peerUserId: userId,
      messageCount: value.messageCount,
      queue: value.queue.map((item) => ({ ...item })),
    };
  }

  setOutbound(value: OutboundState): void {
    const normalized = normalizeOutbound(value);
    if (!normalized) throw new Error("invalid outbound state");
    this.state.outboundByUser = this.state.outboundByUser ?? {};
    this.state.outboundByUser[normalized.peerUserId] = {
      version: 2,
      messageCount: normalized.messageCount,
      queue: normalized.queue,
    };
    this.save();
  }

  /** Effective cross-session preference for display. */
  getNotifyPreference(userId: string): "inherit" | "on" | "off" {
    const user = this.state.users[userId];
    if (!user) return "inherit";
    const pref = user.prefs?.crossSessionNotify ?? user.crossSessionNotify;
    if (pref === "on" || pref === "off") return pref;
    return "inherit";
  }

  all(): UserState[] {
    return Object.values(this.state.users);
  }

  /**
   * Drop every persisted WeChat user. Logout / re-login is a different bot
   * session, so no previous peer's binding, queue or preferences may survive.
   */
  /** The bot account the persisted users belong to, if known. */
  botAccountId(): string | undefined {
    return this.state.botAccountId;
  }

  /** Remember which bot account owns the persisted user set. */
  setBotAccountId(accountId: string): void {
    if (!accountId || this.state.botAccountId === accountId) return;
    this.state.botAccountId = accountId;
    this.save();
  }

  clearUsers(): void {
    if (Object.keys(this.state.users).length === 0) return;
    this.state.users = {};
    this.save();
  }
}
