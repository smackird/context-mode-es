#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * PostToolUse hook for context-mode session continuity.
 *
 * Captures session events from tool calls (13 categories) and stores
 * them in the per-project SessionStore (ES-backed) for later resume
 * snapshot building.
 */

import { readStdin, getSessionId, getSessionIndexName } from "./session-helpers.mjs";
import { createSessionLoaders } from "./session-loaders.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..");
const { loadExtract } = createSessionLoaders(HOOK_DIR);

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  const { extractEvents } = await loadExtract();
  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName();
  const store = await SessionStore.create(client, indexName);
  const sessionId = getSessionId(input);

  await store.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    await store.insertEvent(sessionId, event, "PostToolUse");
  }

  await store.close();
} catch {
  // PostToolUse must never block the session — silent fallback
}

// PostToolUse hooks don't need hookSpecificOutput
