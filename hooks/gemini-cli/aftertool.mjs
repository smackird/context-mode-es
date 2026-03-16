#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Gemini CLI AfterTool hook — session event capture (ES-backed).
 */

import { readStdin, getSessionId, getSessionIndexName, getProjectDir, GEMINI_OPTS } from "../session-helpers.mjs";
import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HOOK_DIR, "..", "..");
const PKG_SESSION = join(PKG_ROOT, "build", "session");
const OPTS = GEMINI_OPTS;
const DEBUG_LOG = join(homedir(), ".gemini", "context-mode", "aftertool-debug.log");

try {
  const raw = await readStdin();
  const input = JSON.parse(raw);

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] CALL: ${input.tool_name}\n`);

  const { extractEvents } = await import(pathToFileURL(join(PKG_SESSION, "extract.js")).href);
  const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
  const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

  loadElasticConfig();
  const client = getClient();
  const indexName = getSessionIndexName(OPTS);
  const store = await SessionStore.create(client, indexName);
  const sessionId = getSessionId(input, OPTS);

  await store.ensureSession(sessionId, getProjectDir(OPTS));

  const events = extractEvents({
    tool_name: input.tool_name,
    tool_input: input.tool_input ?? {},
    tool_response: typeof input.tool_response === "string"
      ? input.tool_response
      : JSON.stringify(input.tool_response ?? ""),
    tool_output: input.tool_output,
  });

  for (const event of events) {
    await store.insertEvent(sessionId, event, "AfterTool");
  }

  appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] OK: ${input.tool_name} → ${events.length} events\n`);
  await store.close();
} catch (err) {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ERR: ${err?.message || err}\n`);
  } catch { /* silent */ }
}

// AfterTool is non-blocking — no stdout output
