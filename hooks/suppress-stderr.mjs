/**
 * suppress-stderr.mjs — No-op stub.
 *
 * This file previously suppressed stderr for better-sqlite3 native module noise.
 * Now that we use @elastic/elasticsearch (pure JS), stderr suppression is unnecessary.
 *
 * The file is kept as an empty stub to prevent ERR_MODULE_NOT_FOUND for:
 * - pretooluse.mjs variants (which still import this file but don't use SessionDB)
 * - Any third-party hooks that import this file
 *
 * Will be deleted entirely in Phase 7 cleanup.
 */
