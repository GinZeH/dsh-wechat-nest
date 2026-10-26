/**
 * Filesystem naming for the automatic per-bot / per-user workspaces.
 *
 * WeChat ids contain characters that are legal in a chat id but not in a
 * portable path segment (`@`, `:`, spaces, …). Keep a readable prefix for the
 * human browsing the folder, and append a short hash of the EXACT id so two
 * ids that sanitize to the same string (or differ only by case on Windows)
 * cannot share a directory.
 */

import crypto from "node:crypto";
import path from "node:path";

function sanitize(value: string): string {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 40);
}

function shortHash(value: string): string {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}

/** Stable, safe directory name for one bot account. */
export function botWorkspaceName(botId: string): string {
  const base = sanitize(botId) || "bot";
  return `${base}-${shortHash(botId)}`;
}

/** Stable, safe directory name for one WeChat user inside a bot workspace. */
export function userWorkspaceName(userId: string): string {
  const base = sanitize(userId) || "user";
  return `${base}-${shortHash(userId)}`;
}

/** Root for all automatic workspaces; empty config means `<storageDir>/workspaces`. */
export function effectiveWorkspaceRoot(configured: string, storageDir: string): string {
  return configured.trim() ? path.resolve(configured) : path.join(storageDir, "workspaces");
}

export function botWorkspaceDir(root: string, botId: string): string {
  return path.join(root, botWorkspaceName(botId));
}

export function userWorkspaceDir(root: string, botId: string, userId: string): string {
  return path.join(botWorkspaceDir(root, botId), userWorkspaceName(userId));
}
