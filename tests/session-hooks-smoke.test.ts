/**
 * Smoke test — Session hooks with ES-backed SessionStore
 *
 * Verifies that session continuity hooks work with Elasticsearch.
 * Hooks spawn as subprocesses and connect to the live ES instance.
 *
 * Requires:
 * - ES 9.3 running and reachable
 * - secrets/.elastic.env configured (or ELASTIC_ENV_PATH set)
 * - pnpm build run (hooks import from build/)
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

// Resolve the secrets env file path for subprocess hooks
const SECRETS_ENV_PATH = resolve(PROJECT_ROOT, "..", "secrets", ".elastic.env");

// Simulate install: copy plugin with hooks + build
let fakePluginDir: string;
let fakeProjectDir: string;
let fakeHomeDir: string;

beforeAll(() => {
  fakePluginDir = mkdtempSync(join(tmpdir(), "ctx-es-smoke-"));

  // Copy hooks directory
  cpSync(join(PROJECT_ROOT, "hooks"), join(fakePluginDir, "hooks"), { recursive: true });

  // Copy build directory (hooks import from build/es-base.js, build/session/es-db.js)
  if (existsSync(join(PROJECT_ROOT, "build"))) {
    cpSync(join(PROJECT_ROOT, "build"), join(fakePluginDir, "build"), { recursive: true });
  }

  // Symlink node_modules (needed for @elastic/elasticsearch)
  if (existsSync(join(PROJECT_ROOT, "node_modules"))) {
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fakePluginDir, "node_modules"));
  }

  // Copy package.json (needed for module resolution)
  cpSync(join(PROJECT_ROOT, "package.json"), join(fakePluginDir, "package.json"));

  // Fake project dir and HOME
  fakeProjectDir = mkdtempSync(join(tmpdir(), "ctx-project-"));
  fakeHomeDir = mkdtempSync(join(tmpdir(), "ctx-fakehome-"));
});

afterAll(() => {
  try { rmSync(fakePluginDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeProjectDir, { recursive: true, force: true }); } catch {}
  try { rmSync(fakeHomeDir, { recursive: true, force: true }); } catch {}
});

function runHook(hookFile: string, input: Record<string, unknown>, env?: Record<string, string>) {
  const hookPath = join(fakePluginDir, "hooks", hookFile);
  const result = spawnSync("node", [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 30000, // ES HTTP calls need more time than SQLite file writes
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: fakeProjectDir,
      CLAUDE_SESSION_ID: "test-session-es-smoke",
      CONTEXT_MODE_PLATFORM: "claude-code",
      HOME: fakeHomeDir,
      USERPROFILE: fakeHomeDir,
      // Point hooks to the ES secrets file
      ELASTIC_ENV_PATH: SECRETS_ENV_PATH,
      ...env,
    },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

describe("Session hooks with ES-backed SessionStore", () => {
  test("posttooluse.mjs captures events via ES", () => {
    const result = runHook("posttooluse.mjs", {
      session_id: "test-session-es-smoke",
      tool_name: "Read",
      tool_input: { file_path: "/src/main.ts" },
      tool_response: "const x = 1;",
    });

    expect(result.exitCode).toBe(0);
  });

  test("sessionstart.mjs routing block works on startup", () => {
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-es-smoke",
      source: "startup",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);

    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput?.additionalContext).toBeDefined();
  });

  test("sessionstart.mjs compact recovery works via ES", () => {
    // First capture some events
    runHook("posttooluse.mjs", {
      session_id: "test-session-es-smoke",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    });

    // Build a resume snapshot
    runHook("precompact.mjs", {
      session_id: "test-session-es-smoke",
    });

    // Trigger compact — session recovery should inject session_knowledge
    const result = runHook("sessionstart.mjs", {
      session_id: "test-session-es-smoke",
      source: "compact",
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput?.additionalContext ?? "";

    // Compact recovery injects session_knowledge
    expect(ctx).toContain("session_knowledge");
  });

  test("userpromptsubmit.mjs captures prompts via ES", () => {
    const result = runHook("userpromptsubmit.mjs", {
      prompt: "fix the login bug",
      session_id: "test-session-es-smoke",
    });

    expect(result.exitCode).toBe(0);
  });

  test("precompact.mjs creates snapshot via ES", () => {
    const result = runHook("precompact.mjs", {
      session_id: "test-session-es-smoke",
    });

    expect(result.exitCode).toBe(0);
  });
});
