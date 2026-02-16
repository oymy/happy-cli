#!/usr/bin/env node
/**
 * Test script that simulates the Web app's terminal connect flow.
 * Starts CLI auth login, captures the public key, and approves it
 * just like the Web app would.
 *
 * This helps diagnose "连接终端失败" issues.
 */

import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

const SERVER_URL = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';

function encodeBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function decodeBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

function decodeBase64Url(base64url) {
  const base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    + '='.repeat((4 - base64url.length % 4) % 4);
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

async function main() {
  console.log(`Server: ${SERVER_URL}`);
  console.log('');

  // Step 1: Create an account (to get a valid token for approving)
  console.log('Step 1: Creating account for approval...');
  const accountSeed = new Uint8Array(randomBytes(32));
  const signKeyPair = tweetnacl.sign.keyPair.fromSeed(accountSeed);
  const challenge = new Uint8Array(randomBytes(32));
  const signature = tweetnacl.sign.detached(challenge, signKeyPair.secretKey);

  const authResponse = await axios.post(`${SERVER_URL}/v1/auth`, {
    publicKey: encodeBase64(signKeyPair.publicKey),
    challenge: encodeBase64(challenge),
    signature: encodeBase64(signature)
  });
  const accountToken = authResponse.data.token;
  console.log('  Got account token');

  // Step 2: Simulate the CLI creating an auth request
  console.log('Step 2: Creating ephemeral keypair (like CLI)...');
  const ephemeralSecret = new Uint8Array(randomBytes(32));
  const ephemeralKeypair = tweetnacl.box.keyPair.fromSecretKey(ephemeralSecret);
  const publicKeyBase64 = encodeBase64(ephemeralKeypair.publicKey);
  const publicKeyBase64Url = Buffer.from(ephemeralKeypair.publicKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  console.log('  Public key (base64):', publicKeyBase64.substring(0, 20) + '...');
  console.log('  Public key (base64url):', publicKeyBase64Url.substring(0, 20) + '...');

  // Step 3: Send auth request to server (like CLI does)
  console.log('Step 3: Sending auth request to server...');
  const reqResp = await axios.post(`${SERVER_URL}/v1/auth/request`, {
    publicKey: publicKeyBase64,
    supportsV2: true
  });
  console.log('  Server response:', reqResp.data);

  // Step 4: Simulate what the Web app does
  console.log('');
  console.log('=== Simulating Web App terminal connect flow ===');
  console.log('');

  // 4a: The web app gets the base64url key from the URL hash
  // Then does: const publicKey = decodeBase64(tail, 'base64url')
  console.log('Step 4a: Decoding base64url key (like Web app)...');
  const decodedPublicKey = decodeBase64Url(publicKeyBase64Url);
  console.log('  Decoded key length:', decodedPublicKey.length, '(should be 32)');
  console.log('  Keys match:', Buffer.from(decodedPublicKey).equals(Buffer.from(ephemeralKeypair.publicKey)));

  // 4b: The web app encodes the key back to standard base64
  // Then sends GET /v1/auth/request/status?publicKey=base64
  const reEncodedBase64 = encodeBase64(decodedPublicKey);
  console.log('  Re-encoded base64:', reEncodedBase64.substring(0, 20) + '...');
  console.log('  Base64 matches original:', reEncodedBase64 === publicKeyBase64);

  console.log('Step 4b: Checking auth request status (like Web app)...');
  try {
    const statusResp = await axios.get(`${SERVER_URL}/v1/auth/request/status`, {
      params: { publicKey: reEncodedBase64 }
    });
    console.log('  Status response:', statusResp.data);
  } catch (e) {
    console.error('  STATUS CHECK FAILED:', e.response?.status, e.response?.data || e.message);
    console.log('  This is likely the cause of "连接终端失败"!');
    process.exit(1);
  }

  // 4c: Create encrypted response
  console.log('Step 4c: Creating encrypted response (like Web app)...');

  // V1: encrypt a random secret (simulating auth.credentials.secret)
  const fakeSecret = new Uint8Array(randomBytes(32));
  const responseV1 = encryptBox(fakeSecret, decodedPublicKey);
  console.log('  V1 response length:', responseV1.length);

  // V2: [0x00] + [32-byte contentDataKey]
  const fakeContentDataKey = new Uint8Array(randomBytes(32));
  const responseV2Bundle = new Uint8Array(fakeContentDataKey.length + 1);
  responseV2Bundle[0] = 0;
  responseV2Bundle.set(fakeContentDataKey, 1);
  const responseV2 = encryptBox(responseV2Bundle, decodedPublicKey);
  console.log('  V2 response length:', responseV2.length);

  // 4d: Send auth response (like Web app does in authApprove)
  console.log('Step 4d: Sending auth response (like Web app)...');
  try {
    const approveResp = await axios.post(`${SERVER_URL}/v1/auth/response`, {
      publicKey: reEncodedBase64,
      response: encodeBase64(responseV2)  // supportsV2 = true
    }, {
      headers: { 'Authorization': `Bearer ${accountToken}` }
    });
    console.log('  Approve response:', approveResp.data);
  } catch (e) {
    console.error('  AUTH RESPONSE FAILED:', e.response?.status, e.response?.data || e.message);
    console.log('  This is likely the cause of "连接终端失败"!');
    process.exit(1);
  }

  // Step 5: Verify the CLI would get the credentials
  console.log('Step 5: Polling for credentials (like CLI)...');
  const pollResp = await axios.post(`${SERVER_URL}/v1/auth/request`, {
    publicKey: publicKeyBase64,
    supportsV2: true
  });
  console.log('  Poll response state:', pollResp.data.state);

  if (pollResp.data.state === 'authorized') {
    console.log('');
    console.log('SUCCESS! The entire auth flow works correctly.');
    console.log('The "连接终端失败" issue is NOT in the server-side auth endpoints.');
    console.log('It must be a client-side issue in the Web app (browser console would show the exact error).');
  } else {
    console.log('');
    console.log('FAILED! Auth was not approved.');
  }
}

main().catch(e => {
  console.error('Error:', e.response?.data || e.message);
  process.exit(1);
});
