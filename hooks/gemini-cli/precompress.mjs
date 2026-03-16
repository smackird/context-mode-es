#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Gemini CLI PreCompress hook — snapshot generation (ES-backed).
 */

import { readStdin, getSessionId, getSessionIndexName, GEMINI_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..", "..");
const PKG_SESSION = join(PKG_ROOT, "build", "session");
const OPTS = GEMINI_OPTS;
const DEBUG_LOG = join(homedir(), ".gemini", "context-mode", "precompress-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { buildResumeSnapshot } = await import(pathToFileURL(join(PKG_SESSION, "snapshot.js")).href);
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

// PreCompress is advisory — no stdout output needed
