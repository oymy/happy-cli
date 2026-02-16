# Kimi Support Implementation Summary

## Problem

Kimi CLI sessions could receive user messages from the mobile app, and Kimi would process them and display responses in the terminal. However, **responses were never delivered back to the mobile app** -- the user saw nothing on their phone.

## Root Causes

1. **Idle timeout in legacy message handler** -- `sessionUpdateHandlers.ts` accumulated message chunks but never flushed them because Kimi sends complete messages (not streamed chunks). The idle timeout handler was missing, so accumulated data was silently lost.

2. **No fallback response path** -- `runKimi.ts` relied on the legacy chunk-based message pipeline. When that pipeline dropped messages, there was no alternative path to send Kimi responses back to the server.

3. **Wire format incompatibility** -- The CLI initially sent Kimi responses using `type: 'acp'` (Agent Communication Protocol) format, which older production mobile apps don't support. Switching to `type: 'codex'` format resolved this.

## Changes Made

### CLI (`happy-cli`)

#### 1. Idle timeout for legacy message chunks
**File:** `src/agent/acp/sessionUpdateHandlers.ts`

Added an idle timeout mechanism that flushes accumulated legacy message chunks after a period of inactivity. This ensures that even if messages arrive as complete payloads (not streamed), they are still forwarded to the server.

#### 2. Fallback response sending in Kimi runner
**File:** `src/kimi/runKimi.ts`

Added `sendAgentMessage()` calls to send Kimi responses back to the server via the ACP/codex message pipeline, bypassing the legacy chunk accumulator. This ensures Kimi responses always reach the server regardless of the legacy handler's behavior.

- `SERVER_PROVIDER` set to `'gemini'` so responses are recognized by all client versions
- All response types covered: text messages, tool calls, tool results, reasoning, task lifecycle events

#### 3. Wire format: ACP to Codex
**File:** `src/api/apiSession.ts`

Changed `sendAgentMessage()` to use `type: 'codex'` wire format instead of `type: 'acp'`. The codex format has the same `data` structure (message, reasoning, tool-call, tool-call-result) but is supported by all existing production mobile app versions. The `provider` field was dropped as codex format doesn't use it.

### Client (`happy-client`)

#### 4. Kimi provider enum (optional, for future ACP support)
**File:** `packages/happy-app/sources/sync/typesRaw.ts`

Added `'kimi'` to the ACP provider enum: `z.enum(['gemini', 'codex', 'claude', 'opencode', 'kimi'])`. Not strictly required since we use `provider: 'gemini'`, but prepares for future when the app is updated to support ACP natively.

#### 5. Kimi in profile compatibility schema
**File:** `packages/happy-app/sources/sync/settings.ts`

Added `'kimi'` to `ProfileCompatibilitySchema` so sessions with Kimi flavor are recognized by the client.

#### 6. Defensive null guards in terminal auth
**File:** `packages/happy-app/sources/hooks/useConnectTerminal.ts`

Added null checks for `auth.credentials` and `sync.encryption?.contentDataKey` before accessing them. Prevents crashes when the "Connect Terminal" flow runs before encryption is fully initialized.

## Test Infrastructure Created

### `scripts/direct-auth.mjs`
Bypasses mobile app for CLI authentication. Creates a server account, generates ephemeral keypair, approves auth request, and saves credentials. Useful for automated testing without a phone.

### `scripts/test-terminal-auth.mjs`
Validates all server-side auth endpoints (`/v1/auth/request`, `/v1/auth/request/status`, `/v1/auth/response`). Confirmed that "terminal connection failed" errors originate from the client side, not the server.

### `scripts/test-kimi-e2e.mjs`
Full end-to-end test for Kimi message delivery:
1. Starts Kimi CLI in background
2. Decrypts session DEK using content box secret key
3. Connects to server via Socket.IO as the "app"
4. Sends an encrypted test message via `socket.emit('message')`
5. Waits for Kimi response via Socket.IO updates + HTTP polling
6. Verifies the response was delivered back to the server

**Result: TEST PASSED** -- Kimi responded with the exact expected text and the response was stored on the server.

## Key Discoveries

### Message transport
- Messages between app and CLI are sent via **Socket.IO `emit('message')`**, not HTTP POST
- The mobile app's `flushOutbox` references `/v3/sessions/:id/messages` which exists on the production server but not in the local server codebase
- The production server has v3 endpoints; the local development server does not

### Encryption architecture
- Each session has a random AES-256-GCM key (DEK) encrypted with the user's NaCl box public key (contentDataKey)
- The CLI encrypts messages with `encryptWithDataKey()` -- format: `version(1) + nonce(12) + ciphertext + authTag(16)`
- The mobile app decrypts using the corresponding private key derived from the master secret

### Message format compatibility
- **`type: 'output'`** -- Claude's native format (oldest, most compatible)
- **`type: 'codex'`** -- Codex format with message/reasoning/tool-call/tool-call-result (widely supported)
- **`type: 'acp'`** -- Unified Agent Communication Protocol with provider field (newest, not in all production builds)
- Kimi now uses `codex` format for maximum compatibility

## Verification

Tested against both local development server (`localhost:3005`) and production server (`api.happy-servers.com`). Messages flow successfully: **App -> Server -> CLI (Kimi) -> Server -> App**.
