/**
 * dsh-wechat-nest — Bridge WeChat (iLink bot) to DeepSeek Harness (DSH).
 *
 * Cordis host plugin entry. Loaded through the package's cordis.patch.yml
 * bundle layer (`- insert: - id: dsh-wechat-nest name: 'dsh-wechat-nest'`).
 *
 * Zero runtime dependencies on `@deepseek-ai/*` packages: every DSH
 * service is read through `ctx.get(...)` and all message/value types are
 * constructed by local vendors or structural shapes.
 */

import { WeChatBotManager } from "./bridge/manager.js";
import { formatHelp } from "./bridge/slash.js";
import { helpCatalog } from "./help-catalog.js";
import type { EditableConfig } from "./config-store.js";
import { defaultConfig, type WeChatDSHConfig } from "./config.js";
import { qrSvgFor } from "./qr.js";
import { sessionIdFrom, sessionIdFromAssembleContext, weChatSurfaceText } from "./surface-prompt.js";
export { sessionIdFrom };

export const name = "dsh-wechat-nest";
export const inject: string[] = [];

/** Plugin config accepted from the composition row's `config:` block. */
export interface PluginConfig {
  baseUrl?: string;
  cdnBaseUrl?: string;
  botType?: string;
  storageDir?: string;
  cwd?: string;
  textChunkLimit?: number;
  cardTimeoutMs?: number;
  silent?: boolean;
  finalOnly?: boolean;
  finalOnlyIdleMs?: number;
  finalOnlyCeilingMs?: number;
  surfacePromptEnabled?: boolean;
  surfacePrompt?: string;
  allowRemotePermissionEscalation?: boolean;
  allowAnyFilePath?: boolean;
  maxOutgoingFileBytes?: number;
  mergeEnabled?: boolean;
  mergeSilenceMs?: number;
  mergeMaxMsgs?: number;
  mergeSuffixTokens?: boolean;
  mergeForcedReleaseMs?: number;
  mediaMergeEnabled?: boolean;
  mediaHoldMs?: number;
  mediaAtRefEnabled?: boolean;
}

export function apply(ctx: unknown, rawConfig: PluginConfig = {}): () => Promise<void> {
  const baseConfig: WeChatDSHConfig = {
    ...defaultConfig(),
    ...pickDefined(rawConfig),
  };
  const context = ctx as {
    get<T = unknown>(name: string): T | undefined;
    on(
      event: string,
      listener: (...args: unknown[]) => unknown,
      options?: boolean | { prepend?: boolean; global?: boolean },
    ): () => void;
    inject?: (deps: string[], callback: (ctx: unknown) => unknown) => unknown;
    /**
     * Cordis lifecycle effect. A disposer returned from the body is run in
     * reverse order when the owning fiber unloads. Optional in the declared
     * shape so a host that predates it degrades to the `ctx.inject` fiber
     * disposer instead of failing to apply.
     */
    effect?: (body: () => unknown) => unknown;
  };

  const manager = new WeChatBotManager(context, baseConfig);

  // ─── Session event feed: assistant output → WeChat ───
  context.on("session/event", (session, event) => {
    const sessionId = sessionIdFrom(session);
    if (!sessionId) {
      console.warn("[dsh-wechat-nest] session/event dropped: no session id on payload");
      return;
    }
    manager.handleSessionEvent(sessionId, event as { type: string; [k: string]: unknown });
  });
  console.log("[dsh-wechat-nest] session/event listener attached");
  context.on("agent/assistant-stream", (payload) => {
    const { agent, frame } = payload as { agent?: { id?: string }; frame?: import("./dsh/types.js").AssistantStreamFrame };
    if (agent?.id && frame) manager.handleAssistantStream(agent.id, frame);
  });
  context.on("session/disposed", (session) => {
    const sessionId = sessionIdFrom(session);
    if (sessionId) manager.clearSessionOutput(sessionId);
  });

  // ─── Agent idleness → 结论模式 (final-only) quiescence ───
  // The goal round-driver wakes the NEXT round exactly when `agent.status`
  // flips to `idle`, so this is also the signal that tells the hold "more
  // rounds are coming" (running cancels the countdown) versus "the task is
  // genuinely finished" (idle arms it). `agent.id` IS the session id in DSH
  // (`Agent.id: SessionId`), so no session lookup is needed.
  context.on("agent/status", (payload) => {
    const data = payload as { agent?: { id?: string }; status?: string };
    const sessionId = data?.agent?.id;
    const status = data?.status;
    if (!sessionId || !status) return;
    manager.handleAgentStatus(sessionId, status);
  });

  // ─── Agent errors → WeChat notification ───
  context.on("agent/error", (payload) => {
    const agentId = (payload as { agent?: { id?: string } })?.agent?.id;
    if (!agentId) return;
    manager.handleAgentError(agentId, (payload as { error?: unknown })?.error);
  });

  // ─── Model overrides: /model switch applies to the live agent's next
  // request by rewriting the frozen call config (same cooperative pattern
  // as dsh-agent's installModelSelection: await next(), then replace). ───
  context.on("agent/request", async (payload, next) => {
    const agentId = (payload as { agent?: { id?: string } })?.agent?.id;
    const nextFn = next as () => Promise<unknown>;
    const config = await nextFn();
    if (!agentId) return config;
    return manager.applyModelOverride(config as { provider: string; model: string }, agentId);
  });

  // ─── wechat_nest_send tool: agent-initiated push to the bound user ───
  // (Approval/question cards are fully native — the Host waterfalls below
  // race WeChat against the GUI so whoever answers first wins.)
  //
  // The registration ALWAYS goes through `ctx.effect` / the `ctx.inject`
  // fiber so its disposer is parked on the plugin's fiber: `register()`
  // returns the exact disposer that unregisters the tool, and discarding
  // it leaves `wechat_nest_send` bound to a stale bridge after the plugin is
  // reloaded or removed. Both paths dispose identically — `effect` gives
  // the disposer an explicit, labelled owner and is the host's own idiom
  // (see `packages/host/open-in-app`).
  if (typeof context.inject === "function") {
    context.inject(["tools"], (toolsCtx) => {
      const toolsService = (toolsCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        register(definition: unknown): (() => void) | undefined;
      }>("tools");
      if (!toolsService) return;

      const registerSendWechatTool = () => {
        const dispose = toolsService.register({
          name: "wechat_nest_send",
          description:
            "Send a text message or a local file to the WeChat user who owns the calling session. " +
            "Each WeChat user has an independent session binding and outbound queue, so a push never " +
            "crosses to another user. A session with no WeChat owner cannot push. " +
            "Use this to proactively push results, confirmations, or files to WeChat. " +
            "A file must live inside the calling session's working directory within the owner's " +
            "assigned directory boundary, and must be under the configured size limit.",
          parameters: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "The text message to send to WeChat.",
              },
              file_path: {
                type: "string",
                description:
                  "Path of a local file to send to WeChat. Must resolve inside the calling "
                  + "session's working directory within the owner's assigned boundary (unless the operator "
                  + "enabled allowAnyFilePath), and must fit maxOutgoingFileBytes.",
              },
            },
          },
          output: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                ok: { type: "boolean" },
                message: { type: "string" },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
          },
          async execute(args: { text?: string; file_path?: string }, exec: { agent?: { id?: string } }) {
            return manager.handleSendWeChat(exec.agent?.id ?? "", args);
          },
        });
        return () => {
          if (typeof dispose === "function") dispose();
        };
      };

      if (typeof context.effect === "function") {
        context.effect(registerSendWechatTool);
      } else {
        // Legacy host without `ctx.effect`: `register()` still binds the
        // tool to the calling (injected) scope, and `ctx.inject` returns
        // the child fiber that owns it, so unload already unregisters it.
        registerSendWechatTool();
      }
    });
  } else {
    console.warn("[dsh-wechat-nest] ctx.inject unavailable; wechat_nest_send tool disabled");
  }

  // ─── Approval / question cards: Host waterfalls (GUI-equivalent mirror) ───
  // Untagged listeners are admitted globally by scopeTarget, so a host-level
  // answerer sees every session. prepend:true so we wrap next() (the GUI
  // terminal answerer) instead of running after it. No WeChat peer →
  // immediately next() so the GUI remains the sole answerer. Errors fall
  // through to next() rather than collapsing the GUI card.
  context.on("approval/request", async (req, next) => {
    const nextFn = next as () => Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
    try {
      return await manager.answerApprovalRequest(req as never, nextFn);
    } catch (err) {
      console.error(`[dsh-wechat-nest] approval/request answerer failed: ${String(err)}`);
      return nextFn();
    }
  }, { prepend: true });
  context.on("user-questions/request", async (req, next) => {
    const nextFn = next as () => Promise<unknown>;
    try {
      return await manager.answerQuestionRequest(req as never, nextFn as never);
    } catch (err) {
      // WeChat /rq cancels by rejecting the waiter; rethrow so the Host
      // settles the ask. ASK_CANCELLED = user closed the card (Web X);
      // ASK_ABORTED = turn/signal abort. Other failures fall through to GUI.
      const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
      if (code === "ASK_CANCELLED" || code === "ASK_ABORTED") {
        throw err;
      }
      console.error(`[dsh-wechat-nest] user-questions/request answerer failed: ${String(err)}`);
      return nextFn();
    }
  }, { prepend: true });
  console.log("[dsh-wechat-nest] approval/question waterfall answerers attached");

  // ─── DSH native command registry (ctx.commands) ───
// When the host composes `@deepseek-ai/dsh-commands`, late-bind the
// command surface so WeChat can dispatch `/plan`, `/goal`, `/compact`
// and any other plugin-registered slash command through the same
// native handler the GUI uses. If the registry is not composed
// (minimal headless profiles, host version drift, etc.) we fall through
// to the local whitelist exactly like before — no behavioral change.
if (typeof context.inject === "function") {
  context.inject(["commands"], (cmdCtx) => {
    const commands = (cmdCtx as {
      get<T = unknown>(name: string): T | undefined;
    }).get<{
      find: unknown;
      execute: unknown;
    }>("commands");
    if (!commands) {
      console.warn("[dsh-wechat-nest] ctx.commands unavailable; 原生命令层禁用，回落到本地白名单");
      return;
    }
    // Cast through the bridge's structural surface — we never reference
    // the actual `@deepseek-ai/dsh-commands` types here, so zero runtime
    // dep is added.
    manager.attachCommands(commands as never);
    console.log("[dsh-wechat-nest] 原生命令层已挂载 (/plan、/goal 等通过 ctx.commands 分发)");
  });
} else {
  console.warn("[dsh-wechat-nest] ctx.inject unavailable; 原生命令层禁用，回落到本地白名单");
}

// ─── Dynamic WeChat surface prompt (per-message-source) ───
  // Registered as a GLOBAL RUNTIME CONTEXT (not a prompt section): DSH's
  // system-prompt assembly applies a "complete-section replacement" pass to
  // sections (a preset's complete section replaces ALL ordinary sections,
  // which would drop a section-registered surface prompt — exactly the
  // failure observed), while CONTEXTS are assembled on an independent path
  // ("Current runtime context" snapshot) that complete replacement never
  // touches. The context text is evaluated per assembly: the bridge tracks
  // the most recent user-message source per session, and the context returns
  // the WeChat prompt ONLY while the session's last user message came from
  // WeChat; otherwise it returns "" (empty contexts are filtered out, so
  // GUI-driven assemblies are untouched). Global registration means EVERY
  // agent — old or new, GUI- or WeChat-created, live or resumed — gets the
  // same dynamic context, so the WeChat prompt follows the message source
  // rather than the session's setup path.
  if (typeof context.inject === "function") {
    context.inject(["systemPrompt"], (promptCtx) => {
      const systemPrompt = (promptCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        context(entry: {
          name: string;
          order: number;
          text: string | ((context: unknown) => string);
        }): unknown;
      }>("systemPrompt");
      if (!systemPrompt) {
        console.warn("[dsh-wechat-nest] systemPrompt unavailable; WeChat surface prompt disabled");
        return;
      }
      systemPrompt.context({
        name: "dsh-wechat-nest-surface",
        order: 50,
        text: (context) => {
          const sessionId = sessionIdFromAssembleContext(context);
          const source = sessionId ? manager.surfaceSourceFor(sessionId) : undefined;
          const surface = sessionId
            ? manager.surfacePromptFor(sessionId)
            : { enabled: false, prompt: "" };
          return weChatSurfaceText({
            enabled: surface.enabled,
            prompt: surface.prompt,
            source,
          });
        },
      });
    });
  }

  // ─── QR page + settings-page API ───
  // The webserver row activates only after `webStartup` resolves (it waits on
  // inject), so `ctx.get('webServer')` at apply time is undefined. Use the
  // conditional-inject pattern to register the routes once the service is
  // available; the bridge itself works without them (QR URL is logged).
  if (typeof context.inject === "function") {
    context.inject(["webServer"], (httpCtx) => {
      const webServer = (httpCtx as {
        get<T = unknown>(name: string): T | undefined;
      }).get<{
        register(route: {
          kind: "exact" | "prefix";
          path: string;
          handler: (req: unknown, res: unknown) => void;
        }): unknown;
      }>("webServer");
      if (!webServer) return;

      // QR login page (standalone viewer; the settings page is the primary UI).
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/qr",
        handler: (_req, res) => {
          const response = res as HttpResponse;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(QR_PAGE);
        },
      });
      // QR image: the iLink qrcode_img_content URL is an HTML page, not an
      // image — the URL string is encoded into a QR server-side instead.
      // `?botId=` selects one bot; omitted means the first waiting bot.
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/qr-image",
        handler: (req, res) => {
          const qrUrl = manager.getQrUrl(queryParam(req, "botId"));
          const response = res as HttpResponse;
          if (!qrUrl) {
            response.statusCode = 404;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            response.end("no QR available");
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(qrSvgFor(qrUrl));
        },
      });
      // QR page poll endpoint (phase/qrUrl/botId/error).
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/status",
        handler: (_req, res) => {
          sendJson(res, 200, manager.getStatus());
        },
      });

      // Settings-page API.
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/status",
        handler: (_req, res) => {
          sendJson(res, 200, manager.getStatus());
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/help",
        handler: (_req, res) => {
          // `text` stays the verbatim `/help` reply (the WeChat side and any
          // older client keep working); `catalog` is the settings page's
          // plain-language view of the same command set. Both come from this
          // install, so they cannot disagree about which commands exist —
          // `tests/help-catalog.test.ts` pins the two sets together.
          sendJson(res, 200, { ok: true, text: formatHelp(), catalog: helpCatalog() });
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/config",
        handler: async (req, res) => {
          try {
            const body = (await readJsonBody(req)) as Record<string, unknown>;
            const botId = typeof body.botId === "string" ? body.botId : undefined;
            const result = await manager.updateConfig(botId, body as Partial<EditableConfig>);
            sendJson(res, 200, { ok: true, ...result });
          } catch (err) {
            sendJson(res, 400, { ok: false, message: String(err) });
          }
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/relogin",
        handler: async (req, res) => {
          const body = (await readJsonBody(req).catch(() => ({}))) as { botId?: string };
          const botId = body.botId ?? queryParam(req, "botId") ?? "";
          const result = botId
            ? await manager.relogin(botId)
            : { ok: false, message: "缺少 botId" };
          sendJson(res, 200, { ok: result.ok, message: result.message });
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/logout",
        handler: async (req, res) => {
          const body = (await readJsonBody(req).catch(() => ({}))) as { botId?: string };
          const botId = body.botId ?? queryParam(req, "botId") ?? "";
          const result = botId
            ? await manager.logout(botId)
            : { ok: false, message: "缺少 botId" };
          sendJson(res, 200, { ok: result.ok, message: result.message });
        },
      });
      // Bot account management: add / remove / relogin / logout / rename.
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/bots",
        handler: async (req, res) => {
          try {
            const body = (await readJsonBody(req)) as { action?: string; botId?: string; label?: string };
            const action = body.action ?? "";
            if (action === "add") {
              const bot = await manager.addBot(body.label);
              sendJson(res, 200, { ok: true, message: "已添加 bot，请扫码登录", bot });
              return;
            }
            const botId = typeof body.botId === "string" ? body.botId : "";
            if (!botId) {
              sendJson(res, 400, { ok: false, message: "缺少 botId" });
              return;
            }
            if (action === "remove") {
              const result = await manager.removeBot(botId);
              sendJson(res, result.ok ? 200 : 400, result);
              return;
            }
            if (action === "relogin") {
              const result = await manager.relogin(botId);
              sendJson(res, 200, result);
              return;
            }
            if (action === "logout") {
              const result = await manager.logout(botId);
              sendJson(res, 200, result);
              return;
            }
            sendJson(res, 400, { ok: false, message: "未知 action" });
          } catch (err) {
            sendJson(res, 400, { ok: false, message: String(err) });
          }
        },
      });
      // Per-user management for the WebUI. A single body shape serves the
      // prefix route (legacy callers) and the exact route (the settings page):
      // `{ botId, userId, action?: "update" | "remove" | "allow" | "disallow" | "workspace" | "new-session", ... }`.
      const handleUserApi = async (req: unknown, res: unknown, forcedUserId?: string) => {
        try {
          const raw = (await readJsonBody(req)) as Record<string, unknown>;
          const botId = typeof raw.botId === "string" ? raw.botId : undefined;
          const userId = (forcedUserId ?? (typeof raw.userId === "string" ? raw.userId : "")).trim();
          if (!userId) {
            sendJson(res, 400, { ok: false, message: "缺少 userId" });
            return;
          }
          const action = typeof raw.action === "string" ? raw.action : "update";
          if (action === "remove") {
            const result = manager.removeUser(botId, userId);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          if (action === "allow" || action === "disallow") {
            const result = manager.setUserAllowlisted(botId, userId, action === "allow");
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          if (action === "workspace") {
            const result = manager.setUserWorkspace(botId, userId, typeof raw.cwd === "string" ? raw.cwd : "");
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          if (action === "isolate-workspace") {
            const result = manager.isolateUserWorkspace(botId, userId);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          if (action === "new-session") {
            const result = manager.newUserSession(botId, userId);
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          const result = manager.updateUserConfig(botId, userId, normalizeUserPatch(raw));
          sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
          sendJson(res, 400, { ok: false, message: String(err) });
        }
      };
      webServer.register({
        kind: "prefix",
        path: "/wechat-nest/api/user/",
        handler: async (req, res) => {
          const httpReq = req as { url?: string; method?: string; path?: string };
          const rawUrl = (httpReq.url ?? httpReq.path ?? "") as string;
          const prefix = "/wechat-nest/api/user/";
          const after = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : rawUrl.split("/").pop() ?? "";
          const userId = decodeURIComponent(after.split("?")[0]!.split("#")[0]!.trim());
          await handleUserApi(req, res, userId);
        },
      });
      webServer.register({
        kind: "exact",
        path: "/wechat-nest/api/user",
        handler: async (req, res) => {
          await handleUserApi(req, res);
        },
      });
      console.log("[dsh-wechat-nest] Settings UI available: 设置 → 微巢；扫码页 http://127.0.0.1:3080/wechat-nest/qr");
    });
  } else {
    console.log("[dsh-wechat-nest] ctx.inject unavailable; QR page disabled (login QR is logged)");
  }

  // Start every configured bot (token resume or QR login), stop all on dispose.
  manager.start();
  return () => manager.stop();
}

function pickDefined(raw: PluginConfig): Partial<WeChatDSHConfig> {
  const out: Partial<WeChatDSHConfig> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** Narrow one user-management request body to the fields the bridge owns. */
function normalizeUserPatch(raw: Record<string, unknown>): {
  silent?: boolean;
  finalOnly?: boolean;
  crossSessionNotify?: "inherit" | "on" | "off";
  notifyTaskEvents?: boolean;
  mergeEnabled?: boolean;
  mediaMergeEnabled?: boolean;
  mediaAtRefEnabled?: boolean;
  surfacePromptEnabled?: boolean;
  disabled?: boolean;
  busyEnter?: "queue" | "steer";
} {
  const out: ReturnType<typeof normalizeUserPatch> = {};
  for (const key of [
    "silent",
    "finalOnly",
    "notifyTaskEvents",
    "mergeEnabled",
    "mediaMergeEnabled",
    "mediaAtRefEnabled",
    "surfacePromptEnabled",
    "disabled",
  ] as const) {
    if (typeof raw[key] === "boolean") out[key] = raw[key] as boolean;
  }
  if (raw.crossSessionNotify === "on" || raw.crossSessionNotify === "off" || raw.crossSessionNotify === "inherit") {
    out.crossSessionNotify = raw.crossSessionNotify;
  }
  if (raw.busyEnter === "queue" || raw.busyEnter === "steer") out.busyEnter = raw.busyEnter;
  return out;
}

// ─── HTTP helpers for the webServer routes ───

interface HttpResponse {
  statusCode?: number;
  setHeader(name: string, value: string): void;
  end(chunk: string): void;
}

function sendJson(res: unknown, status: number, body: unknown): void {
  const response = res as HttpResponse;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function readJsonBody(req: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = req as NodeJS.ReadableStream & {
      on(event: string, listener: (...args: unknown[]) => void): unknown;
    };
    stream.on("data", (chunk: unknown) => {
      if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    });
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${String(err)}`));
      }
    });
    stream.on("error", reject);
  });
}

/** Read one query-string value from a raw Node request. */
function queryParam(req: unknown, name: string): string | undefined {
  const raw = (req as { url?: string; path?: string } | undefined)?.url
    ?? (req as { path?: string } | undefined)?.path
    ?? "";
  try {
    const value = new URL(raw, "http://127.0.0.1").searchParams.get(name);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Standalone QR login page (no client build needed). */
const QR_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>微巢 · DSH WeChat Nest</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; padding: 2rem; }
  .card { background: #fff; border-radius: 12px; padding: 2rem; max-width: 420px; width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 1.2rem; margin: 0 0 .5rem; }
  .state { color: #666; margin: 1rem 0; min-height: 1.5em; }
  img.qr { width: 260px; height: 260px; border: 1px solid #eee; border-radius: 8px; }
  .error { color: #c0392b; white-space: pre-wrap; }
  .ok { color: #27ae60; font-weight: 600; }
</style>
</head>
<body>
<div class="card">
  <h1>📱 微巢 — 扫码登录</h1>
  <div id="state" class="state">正在获取二维码…</div>
  <img id="qr" class="qr" alt="QR" style="display:none" />
  <div id="err" class="error"></div>
  <p style="color:#999;font-size:.8rem">用微信扫描二维码，确认登录后本页自动刷新。二维码 5 分钟有效，过期自动刷新。</p>
</div>
<script>
  async function poll() {
    try {
      const res = await fetch('/wechat-nest/status');
      const data = await res.json();
      const state = document.getElementById('state');
      const qr = document.getElementById('qr');
      const err = document.getElementById('err');
      err.textContent = '';
      if (data.phase === 'logged-in') {
        state.className = 'state ok';
        state.textContent = '✅ 已登录 (Bot: ' + (data.botId || '') + ')';
        qr.style.display = 'none';
        return;
      }
      if (data.phase === 'failed') {
        state.textContent = '❌ 登录失败';
        err.textContent = data.error || '';
        return;
      }
      if (data.phase === 'scaned') {
        state.textContent = '已扫码，请在微信中确认…';
      } else {
        state.textContent = data.qrUrl ? '请用微信扫描下方二维码' : '正在获取二维码…';
      }
      if (data.qrUrl) {
        qr.src = '/wechat-nest/api/qr-image?v=' + encodeURIComponent(data.qrUrl);
        qr.style.display = 'block';
      }
    } catch (e) {
      document.getElementById('state').textContent = '无法连接 DSH（' + e + '）';
    }
    setTimeout(poll, 2000);
  }
  poll();
</script>
</body>
</html>`;
