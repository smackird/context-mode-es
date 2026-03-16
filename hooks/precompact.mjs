#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * PreCompact hook for context-mode session continuity.
 *
 * Triggered when Claude Code is about to compact the conversation.
 * Reads all captured session events, builds a priority-sorted resume
 * snapshot (<2KB XML), and stores it for injection after compact.
 */

import { readStdin, getSessionId, getSessionIndexName } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..");
const { loadSnapshot } = createSessionLoaders(HOOK_DIR);
const DEBUG_LOG = join(homedir(), ".claude", "context-mode", "precompact-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { buildResumeSnapshot } = await loadSnapshot();
  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName();
  const store = await SessionStore.create(client, indexName);
  const sessionId = getSessionId(input);

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
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${err.message}\n`);
  } catch {
    // Silent fallback
  }
}

// PreCompact doesn't need hookSpecificOutput
console.log(JSON.stringify({}));
