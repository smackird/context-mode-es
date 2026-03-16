#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * SessionStart hook for context-mode
 *
 * Provides the agent with XML-structured "Rules of Engagement"
 * at the beginning of each session. Injects session knowledge on
 * both startup and compact to maintain continuity.
 */

import { ROUTING_BLOCK } from "./routing-block.mjs";
import { readStdin, getSessionId, getSessionIndexName, getSessionEventsPath, getCleanupFlagPath, deleteOrphanEventsES } from "./session-helpers.mjs";
import { writeSessionEventsFile, buildSessionDirective, getSessionEventsES, getLatestSessionEventsES } from "./session-directive.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..");

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName();
  const store = await SessionStore.create(client, indexName);

  if (source === "compact") {
    const sessionId = getSessionId(input);
    const resume = await store.getResume(sessionId);

    if (resume && !resume.consumed) {
      await store.markResumeConsumed(sessionId);
    }

    const events = await getSessionEventsES(client, indexName, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
      additionalContext += buildSessionDirective("compact", eventMeta);
    }

    await store.close();
  } else if (source === "resume") {
    try { unlinkSync(getCleanupFlagPath()); } catch { /* no flag */ }

    const events = await getLatestSessionEventsES(client, indexName);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath());
      additionalContext += buildSessionDirective("resume", eventMeta);
    }

    await store.close();
  } else if (source === "startup") {
    try { unlinkSync(getSessionEventsPath()); } catch { /* no stale file */ }

    const cleanupFlag = getCleanupFlagPath();
    let previousWasFresh = false;
    try { readFileSync(cleanupFlag); previousWasFresh = true; } catch { /* no flag */ }

    if (previousWasFresh) {
      await store.cleanupOldSessions(0);
    } else {
      await store.cleanupOldSessions(7);
    }
    await deleteOrphanEventsES(client, indexName);

    writeFileSync(cleanupFlag, new Date().toISOString(), "utf-8");

    const sessionId = getSessionId(input);
    const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    await store.ensureSession(sessionId, projectDir);

    const claudeMdPaths = [
      join(homedir(), ".claude", "CLAUDE.md"),
      join(projectDir, "CLAUDE.md"),
      join(projectDir, ".claude", "CLAUDE.md"),
    ];
    for (const p of claudeMdPaths) {
      try {
        const content = readFileSync(p, "utf-8");
        if (content.trim()) {
          await store.insertEvent(sessionId, { type: "rule", category: "rule", data: p, priority: 1, data_hash: "" });
          await store.insertEvent(sessionId, { type: "rule_content", category: "rule", data: content, priority: 1, data_hash: "" });
        }
      } catch { /* file doesn't exist — skip */ }
    }

    await store.close();
  }
  // "clear" — no action needed
} catch (err) {
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir } = await import("node:os");
    appendFileSync(
      pjoin(homedir(), ".claude", "context-mode", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
}));
