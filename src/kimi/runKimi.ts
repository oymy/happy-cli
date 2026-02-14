/**
 * Kimi CLI Entry Point
 *
 * This module provides the main entry point for running the Kimi agent
 * through Happy CLI via ACP protocol.
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { join, resolve } from 'node:path';

import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { initialMachineMetadata } from '@/daemon/run';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { projectPath } from '@/projectPath';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentBackend } from '@/agent';

import { createKimiBackend, type KimiBackendResult } from '@/agent/factories/kimi';
import { KimiDisplay } from '@/ui/ink/KimiDisplay';
import type { KimiMode } from '@/kimi/types';
import type { PermissionMode } from '@/api/types';
import { DEFAULT_KIMI_MODEL, CHANGE_TITLE_INSTRUCTION } from '@/kimi/constants';
import { displayQRCode } from '@/ui/qrcode';

/**
 * Wait for any key press from stdin
 */
function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    const onData = () => {
      cleanup();
      resolve();
    };
    
    const cleanup = () => {
      process.stdin.off('data', onData);
      try {
        process.stdin.setRawMode(false);
      } catch { /* ignore */ }
    };
    
    // Setup raw mode to capture single keypress
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.once('data', onData);
    } catch (error) {
      // If we can't setup raw mode, just resolve after a timeout
      setTimeout(resolve, 5000);
    }
  });
}

/**
 * Main entry point for the kimi command with ink UI
 */
export async function runKimi(opts: {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
}): Promise<void> {
  const sessionTag = randomUUID();

  // Set backend for offline warnings
  connectionState.setBackend('Kimi');

  const api = await ApiClient.create(opts.credentials);

  // Machine setup
  const settings = await readSettings();
  const machineId = settings?.machineId;
  if (!machineId) {
    console.error(`[START] No machine ID found in settings. Please report this issue.`);
    process.exit(1);
  }
  logger.debug(`Using machineId: ${machineId}`);
  await api.getOrCreateMachine({
    machineId,
    metadata: initialMachineMetadata
  });

  // Create session
  const { state, metadata } = createSessionMetadata({
    flavor: 'kimi',
    machineId,
    startedBy: opts.startedBy
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

  // Handle server unreachable case
  let session: ApiSessionClient;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
    }
  });
  session = initialSession;

  // Report to daemon
  if (response) {
    try {
      logger.debug(`[START] Reporting session ${response.id} to daemon`);
      const result = await notifyDaemonSessionStarted(response.id, metadata);
      if (result.error) {
        logger.debug(`[START] Failed to report to daemon:`, result.error);
      }
    } catch (error) {
      logger.debug('[START] Failed to report to daemon:', error);
    }
  }

  const messageQueue = new MessageQueue2<KimiMode>((mode) => hashObject({
    permissionMode: mode.permissionMode,
    model: mode.model,
  }));

  // Track current overrides
  let currentPermissionMode: PermissionMode | undefined = undefined;
  let currentModel: string | undefined = undefined;

  session.onUserMessage((message) => {
    // Resolve permission mode
    let messagePermissionMode = currentPermissionMode;
    if (message.meta?.permissionMode) {
      messagePermissionMode = message.meta.permissionMode as PermissionMode;
      currentPermissionMode = messagePermissionMode;
      logger.debug(`[Kimi] Permission mode updated: ${currentPermissionMode}`);
    }

    // Resolve model
    let messageModel = currentModel;
    if (message.meta?.hasOwnProperty('model')) {
      messageModel = message.meta.model || undefined;
      currentModel = messageModel;
      logger.debug(`[Kimi] Model updated: ${messageModel || 'default'}`);
    }

    const mode: KimiMode = {
      permissionMode: messagePermissionMode || 'default',
      model: messageModel,
    };
    messageQueue.push(message.content.text, mode);
  });

  let thinking = false;
  session.keepAlive(thinking, 'remote');
  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  const sendReady = () => {
    session.sendSessionEvent({ type: 'ready' });
    try {
      api.push().sendToAllDevices(
        "It's ready!",
        'Kimi is waiting for your command',
        { sessionId: session.sessionId }
      );
    } catch (pushError) {
      logger.debug('[Kimi] Failed to send ready push', pushError);
    }
  };

  // Display connection info for mobile app
  function displayConnectionInfo(): void {
    const sessionUrl = `${configuration.webappUrl}/s/${session.sessionId}`;
    const appUrl = `happy://session?id=${session.sessionId}`;
    
    console.log('\n' + '='.repeat(60));
    console.log('📱 Kimi session started!');
    console.log('='.repeat(60));
    console.log('\nConnect from your mobile device:');
    console.log('\n1. Scan QR code with Happy App:');
    
    // Display QR code
    try {
      displayQRCode(appUrl);
    } catch (e) {
      // If QR code fails, just show the URL
      console.log('   (QR code unavailable)');
    }
    
    console.log('\n2. Or open this URL in your browser:');
    console.log(`   ${sessionUrl}`);
    console.log('\n3. Or manually enter session ID in the app:');
    console.log(`   Session ID: ${session.sessionId}`);
    console.log('='.repeat(60) + '\n');
    
    // Also log to debug
    logger.debug('[Kimi] Session URL:', sessionUrl);
    logger.debug('[Kimi] App URL:', appUrl);
  }

  // Abort handling
  let abortController = new AbortController();
  let shouldExit = false;
  let kimiBackend: AgentBackend | null = null;
  let acpSessionId: string | null = null;

  async function handleAbort() {
    logger.debug('[Kimi] Abort requested');
    
    session.sendAgentMessage('kimi', {
      type: 'turn_aborted',
      id: randomUUID(),
    });
    
    try {
      abortController.abort();
      messageQueue.reset();
      if (kimiBackend && acpSessionId) {
        await kimiBackend.cancel(acpSessionId);
      }
    } catch (error) {
      logger.debug('[Kimi] Error during abort:', error);
    } finally {
      abortController = new AbortController();
    }
  }

  const handleKillSession = async () => {
    logger.debug('[Kimi] Kill session requested');
    await handleAbort();

    try {
      if (session) {
        session.updateMetadata((currentMetadata) => ({
          ...currentMetadata,
          lifecycleState: 'archived',
          lifecycleStateSince: Date.now(),
          archivedBy: 'cli',
          archiveReason: 'User terminated'
        }));

        session.sendSessionDeath();
        await session.flush();
        await session.close();
      }

      stopCaffeinate();
      happyServer.stop();

      if (kimiBackend) {
        await kimiBackend.dispose();
      }

      process.exit(0);
    } catch (error) {
      logger.debug('[Kimi] Error during termination:', error);
      process.exit(1);
    }
  };

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Initialize UI
  const messageBuffer = new MessageBuffer();
  const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
  let inkInstance: ReturnType<typeof render> | null = null;

  // Display connection info before UI clears the screen
  displayConnectionInfo();

  // Wait for user to press any key before entering UI
  if (hasTTY) {
    console.log('\n👉 Press any key to continue...');
    await waitForKeypress();
    console.clear();
    inkInstance = render(React.createElement(KimiDisplay, {
      messageBuffer,
      logPath: process.env.DEBUG ? logger.logFilePath : undefined,
      onExit: async () => {
        logger.debug('[Kimi]: Exiting via Ctrl-C');
        shouldExit = true;
        await handleAbort();
      }
    }), {
      exitOnCtrlC: false,
      patchConsole: false
    });
  }

  if (hasTTY) {
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
  }

  // Start Happy MCP server and create Kimi backend
  const happyServer = await startHappyServer(session);
  const bridgeCommand = join(projectPath(), 'bin', 'happy-mcp.mjs');
  const mcpServers = {
    happy: {
      command: bridgeCommand,
      args: ['--url', happyServer.url]
    }
  };

  const kimiBackendResult: KimiBackendResult = createKimiBackend({
    cwd: metadata.path,
    mcpServers,
  });
  kimiBackend = kimiBackendResult.backend;

  // Register message handler
  kimiBackend.onMessage((msg) => {
    switch (msg.type) {
      case 'status':
        if (msg.status === 'starting') {
          thinking = true;
          session.keepAlive(thinking, 'remote');
        } else if (msg.status === 'idle' || msg.status === 'stopped') {
          thinking = false;
          session.keepAlive(thinking, 'remote');
          
          // Emit ready when idle and queue empty
          if (!shouldExit && messageQueue.size() === 0) {
            sendReady();
          }
        } else if (msg.status === 'error') {
          logger.debug('[Kimi] Error:', msg.detail);
          messageBuffer.addMessage(`Error: ${msg.detail}`, 'status');
        }
        break;
      
      case 'model-output':
        thinking = true;
        session.keepAlive(thinking, 'remote');
        if (msg.textDelta) {
          messageBuffer.addMessage(msg.textDelta, 'assistant');
          
          // Send to mobile app
          session.sendAgentMessage('kimi', {
            type: 'message',
            message: msg.textDelta,
          });
        }
        break;
      
      case 'tool-call':
        thinking = true;
        session.keepAlive(thinking, 'remote');
        session.sendAgentMessage('kimi', {
          type: 'tool-call',
          callId: msg.callId,
          name: msg.toolName,
          input: msg.args,
          id: msg.callId,
        });
        break;
      
      case 'tool-result':
        session.sendAgentMessage('kimi', {
          type: 'tool-result',
          callId: msg.callId,
          output: msg.result,
          id: msg.callId,
        });
        break;
      
      case 'permission-request':
        // Permission handling is done via ACP
        logger.debug('[Kimi] Permission request:', msg);
        break;
    }
  });

  // Main loop
  try {
    while (!shouldExit) {
      const nextMessage = await messageQueue.waitForMessagesAndGetAsString(abortController.signal);
      if (!nextMessage) {
        continue;
      }

      const { message, mode } = nextMessage;
      
      // Start session if not started
      if (!acpSessionId) {
        const sessionResult = await kimiBackend.startSession();
        acpSessionId = sessionResult.sessionId;
        logger.debug(`[Kimi] Started ACP session: ${acpSessionId}`);
      }

      // Send prompt
      thinking = true;
      session.keepAlive(thinking, 'remote');
      
      try {
        await kimiBackend.sendPrompt(acpSessionId, message);
        await kimiBackend.waitForResponseComplete?.(120000);
      } catch (error) {
        logger.debug('[Kimi] Error during prompt:', error);
        messageBuffer.addMessage('Error processing request', 'status');
      }
      
      thinking = false;
      session.keepAlive(thinking, 'remote');
      
      // Send ready if queue empty
      if (messageQueue.size() === 0) {
        sendReady();
      }
    }
  } catch (error) {
    logger.debug('[Kimi] Main loop error:', error);
  } finally {
    // Cleanup
    clearInterval(keepAliveInterval);
    
    if (inkInstance) {
      inkInstance.unmount();
    }
    
    if (kimiBackend) {
      await kimiBackend.dispose();
    }
    
    happyServer.stop();
    stopCaffeinate();
    
    if (session) {
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    }
  }
}
