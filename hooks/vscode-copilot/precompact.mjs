#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * VS Code Copilot PreCompact hook — snapshot generation (ES-backed).
 */

import { createSessionLoaders } from "../session-loaders.mjs";
import { readStdin, getSessionId, getSessionIndexName, VSCODE_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..", "..");
const { loadSnapshot } = createSessionLoaders(HOOK_DIR);
const OPTS = VSCODE_OPTS;
const DEBUG_LOG = join(homedir(), ".vscode", "context-mode", "precompact-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { buildResumeSnapshot } = await loadSnapshot();
  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName(OPTS);
  const store = await SessionStore.create(client, indexName);
  const sessionId = getSessionId(input, OPTS);

  const events = await store.getEvents(sessionId);

  if (events.length > 0) {
    const stats = await store.getSessionStats(sessionId);
    const snapshot = buildResumeSnapshot(events, {
      compactCount: (stats?.compact_count ?? 0) + 1,
    });

    await store.upsertResume(sessionId, snapshot, events.length);
    await store.incrementCompactCount(sessionId);
  }

  await store.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// PreCompact — no stdout output needed
