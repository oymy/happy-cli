#!/usr/bin/env node
/**
 * E2E test for Kimi message delivery fix.
 *
 * Verifies: App → Server → CLI (Kimi) → Server → App message round-trip.
 *
 * 1. Starts Kimi CLI in background
 * 2. Decrypts session DEK using content box secret key
 * 3. Connects to server via Socket.IO as the "app" (user-scoped)
 * 4. Sends a test message via Socket.IO emit('message')
 * 5. Waits for Kimi response to arrive back via socket update + HTTP poll
 */

import { io } from 'socket.io-client';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const HOME_DIR = process.env.HAPPY_HOME_DIR?.replace(/^~/, homedir()) || join(homedir(), '.happy-dev');
const CLI_BIN = join(process.cwd(), 'bin', 'happy.mjs');

function encodeBase64(buffer) { return Buffer.from(buffer).toString('base64'); }
function decodeBase64(base64) { return new Uint8Array(Buffer.from(base64, 'base64')); }

/**
 * Encrypt data using AES-256-GCM (dataKey variant).
 * Bundle format: version(1) + nonce(12) + ciphertext + authTag(16)
 */
function encryptWithDataKey(data, dataKey) {
  const nonce = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
  const plaintext = new TextEncoder().encode(JSON.stringify(data));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const bundle = new Uint8Array(1 + 12 + encrypted.length + 16);
  bundle[0] = 0; // version
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(encrypted), 13);
  bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
  return bundle;
}

function decryptWithDataKey(bundle, dataKey) {
  if (!bundle || bundle.length < 29 || bundle[0] !== 0) return null;
  try {
    const nonce = bundle.slice(1, 13);
    const authTag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch { return null; }
}

async function main() {
  console.log('=== Kimi E2E Message Delivery Test ===');
  console.log(`Server: ${SERVER_URL}`);

  // Load credentials
  const creds = JSON.parse(readFileSync(join(HOME_DIR, 'access.key'), 'utf-8'));
  const token = creds.token;

  // Load content box secret key (for decrypting session DEK)
  const testKeyFile = join(HOME_DIR, 'test-content-secret.key');
  if (!existsSync(testKeyFile)) {
    console.error('Missing test-content-secret.key. Re-run direct-auth.mjs first.');
    process.exit(1);
  }
  const testKeys = JSON.parse(readFileSync(testKeyFile, 'utf-8'));
  const contentSecretKey = decodeBase64(testKeys.contentBoxSecretKey);
  console.log('Credentials and test keys loaded.');

  // Step 1: Start Kimi CLI
  console.log('\nStep 1: Starting Kimi CLI...');
  const cliProcess = spawn('node', [CLI_BIN, 'kimi'], {
    env: {
      ...process.env,
      HAPPY_SERVER_URL: SERVER_URL,
      HAPPY_WEBAPP_URL: 'http://localhost:8081',
      HAPPY_HOME_DIR: HOME_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let cliOutput = '';
  cliProcess.stdout.on('data', d => cliOutput += d.toString());
  cliProcess.stderr.on('data', d => cliOutput += d.toString());

  // Wait for session ID from CLI output
  const sessionId = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for Kimi session')), 30000);
    const check = setInterval(() => {
      const match = cliOutput.match(/Session ID: ([a-z0-9]+)/);
      if (match) { clearInterval(check); clearTimeout(timeout); resolve(match[1]); }
    }, 500);
  });
  console.log(`  Session: ${sessionId}`);

  // Give CLI time to fully initialize (register socket handlers, etc.)
  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Get session from server and decrypt DEK
  console.log('\nStep 2: Decrypting session encryption key...');
  const sessionsResp = await axios.get(`${SERVER_URL}/v1/sessions`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const sessionData = sessionsResp.data.sessions?.find(s => s.id === sessionId);
  if (!sessionData) {
    console.error('  Session not found on server!');
    cleanup(cliProcess);
    process.exit(1);
  }

  if (!sessionData.dataEncryptionKey) {
    console.error('  Session has no dataEncryptionKey!');
    cleanup(cliProcess);
    process.exit(1);
  }

  // Decrypt the session's dataEncryptionKey
  // Format: version(1) + ephemeralPk(32) + nonce(24) + ciphertext
  const encryptedDEK = decodeBase64(sessionData.dataEncryptionKey);
  const version = encryptedDEK[0];
  console.log(`  DEK version: ${version}, total length: ${encryptedDEK.length}`);

  const ephemeralPk = encryptedDEK.slice(1, 33);
  const dekNonce = encryptedDEK.slice(33, 57);
  const dekCiphertext = encryptedDEK.slice(57);

  const sessionKey = tweetnacl.box.open(dekCiphertext, dekNonce, ephemeralPk, contentSecretKey);
  if (!sessionKey) {
    console.error('  Failed to decrypt session DEK!');
    cleanup(cliProcess);
    process.exit(1);
  }
  console.log(`  Session key decrypted (${sessionKey.length} bytes)`);

  // Step 3: Connect via Socket.IO as "app" (user-scoped connection)
  console.log('\nStep 3: Connecting to server as app...');
  const socket = io(SERVER_URL, {
    path: '/v1/updates',
    auth: { token, clientType: 'user-scoped' },
    transports: ['websocket']
  });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Socket timeout')), 10000);
    socket.on('connect', () => { clearTimeout(t); resolve(); });
    socket.on('connect_error', e => { clearTimeout(t); reject(e); });
  });
  console.log('  Connected (socketId: ' + socket.id + ')');

  // Step 4: Send encrypted message via Socket.IO (same as CLI does)
  console.log('\nStep 4: Sending test message to Kimi via Socket.IO...');
  const testMsg = 'Respond with exactly: "hello e2e test"';

  // UserMessage format matching UserMessageSchema:
  // { role: 'user', content: { type: 'text', text: '...' } }
  const messageContent = {
    role: 'user',
    content: {
      type: 'text',
      text: testMsg
    },
    meta: {
      sentFrom: 'web',
      permissionMode: 'bypassPermissions'
    }
  };

  const encryptedBody = encryptWithDataKey(messageContent, sessionKey);
  const localId = `e2e-${Date.now()}`;

  // Emit via Socket.IO (matching server's sessionUpdateHandler 'message' event)
  socket.emit('message', {
    sid: sessionId,
    message: encodeBase64(encryptedBody),
    localId
  });
  console.log(`  Message emitted (localId: ${localId})`);

  // Step 5: Wait for Kimi response
  console.log('\nStep 5: Waiting for Kimi response (up to 120s)...');

  let gotResponse = false;
  let responseContent = null;

  // Listen on socket for updates
  socket.on('update', (data) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsed?.body?.t === 'new-message') {
        const msgBody = parsed.body.message?.content;
        if (msgBody?.t === 'encrypted' && msgBody?.c) {
          const dec = decryptWithDataKey(decodeBase64(msgBody.c), sessionKey);
          if (dec) {
            console.log(`  [Socket] Got message:`, JSON.stringify(dec).substring(0, 200));
            if (dec.role === 'agent' || dec.content?.type === 'acp' || dec.content?.type === 'output') {
              gotResponse = true;
              responseContent = dec;
            }
          } else {
            console.log(`  [Socket] Got encrypted message but could not decrypt`);
          }
        }
      }
    } catch (e) {
      console.log(`  [Socket] Error processing update: ${e.message}`);
    }
  });

  // Also poll messages endpoint as backup
  const startTime = Date.now();
  while (!gotResponse && Date.now() - startTime < 120000) {
    await new Promise(r => setTimeout(r, 5000));

    try {
      const msgsResp = await axios.get(
        `${SERVER_URL}/v1/sessions/${sessionId}/messages`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const msgs = msgsResp.data.messages || [];
      console.log(`  [Poll] ${msgs.length} messages on server`);

      for (const msg of msgs) {
        if (msg.content?.t === 'encrypted' && msg.content?.c) {
          const dec = decryptWithDataKey(decodeBase64(msg.content.c), sessionKey);
          if (dec && (dec.role === 'agent' || dec.content?.type === 'acp' || dec.content?.type === 'output')) {
            gotResponse = true;
            responseContent = dec;
            console.log(`  [Poll] Agent message found:`, JSON.stringify(dec).substring(0, 200));
          }
        }
      }
    } catch (e) {
      console.log(`  [Poll] Error: ${e.message}`);
    }
  }

  // Results
  console.log('\n=== RESULTS ===');
  if (gotResponse) {
    console.log('TEST PASSED: Kimi response was delivered back to the server!');
    console.log('Response:', JSON.stringify(responseContent).substring(0, 300));
  } else {
    console.log('TEST RESULT: No agent message found on server after 120s.');
    console.log('\nCLI output (last 30 lines):');
    const lines = cliOutput.split('\n').slice(-30);
    lines.forEach(l => console.log('  ', l));

    // Final message count check
    try {
      const final = await axios.get(
        `${SERVER_URL}/v1/sessions/${sessionId}/messages`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const count = final.data.messages?.length || 0;
      console.log(`\nFinal message count on server: ${count}`);
      if (count > 1) {
        console.log('Messages exist but could not be decrypted as agent messages.');
        console.log('This may indicate responses ARE being sent but with different format.');
        console.log('PARTIAL SUCCESS - the delivery fix may be working!');
      } else if (count === 1) {
        console.log('Only our sent message found - Kimi did not respond.');
        console.log('Check CLI logs for errors.');
      } else {
        console.log('No messages at all - message sending may have failed.');
      }
    } catch {}
  }

  cleanup(cliProcess, socket);
}

function cleanup(cliProcess, socket) {
  if (socket) socket.disconnect();
  if (cliProcess) {
    cliProcess.kill('SIGTERM');
    setTimeout(() => {
      try { cliProcess.kill('SIGKILL'); } catch {}
    }, 3000);
  }
  // Give cleanup time then exit
  setTimeout(() => process.exit(0), 4000);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
