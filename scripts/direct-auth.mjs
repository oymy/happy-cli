#!/usr/bin/env node
/**
 * Direct authentication script that bypasses the browser entirely.
 * Simulates both CLI and Web app sides of the auth flow.
 *
 * Usage: HAPPY_SERVER_URL=http://localhost:3005 node scripts/direct-auth.mjs [home-dir]
 */

import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { randomBytes, createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const HOME_DIR = process.argv[2] || process.env.HAPPY_HOME_DIR?.replace(/^~/, homedir()) || join(homedir(), '.happy-dev');
const PRIVATE_KEY_FILE = join(HOME_DIR, 'access.key');
const SETTINGS_FILE = join(HOME_DIR, 'settings.json');

function encodeBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function decodeBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function encryptBox(data, recipientPublicKey) {
  const ephemeralKeyPair = tweetnacl.box.keyPair();
  const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
  const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

  const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
  result.set(ephemeralKeyPair.publicKey, 0);
  result.set(nonce, ephemeralKeyPair.publicKey.length);
  result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
  return result;
}

function decryptBox(bundle, recipientSecretKey) {
  const ephemeralPublicKey = bundle.slice(0, 32);
  const nonce = bundle.slice(32, 32 + tweetnacl.box.nonceLength);
  const encrypted = bundle.slice(32 + tweetnacl.box.nonceLength);
  return tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
}

async function main() {
  console.log(`Server: ${SERVER_URL}`);
  console.log(`Home dir: ${HOME_DIR}`);
  console.log(`Key file: ${PRIVATE_KEY_FILE}`);
  console.log('');

  // Step 1: Create an account on the server
  console.log('Step 1: Creating account...');
  const accountSeed = new Uint8Array(randomBytes(32));
  const signKeyPair = tweetnacl.sign.keyPair.fromSeed(accountSeed);
  const challenge = new Uint8Array(randomBytes(32));
  const signature = tweetnacl.sign.detached(challenge, signKeyPair.secretKey);

  const authResponse = await axios.post(`${SERVER_URL}/v1/auth`, {
    publicKey: encodeBase64(signKeyPair.publicKey),
    challenge: encodeBase64(challenge),
    signature: encodeBase64(signature)
  });

  if (!authResponse.data.success) {
    console.error('Failed to create account:', authResponse.data);
    process.exit(1);
  }

  const accountToken = authResponse.data.token;
  console.log('  Account created, got token:', accountToken.substring(0, 20) + '...');

  // Step 2: Generate ephemeral keypair (simulating CLI side)
  console.log('Step 2: Creating terminal auth request...');
  const ephemeralSecret = new Uint8Array(randomBytes(32));
  const ephemeralKeypair = tweetnacl.box.keyPair.fromSecretKey(ephemeralSecret);

  const authReqResponse = await axios.post(`${SERVER_URL}/v1/auth/request`, {
    publicKey: encodeBase64(ephemeralKeypair.publicKey),
    supportsV2: true
  });
  console.log('  Auth request created, state:', authReqResponse.data.state);

  // Step 3: Approve the auth request (simulating Web app side)
  console.log('Step 3: Approving auth request...');

  // Check status first
  const statusResponse = await axios.get(`${SERVER_URL}/v1/auth/request/status`, {
    params: { publicKey: encodeBase64(ephemeralKeypair.publicKey) }
  });
  console.log('  Status:', statusResponse.data.status, 'supportsV2:', statusResponse.data.supportsV2);

  if (statusResponse.data.status !== 'pending') {
    console.error('  Unexpected status:', statusResponse.data.status);
    process.exit(1);
  }

  // Create the response payload
  // For V2: [0x00] + [32-byte contentDataKey (which is a NaCl box public key)]
  // Generate a proper NaCl box keypair so we can decrypt session DEKs later
  const contentBoxKeypair = tweetnacl.box.keyPair();
  const contentDataKey = contentBoxKeypair.publicKey; // This is the public key the CLI will use
  const responseV2Bundle = new Uint8Array(contentDataKey.length + 1);
  responseV2Bundle[0] = 0;
  responseV2Bundle.set(contentDataKey, 1);

  // Encrypt with the ephemeral public key
  const encryptedResponse = encryptBox(responseV2Bundle, ephemeralKeypair.publicKey);

  const approveResponse = await axios.post(`${SERVER_URL}/v1/auth/response`, {
    publicKey: encodeBase64(ephemeralKeypair.publicKey),
    response: encodeBase64(encryptedResponse)
  }, {
    headers: { 'Authorization': `Bearer ${accountToken}` }
  });
  console.log('  Approved:', approveResponse.data);

  // Step 4: Poll for the authorized response (simulating CLI side)
  console.log('Step 4: Fetching authorized credentials...');
  const pollResponse = await axios.post(`${SERVER_URL}/v1/auth/request`, {
    publicKey: encodeBase64(ephemeralKeypair.publicKey),
    supportsV2: true
  });

  if (pollResponse.data.state !== 'authorized') {
    console.error('  Not authorized:', pollResponse.data);
    process.exit(1);
  }

  const cliToken = pollResponse.data.token;
  const encryptedPayload = decodeBase64(pollResponse.data.response);

  // Decrypt
  const decrypted = decryptBox(encryptedPayload, ephemeralKeypair.secretKey);
  if (!decrypted) {
    console.error('  Failed to decrypt response');
    process.exit(1);
  }

  console.log('  Decrypted payload length:', decrypted.length, 'first byte:', decrypted[0]);

  // Step 5: Save credentials
  console.log('Step 5: Saving credentials...');

  if (!existsSync(HOME_DIR)) {
    await mkdir(HOME_DIR, { recursive: true });
  }

  if (decrypted[0] === 0 && decrypted.length > 32) {
    // V2 mode (dataKey)
    const publicKey = decrypted.slice(1, 33);
    const machineKey = new Uint8Array(randomBytes(32));

    const credentials = {
      encryption: {
        publicKey: encodeBase64(publicKey),
        machineKey: encodeBase64(machineKey)
      },
      token: cliToken
    };

    await writeFile(PRIVATE_KEY_FILE, JSON.stringify(credentials, null, 2));
    console.log('  Saved V2 credentials to:', PRIVATE_KEY_FILE);

    // Save the content box secret key for e2e testing (decrypt session DEKs)
    const testKeyFile = join(HOME_DIR, 'test-content-secret.key');
    await writeFile(testKeyFile, JSON.stringify({
      contentBoxSecretKey: encodeBase64(contentBoxKeypair.secretKey),
      contentBoxPublicKey: encodeBase64(contentBoxKeypair.publicKey),
    }, null, 2));
    console.log('  Saved test content secret key to:', testKeyFile);
  } else if (decrypted.length === 32) {
    // Legacy mode
    const credentials = {
      secret: encodeBase64(decrypted),
      token: cliToken
    };

    await writeFile(PRIVATE_KEY_FILE, JSON.stringify(credentials, null, 2));
    console.log('  Saved legacy credentials to:', PRIVATE_KEY_FILE);
  } else {
    console.error('  Unknown payload format, length:', decrypted.length);
    process.exit(1);
  }

  // Step 6: Ensure settings.json has machineId
  if (!existsSync(SETTINGS_FILE)) {
    const { randomUUID } = await import('node:crypto');
    const settings = { machineId: randomUUID() };
    await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log('  Created settings.json with machineId:', settings.machineId);
  }

  console.log('');
  console.log('Authentication complete! You can now use the CLI.');
  console.log(`Run: HAPPY_SERVER_URL=${SERVER_URL} HAPPY_HOME_DIR=${HOME_DIR} ./bin/happy.mjs`);
}

main().catch(e => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
