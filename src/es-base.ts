/**
 * es-base — Shared Elasticsearch client infrastructure for context-mode-es.
 *
 * Provides configuration loading from secrets/.elastic.env, lazy ES client
 * instantiation, index lifecycle helpers, and client teardown. All stores
 * (ContentStore, SessionStore) consume the shared client returned by getClient().
 *
 * Reference: plans/merged/file_and_function_mapping/merged_src_db-base_v1.md
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@elastic/elasticsearch";

// ─────────────────────────────────────────────────────────
// Env file configuration
// ─────────────────────────────────────────────────────────

/**
 * Parse a .env-style file into a key-value record.
 * Handles KEY=VALUE lines, blank lines, and comment lines (starting with #).
 * Strips matching quotes (single or double) from values.
 *
 * Intentionally minimal to avoid adding `dotenv` as a dependency.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Whether loadElasticConfig() has already been called. */
let _configLoaded = false;

/** The path where the env file was found, or null if not found. */
let _configPath: string | null = null;

/**
 * Resolve the path to the elastic secrets env file.
 *
 * Priority:
 * 1. ELASTIC_ENV_PATH env var (explicit override)
 * 2. secrets/.elastic.env relative to the project root
 *
 * The project root is determined by walking up from this file's directory
 * to find package.json (standard Node.js convention).
 */
function resolveEnvFilePath(): string {
  if (process.env.ELASTIC_ENV_PATH) {
    return resolve(process.env.ELASTIC_ENV_PATH);
  }
  // Walk up from src/ to the repo root (context-mode-es/../)
  // __dirname equivalent for ESM: resolve from import.meta.url
  // But since this is compiled, use a simple relative approach
  // from the project root where secrets/ lives
  const candidates = [
    join(process.cwd(), "secrets", ".elastic.env"),
    resolve(join(import.meta.dirname ?? ".", "..", "..", "secrets", ".elastic.env")),
    resolve(join(import.meta.dirname ?? ".", "..", "secrets", ".elastic.env")),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]; // Return first candidate for error messaging
}

/**
 * Load Elasticsearch configuration from the secrets env file and populate process.env.
 *
 * Existing env vars take precedence — if ELASTIC_HOST is already set
 * in the environment (e.g., from CI), the file value does not overwrite it.
 *
 * Throws if ELASTIC_HOST is not set after loading (neither in file nor env).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function loadElasticConfig(): void {
  if (_configLoaded) return;
  _configLoaded = true;

  const envFilePath = resolveEnvFilePath();

  if (existsSync(envFilePath)) {
    _configPath = envFilePath;
    const content = readFileSync(envFilePath, "utf-8");
    const parsed = parseEnvFile(content);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }

  if (!process.env.ELASTIC_HOST) {
    throw new Error(
      `[context-mode-es] ELASTIC_HOST is not configured.\n\n` +
        `Create a secrets/.elastic.env file with at minimum:\n\n` +
        `  ELASTIC_HOST=https://your-elasticsearch-host:9200\n` +
        `  ELASTIC_APIKEY=your-api-key\n\n` +
        `Searched: ${envFilePath}\n\n` +
        `Alternatively, set ELASTIC_HOST as an environment variable,\n` +
        `or set ELASTIC_ENV_PATH to point to your env file.`,
    );
  }
}

/**
 * Return the path where the env file was loaded from, or null if not found.
 * Useful for diagnostic output (ctx_doctor, ctx_stats).
 */
export function getConfigPath(): string | null {
  return _configPath;
}

// ─────────────────────────────────────────────────────────
// ES Client (lazy singleton)
// ─────────────────────────────────────────────────────────

let _client: Client | null = null;

/**
 * Return the shared Elasticsearch client instance.
 * Creates the client on first call using ELASTIC_* env vars.
 *
 * IMPORTANT: loadElasticConfig() must be called before this function.
 * If ELASTIC_HOST is not set, this will throw.
 */
export function getClient(): Client {
  if (!_client) {
    const node = process.env.ELASTIC_HOST;
    if (!node) {
      throw new Error(
        "[context-mode-es] ELASTIC_HOST is not set. Call loadElasticConfig() before getClient().",
      );
    }

    const clientOpts: ConstructorParameters<typeof Client>[0] = {
      node,
      requestTimeout: 10_000,
      maxRetries: 3,
      tls: process.env.ELASTIC_TLS_REJECT_UNAUTHORIZED === "false"
        ? { rejectUnauthorized: false }
        : undefined,
    };

    // API key authentication (preferred)
    if (process.env.ELASTIC_APIKEY) {
      clientOpts.auth = { apiKey: process.env.ELASTIC_APIKEY };
    }
    // Basic auth fallback
    else if (process.env.ELASTIC_USERNAME && process.env.ELASTIC_PASSWORD) {
      clientOpts.auth = {
        username: process.env.ELASTIC_USERNAME,
        password: process.env.ELASTIC_PASSWORD,
      };
    }

    _client = new Client(clientOpts);
  }
  return _client;
}

// ─────────────────────────────────────────────────────────
// Index lifecycle helpers
// ─────────────────────────────────────────────────────────

/**
 * Ensure an index exists with the given mappings and settings.
 * No-op if the index already exists (idempotent).
 */
export async function ensureIndex(
  indexName: string,
  mappings: Record<string, unknown>,
  settings?: Record<string, unknown>,
): Promise<void> {
  const client = getClient();
  const exists = await client.indices.exists({ index: indexName });
  if (!exists) {
    await client.indices.create({
      index: indexName,
      settings: settings ?? { number_of_shards: 1, number_of_replicas: 0 },
      mappings,
    });
  }
}

/**
 * Return a deterministic index name for a given type and project hash.
 * Format: ctx-{type}-{hash} where hash is the first 16 chars of the
 * SHA-256 of the project directory path.
 *
 * Satisfies ES index naming constraints: lowercase, no special characters,
 * does not start with -, _, or +, well under 255 bytes.
 */
export function getIndexName(type: string, projectHash: string): string {
  return `ctx-${type}-${projectHash}`;
}

/**
 * Close the shared ES client. Safe to call multiple times.
 * Call on process exit / shutdown.
 */
export async function closeClient(): Promise<void> {
  if (_client) {
    try {
      await _client.close();
    } catch {
      // Swallow errors in cleanup path (mirrors closeDB behavior)
    }
    _client = null;
  }
}

/**
 * Delete an index. Used for test cleanup and stale index removal.
 * Silently ignores if the index does not exist.
 */
export async function deleteIndex(indexName: string): Promise<void> {
  const client = getClient();
  try {
    await client.indices.delete({
      index: indexName,
      ignore_unavailable: true,
    });
  } catch {
    // Swallow errors (mirrors deleteDBFiles behavior)
  }
}

/**
 * Reset internal state. Exported for testing only — allows tests to
 * force a fresh config load and client creation between test suites.
 */
export function _resetForTesting(): void {
  _configLoaded = false;
  _configPath = null;
  _client = null;
}
