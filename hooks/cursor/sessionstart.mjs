#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Cursor sessionStart hook for context-mode (ES-backed).
 */

import { ROUTING_BLOCK } from "../routing-block.mjs";
import {
  writeSessionEventsFile,
  buildSessionDirective,
  getSessionEventsES,
  getLatestSessionEventsES,
} from "../session-directive.mjs";
import {
  readStdin,
  getSessionId,
  getSessionIndexName,
  getSessionEventsPath,
  getCleanupFlagPath,
  getInputProjectDir,
  deleteOrphanEventsES,
  CURSOR_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..", "..");
const OPTS = CURSOR_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? input.trigger ?? "startup";
  const projectDir = getInputProjectDir(input, CURSOR_OPTS);

  if (projectDir && !process.env.CURSOR_CWD) {
    process.env.CURSOR_CWD = projectDir;
  }

  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName(OPTS);
  const store = await SessionStore.create(client, indexName);

  if (source === "compact" || source === "resume") {
    if (source === "compact") {
      const sessionId = getSessionId(input, OPTS);
      const resume = await store.getResume(sessionId);
      if (resume && !resume.consumed) {
        await store.markResumeConsumed(sessionId);
      }
    } else {
      try { unlinkSync(getCleanupFlagPath(OPTS)); } catch { /* no flag */ }
    }

    const events = source === "compact"
      ? await getSessionEventsES(client, indexName, getSessionId(input, OPTS))
      : await getLatestSessionEventsES(client, indexName);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective(source, eventMeta);
    }

    await store.close();
  } else if (source === "startup") {
    try { unlinkSync(getSessionEventsPath(OPTS)); } catch { /* no stale file */ }

    const cleanupFlag = getCleanupFlagPath(OPTS);
    let previousWasFresh = false;
    try { readFileSync(cleanupFlag); previousWasFresh = true; } catch { /* no flag */ }

    if (previousWasFresh) {
      await store.cleanupOldSessions(0);
    } else {
      await store.cleanupOldSessions(7);
    }
    await deleteOrphanEventsES(client, indexName);
    writeFileSync(cleanupFlag, new Date().toISOString(), "utf-8");

    const sessionId = getSessionId(input, OPTS);
    await store.ensureSession(sessionId, projectDir);

    await store.close();
  }
  // clear => routing block only
} catch {
  // Cursor treats stderr as hook failure; swallow and continue.
}

process.stdout.write(JSON.stringify({ additional_context: additionalContext }) + "\n");
