/**
 * Build identity — one source of truth for version, commit, and dirty state.
 *
 * Consumed by CLI, server, reports, UI, and the release gauntlet so every
 * surface names the same build.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function git(...args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const commit = git("rev-parse", "--short", "HEAD");
const porcelain = git("status", "--porcelain=v1");
const dirty = porcelain == null ? null : porcelain.length > 0;

export const version = PACKAGE.version;
export const commitHash = commit;
export const isDirty = dirty;

export function buildId() {
  const parts = [`v${version}`];
  if (commit) parts.push(commit.slice(0, 7));
  if (dirty) parts.push("dirty");
  return parts.join("-");
}

export function releaseIdentity() {
  return {
    version,
    commitHash: commit ?? "unknown",
    dirty,
    buildId: buildId(),
    nodeVersion: process.version,
  };
}
