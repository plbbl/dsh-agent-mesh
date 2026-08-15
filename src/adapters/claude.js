import { randomUUID } from 'node:crypto';

import { MeshError } from '../errors.js';
import { LineProcess } from '../line-process.js';
import { event, finalText, textFromContent, withTimeout } from './shared.js';

const DEFAULT_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];

function extractClaudeText(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.type === 'content_block_delta') return message.delta?.text ?? '';
  if (message.type === 'stream_event') {
    const eventValue = message.event;
    if (eventValue?.type === 'content_block_delta') return eventValue.delta?.text ?? '';
    if (eventValue?.type === 'message_delta') return eventValue.delta?.text ?? '';
  }
  if (message.type === 'assistant') return textFromContent(message.message?.content ?? message.content);
  if (message.type === 'result') return finalText(message.result ?? message);
  return '';
}

function hasFlag(args, flag) {
  return args.some((item) => item === flag || item.startsWith(`${flag}=`));
}

function uuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value ?? ''));
}

export class ClaudeAdapter {
  constructor(options = {}) {
    this.logger = options.logger;
  }

  async open(profile, options = {}) {
    let handle;
    const args = [...(profile.args?.length ? profile.args : DEFAULT_ARGS)];
    const launchSessionId = options.nativeSessionId && profile.resume !== false ? undefined : randomUUID();
    if (options.nativeSessionId && profile.resume !== false && !hasFlag(args, '--resume')) args.push('--resume', options.nativeSessionId);
    if (!options.nativeSessionId && !hasFlag(args, '--session-id')) args.push('--session-id', launchSessionId);
    if (profile.model && !hasFlag(args, '--model')) args.push('--model', profile.model);
    const streamPrint = (hasFlag(args, '-p') || hasFlag(args, '--print')) && hasFlag(args, '--input-format') && hasFlag(args, '--output-format');
    if (streamPrint && !hasFlag(args, '--include-partial-messages')) args.push('--include-partial-messages');
    if (streamPrint && !hasFlag(args, '--replay-user-messages')) args.push('--replay-user-messages');
    if (!hasFlag(args, '--permission-mode')) args.push('--permission-mode', profile.permissionPolicy === 'approve' ? 'acceptEdits' : 'dontAsk');
    if (profile.maxTurns && !hasFlag(args, '--max-turns')) args.push('--max-turns', String(profile.maxTurns));
    const process = new LineProcess({
      command: profile.command,
      args,
      cwd: options.cwd ?? profile.cwd,
      env: profile.env,
      inheritEnv: profile.inheritEnv,
      maxLineBytes: profile.maxLineBytes,
      onObject: (message) => this.#message(handle, message),
      onStderr: (line) => this.logger?.debug?.({ line }, 'claude stderr'),
      onExit: (exit) => {
        options.onEvent?.(event('process_exit', { exit }));
        if (handle?.active) handle.active.reject(exit.error ?? new MeshError('CLAUDE_EXITED', 'Claude Code exited during a prompt.', exit));
      },
    });
    await process.start();
    handle = {
      process,
      profile,
      nativeSessionId: options.nativeSessionId ?? launchSessionId,
      onEvent: options.onEvent,
      active: undefined,
      text: [],
    };
    return {
      nativeSessionId: handle.nativeSessionId,
      capabilities: { persistent: true, resume: true, streaming: true, partialEvents: true, replayUserMessages: true, permissionMode: true, modelSwitch: false },
      prompt: (text, metadata) => this.#prompt(handle, text, metadata),
      close: () => process.close(),
      getNativeSessionId: () => handle.nativeSessionId,
    };
  }

  async #prompt(handle, text, metadata = {}) {
    if (handle.active) throw new MeshError('CLAUDE_BUSY', 'Claude Code is already processing a prompt.');
    handle.text = [];
    const request = {
      type: 'user',
      uuid: uuid(metadata.messageId) ? metadata.messageId : randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    const result = new Promise((resolve, reject) => {
      handle.active = { resolve, reject };
    });
    try {
      await handle.process.writeJson(request);
    } catch (error) {
      handle.active = undefined;
      throw error;
    }
    let output;
    try {
      output = await withTimeout(result, handle.profile.timeoutMs, {
        code: 'CLAUDE_TIMEOUT',
        message: 'Claude Code did not finish the turn before the harness timeout.',
        onTimeout: () => handle.process.close({ graceMs: 500 }),
      });
    } finally {
      handle.active = undefined;
    }
    if (output?.is_error === true || output?.isError === true) {
      const message = finalText(output) || 'Claude Code returned an error.';
      const lower = message.toLowerCase();
      if (/session|conversation/.test(lower) && /not found|unknown|invalid|does not exist/.test(lower)) {
        throw new MeshError('NATIVE_SESSION_NOT_FOUND', message, { result: output?.result ?? output?.subtype });
      }
      throw new MeshError('CLAUDE_RESULT_ERROR', message, { result: output?.result ?? output?.subtype });
    }
    return {
      text: handle.text.join('') || finalText(output),
      nativeSessionId: handle.nativeSessionId ?? output?.session_id ?? output?.sessionId,
      isError: output?.is_error,
      usage: output?.usage,
    };
  }

  #message(handle, message) {
    if (!handle) return;
    const sessionId = message.session_id ?? message.sessionId ?? message.event?.session_id;
    if (sessionId) handle.nativeSessionId = sessionId;
    const text = message.type === 'result' && handle.text.length > 0 ? '' : extractClaudeText(message);
    if (text) {
      handle.text.push(text);
      handle.onEvent?.(event('assistant_delta', { text }));
    }
    if (message.type === 'result') {
      handle.onEvent?.(event('result', { result: { ...message, result: undefined } }));
      handle.active?.resolve(message);
      return;
    }
    if (message.type === 'system') {
      handle.onEvent?.(event('system', { message }));
      return;
    }
    if (message.type === 'stream_event') {
      handle.onEvent?.(event('stream_event', { event: message.event }));
      return;
    }
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      handle.onEvent?.(event('tool', { message }));
      return;
    }
    handle.onEvent?.(event('notification', { message }));
  }
}
