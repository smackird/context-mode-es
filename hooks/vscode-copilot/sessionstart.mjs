#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * VS Code Copilot SessionStart hook for context-mode (ES-backed).
 */

import { ROUTING_BLOCK } from "../routing-block.mjs";
import { writeSessionEventsFile, buildSessionDirective, getSessionEventsES, getLatestSessionEventsES } from "../session-directive.mjs";
import {
  readStdin, getSessionId, getSessionIndexName, getSessionEventsPath, getCleanupFlagPath,
  getProjectDir, deleteOrphanEventsES, VSCODE_OPTS,
} from "../session-helpers.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..", "..");
const OPTS = VSCODE_OPTS;

let additionalContext = ROUTING_BLOCK;

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);
  const source = input.source ?? "startup";

  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName(OPTS);
  const store = await SessionStore.create(client, indexName);

  if (source === "compact") {
    const sessionId = getSessionId(input, OPTS);
    const resume = await store.getResume(sessionId);

    if (resume && !resume.consumed) {
      await store.markResumeConsumed(sessionId);
    }

    const events = await getSessionEventsES(client, indexName, sessionId);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective("compact", eventMeta);
    }

    await store.close();
  } else if (source === "resume") {
    try { unlinkSync(getCleanupFlagPath(OPTS)); } catch { /* no flag */ }

    const events = await getLatestSessionEventsES(client, indexName);
    if (events.length > 0) {
      const eventMeta = writeSessionEventsFile(events, getSessionEventsPath(OPTS));
      additionalContext += buildSessionDirective("resume", eventMeta);
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
    const projectDir = getProjectDir(OPTS);
    await store.ensureSession(sessionId, projectDir);

    try {
      const { VSCodeCopilotAdapter } = await import(pathToFileURL(join(PKG_ROOT, "build", "adapters", "vscode-copilot", "index.js")).href);
      new VSCodeCopilotAdapter().writeRoutingInstructions(projectDir, PKG_ROOT);
    } catch { /* best effort */ }

    const ruleFilePaths = [
      join(projectDir, ".github", "copilot-instructions.md"),
    ];
    for (const p of ruleFilePaths) {
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
} catch (err) {
  try {
    const { appendFileSync } = await import("node:fs");
    const { join: pjoin } = await import("node:path");
    const { homedir: hd } = await import("node:os");
    appendFileSync(
      pjoin(hd(), ".vscode", "context-mode", "sessionstart-debug.log"),
      `[${new Date().toISOString()}] ${err?.message || err}\n${err?.stack || ""}\n`,
    );
  } catch { /* ignore logging failure */ }
}

const output = `SessionStart:compact hook success: Success\nSessionStart hook additional context: \n${additionalContext}`;
process.stdout.write(output);
