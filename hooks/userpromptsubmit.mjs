#!/usr/bin/env node
import "./suppress-stderr.mjs";
/**
 * UserPromptSubmit hook for context-mode session continuity.
 *
 * Captures every user prompt so the LLM can continue from the exact
 * point where the user left off after compact or session restart.
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

  const prompt = input.prompt ?? input.message ?? "";
  const trimmed = (prompt || "").trim();

  const isSystemMessage = trimmed.startsWith("<task-notification>")
    || trimmed.startsWith("<system-reminder>")
    || trimmed.startsWith("<context_guidance>")
    || trimmed.startsWith("<tool-result>");

  if (trimmed.length > 0 && !isSystemMessage) {
    const { extractUserEvents } = await loadExtract();
    const { loadElasticConfig, getClient } = await import(pathToFileURL(join(PKG_ROOT, "build", "es-base.js")).href);
    const { SessionStore } = await import(pathToFileURL(join(PKG_ROOT, "build", "session", "es-db.js")).href);

    loadElasticConfig();
    const client = getClient();
    const indexName = getSessionIndexName();
    const store = await SessionStore.create(client, indexName);
    const sessionId = getSessionId(input);

    await store.ensureSession(sessionId, process.env.CLAUDE_PROJECT_DIR || process.cwd());

    await store.insertEvent(sessionId, {
      type: "user_prompt",
      category: "prompt",
      data: prompt,
      priority: 1,
      data_hash: "",
    }, "UserPromptSubmit");

    const userEvents = extractUserEvents(trimmed);
    for (const ev of userEvents) {
      await store.insertEvent(sessionId, ev, "UserPromptSubmit");
    }

    await store.close();
  }
} catch {
  // UserPromptSubmit must never block the session — silent fallback
}
