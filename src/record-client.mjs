import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const MAX_LINE_SIZE = 4 * 1024 * 1024;
const ABORTED = Symbol('elicitation aborted');
const REQUEST_FAILURE_DIAGNOSED = Symbol('record request failure diagnosed');
const ERROR_CATEGORIES = new Set(['timeout', 'connection', 'permission', 'approval', 'cancel', 'unknown']);
const KNOWN_ERROR_NAMES = [
  'RecordingPermissionError',
  'RecordPermissionError',
  'TimeoutError',
  'ConnectionError',
  'PermissionError',
  'ApprovalError',
  'CancellationError',
  'CancelledError',
  'UserCancelledError',
];
const ALLOWED_TOOLS = new Set([
  'event_stream_start',
  'event_stream_status',
  'event_stream_stop',
]);
const CLIENT_COMMAND = path.resolve(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'computer-use',
  'Codex Computer Use.app',
  'Contents',
  'SharedSupport',
  'SkyComputerUseClient.app',
  'Contents',
  'MacOS',
  'SkyComputerUseClient',
);

function makeError(message, name = 'Error', code) {
  const error = new Error(message);
  error.name = name;
  if (code !== undefined) error.code = code;
  return error;
}

function validTimeout(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive number`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function classifyFailure(...values) {
  const text = values.filter(value => typeof value === 'string').join(' ').toLowerCase();
  if (/timeout|timed[ -]?out|deadline/.test(text)) return 'timeout';
  if (/connection|connect|disconnect|closed|unavailable|socket|pipe/.test(text)) return 'connection';
  if (/permission|denied|not permitted|forbidden|access/.test(text)) return 'permission';
  if (/approval|approve|authorization|authoriz|consent|confirm/.test(text)) return 'approval';
  if (/cancel|cancelled|canceled|declin/.test(text)) return 'cancel';
  return 'unknown';
}

function extractFailureText(result) {
  if (!isObject(result) || !Array.isArray(result.content)) return '';
  return result.content
    .filter(item => isObject(item) && item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join(' ');
}

function extractFailureHints(text) {
  const hints = {};
  const code = text.match(/(^|[^\w])-\d{3,6}([^\w]|$)/)?.[0]?.match(/-\d{3,6}/)?.[0];
  if (code !== undefined) hints.code = Number(code);
  const errorName = KNOWN_ERROR_NAMES.find(name => text.includes(name));
  if (errorName !== undefined) hints.errorName = errorName;
  return hints;
}

function knownErrorName(value) {
  return typeof value === 'string' && KNOWN_ERROR_NAMES.includes(value) ? value : undefined;
}

function isEmptyFormRequest(params) {
  if (!isObject(params) || typeof params.message !== 'string' || !isObject(params.requestedSchema)) return false;
  const schema = params.requestedSchema;
  const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'title', 'description']);
  if (Object.keys(schema).some(key => !allowedKeys.has(key))) return false;
  if (schema.type !== 'object' || !isObject(schema.properties) || Object.keys(schema.properties).length !== 0) return false;
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.length !== 0)) return false;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return false;
  if (schema.title !== undefined && typeof schema.title !== 'string') return false;
  if (schema.description !== undefined && typeof schema.description !== 'string') return false;
  return true;
}

function normalizeElicitationResult(result) {
  if (!isObject(result)) return { action: 'decline' };
  const keys = Object.keys(result);
  if (result.action === 'accept' && keys.length === 2 && keys.includes('action') && keys.includes('content') && isObject(result.content)
      && Object.keys(result.content).length === 0) {
    return { action: 'accept', content: {} };
  }
  if (keys.length === 1 && keys[0] === 'action' && result.action === 'decline') return { action: 'decline' };
  if (keys.length === 1 && keys[0] === 'action' && result.action === 'cancel') return { action: 'cancel' };
  return { action: 'decline' };
}

export class RecordClient {
  constructor({
    command = CLIENT_COMMAND,
    args = ['event-stream', 'mcp'],
    spawnImpl = spawn,
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    onElicitation = null,
    onDiagnostic = null,
  } = {}) {
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be a non-empty string');
    if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) throw new TypeError('args must be an array of strings');
    if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
    if (onElicitation !== null && typeof onElicitation !== 'function') throw new TypeError('onElicitation must be a function');
    if (onDiagnostic !== null && typeof onDiagnostic !== 'function') throw new TypeError('onDiagnostic must be a function');
    validTimeout(timeoutMs, 'timeoutMs');
    validTimeout(connectTimeoutMs, 'connectTimeoutMs');

    this.command = command;
    this.args = [...args];
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onElicitation = onElicitation;
    this.onDiagnostic = onDiagnostic;
    this._state = 'disconnected';
    this._child = null;
    this._buffer = Buffer.alloc(0);
    this._nextId = 1;
    this._pending = new Map();
    this._elicitationPending = new Map();
    this._tools = [];
    this._connectPromise = null;
    this._connectTimer = null;
    this._closePromise = null;
  }

  _emitDiagnostic({ stage, error, rpcCode, mcpIsError, errorName, text = '' }) {
    if (!this.onDiagnostic) return;
    const category = classifyFailure(error?.name, error?.message, text);
    const diagnostic = { stage, category };
    if (rpcCode !== undefined) diagnostic.rpcCode = rpcCode;
    if (mcpIsError !== undefined) diagnostic.mcpIsError = mcpIsError;
    const hints = extractFailureHints(text);
    if (hints.code !== undefined) diagnostic.code = hints.code;
    const safeErrorName = knownErrorName(errorName) || hints.errorName;
    if (safeErrorName !== undefined) diagnostic.errorName = safeErrorName;
    if (!ERROR_CATEGORIES.has(diagnostic.category)) diagnostic.category = 'unknown';
    try {
      const result = this.onDiagnostic(diagnostic);
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
    } catch {
      // Diagnostics must never affect recording behavior.
    }
  }

  _emitRequestDiagnostic(stage, error, details = {}) {
    if (error && typeof error === 'object') {
      try { Object.defineProperty(error, REQUEST_FAILURE_DIAGNOSED, { value: true, configurable: true }); } catch { /* Ignore frozen errors. */ }
    }
    this._emitDiagnostic({ stage, error, ...details });
  }

  connect() {
    if (this._state === 'ready') return Promise.resolve(this._tools);
    if (this._connectPromise) return this._connectPromise;
    if (this._state === 'closed' || this._state === 'failed') {
      return Promise.reject(makeError('Record 客户端已关闭', 'ConnectionError'));
    }

    this._state = 'connecting';
    this._connectTimer = setTimeout(() => {
      this._fail(makeError('Record MCP 连接超时', 'TimeoutError'));
    }, this.connectTimeoutMs);

    this._connectPromise = this._connectSequence().then(tools => {
      if (this._state !== 'connecting') throw makeError('Record MCP 连接已中断', 'ConnectionError');
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this._state = 'ready';
      return tools;
    }).catch(error => {
      if (!error?.[REQUEST_FAILURE_DIAGNOSED]) this._emitDiagnostic({ stage: 'connect', error });
      if (this._state !== 'closed') this._fail(error);
      throw error;
    }).finally(() => {
      this._connectPromise = null;
    });

    return this._connectPromise;
  }

  async _connectSequence() {
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      throw makeError('无法启动 Record MCP 客户端', 'ConnectionError');
    }
    if (!child?.stdin || !child?.stdout || typeof child.on !== 'function') {
      throw makeError('Record MCP 客户端启动失败', 'ConnectionError');
    }
    this._child = child;
    // Drain diagnostics without retaining or exposing them to the UI.
    child.stderr?.resume?.();
    child.stdout.on('data', chunk => this._onData(chunk));
    child.stdout.on('error', () => this._fail(makeError('Record MCP 输出流中断', 'ConnectionError')));
    child.stdin.on?.('error', () => this._fail(makeError('Record MCP 输入流中断', 'ConnectionError')));
    child.on('error', () => this._fail(makeError('Record MCP 客户端异常退出', 'ConnectionError')));
    child.on('exit', () => this._fail(makeError('Record MCP 客户端已退出', 'ConnectionError')));
    child.on('close', () => this._fail(makeError('Record MCP 客户端已退出', 'ConnectionError')));

    await this._request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { elicitation: {} },
      clientInfo: { name: 'codex-progress', version: '0.2' },
    }, this.connectTimeoutMs, 'connect');
    this._notify('notifications/initialized');
    const listing = await this._request('tools/list', {}, this.connectTimeoutMs, 'connect');
    if (!Array.isArray(listing?.tools)) throw makeError('Record MCP 工具列表无效', 'ProtocolError');
    this._tools = listing.tools.filter(tool => tool && ALLOWED_TOOLS.has(tool.name));
    return this._tools;
  }

  call(name, { timeoutMs = this.timeoutMs } = {}) {
    if (this._state !== 'ready') return Promise.reject(makeError('Record 客户端尚未连接', 'ConnectionError'));
    if (typeof name !== 'string' || !ALLOWED_TOOLS.has(name) || !this._tools.some(tool => tool.name === name)) {
      return Promise.reject(makeError('未声明的 Record 工具', 'ToolError'));
    }
    validTimeout(timeoutMs, 'timeoutMs');
    return this._request('tools/call', { name, arguments: {} }, timeoutMs, 'tool').then(result => {
      if (result?.isError === true) {
        this._emitDiagnostic({
          stage: 'tool',
          error: makeError('Record 工具调用失败', 'ToolError'),
          mcpIsError: true,
          text: extractFailureText(result),
        });
        throw makeError('Record 工具调用失败', 'ToolError');
      }
      return result;
    });
  }

  close() {
    if (this._closePromise) return this._closePromise;
    if (this._state === 'closed') return Promise.resolve();
    this._state = 'closed';
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._rejectPending(makeError('Record 客户端已关闭', 'ConnectionError'));
    this._abortElicitations();
    const child = this._child;
    if (!child) return Promise.resolve();

    this._closePromise = new Promise(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill?.(); } catch { /* The child may already have exited. */ }
        finish();
      }, 250);
      child.once?.('close', finish);
      try {
        child.stdin?.end?.();
        child.kill?.();
      } catch {
        finish();
      }
      if (child.exitCode !== null && child.exitCode !== undefined) finish();
    });
    return this._closePromise;
  }

  _request(method, params, timeoutMs, stage = 'request') {
    if (!this._child || this._state === 'closed' || this._state === 'failed') {
      return Promise.reject(makeError('Record MCP 客户端不可用', 'ConnectionError'));
    }
    const id = this._nextId++;
    const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        const error = makeError('Record MCP 请求超时', 'TimeoutError');
        this._emitRequestDiagnostic(stage, error);
        reject(error);
      }, timeoutMs);
      this._pending.set(id, {
        stage,
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error, details = {}) => {
          clearTimeout(timer);
          this._emitRequestDiagnostic(stage, error, details);
          reject(error);
        },
      });
      try {
        this._child.stdin.write(message);
      } catch {
        this._pending.delete(id);
        clearTimeout(timer);
        const error = makeError('Record MCP 请求发送失败', 'ConnectionError');
        this._emitRequestDiagnostic(stage, error);
        reject(error);
      }
    });
  }

  _notify(method) {
    try {
      this._child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    } catch {
      throw makeError('Record MCP 初始化通知发送失败', 'ConnectionError');
    }
  }

  _onData(chunk) {
    if (this._state === 'closed' || this._state === 'failed') return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const combined = Buffer.concat([this._buffer, incoming]);
    let start = 0;
    let newline;
    while ((newline = combined.indexOf(0x0a, start)) !== -1) {
      const line = combined.subarray(start, newline);
      if (line.length > MAX_LINE_SIZE) {
        this._fail(makeError('Record MCP 响应超过大小限制', 'ProtocolError'));
        return;
      }
      this._handleLine(line);
      if (this._state === 'failed' || this._state === 'closed') return;
      start = newline + 1;
    }
    this._buffer = Buffer.from(combined.subarray(start));
    if (this._buffer.length > MAX_LINE_SIZE) this._fail(makeError('Record MCP 响应超过大小限制', 'ProtocolError'));
  }

  _handleLine(line) {
    if (line.length === 0) return;
    const text = line[line.length - 1] === 0x0d ? line.subarray(0, -1).toString('utf8') : line.toString('utf8');
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this._fail(makeError('Record MCP 响应格式无效', 'ProtocolError'));
      return;
    }
    if (message?.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) return;
      if ((typeof message.id !== 'string' && typeof message.id !== 'number')
          || (typeof message.id === 'number' && !Number.isFinite(message.id))) {
        this._fail(makeError('Record MCP 请求 ID 无效', 'ProtocolError'));
        return;
      }
      if (message.method === 'elicitation/create') this._handleElicitation(message);
      else this._writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const pending = this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    if (message.error && typeof message.error === 'object') {
      const code = Number.isInteger(message.error.code) ? message.error.code : undefined;
      const error = makeError(code === undefined ? 'Record MCP 请求失败' : `Record MCP 请求失败（${code}）`, 'RpcError', code);
      const errorName = knownErrorName(message.error.name)
        || (isObject(message.error.data) ? knownErrorName(message.error.data.name) : undefined);
      pending.reject(error, {
        rpcCode: code,
        errorName,
        text: typeof message.error.message === 'string' ? message.error.message : '',
      });
    } else if (!Object.hasOwn(message, 'result')) {
      const error = makeError('Record MCP 响应缺少结果', 'ProtocolError');
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
  }

  _handleElicitation(request) {
    if (this._elicitationPending.has(request.id)) {
      this._fail(makeError('Record MCP elicitation ID 重复', 'ProtocolError'));
      return;
    }
    if (!this.onElicitation || !isEmptyFormRequest(request.params)) {
      this._writeMessage({ jsonrpc: '2.0', id: request.id, result: { action: 'decline' } });
      return;
    }

    const controller = new AbortController();
    this._elicitationPending.set(request.id, controller);
    const params = request.params;
    const payload = {
      message: params.message,
      requestedSchema: params.requestedSchema,
    };
    if (Object.hasOwn(params, '_meta')) payload._meta = params._meta;
    void this._resolveElicitation(request.id, payload, controller);
  }

  async _resolveElicitation(id, payload, controller) {
    let result = { action: 'decline' };
    try {
      const handlerPromise = Promise.resolve().then(() => this.onElicitation(payload, { signal: controller.signal }));
      let abortListener;
      const abortPromise = new Promise(resolve => {
        abortListener = () => resolve(ABORTED);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      let handlerResult;
      try {
        handlerResult = await Promise.race([handlerPromise, abortPromise]);
      } finally {
        controller.signal.removeEventListener('abort', abortListener);
      }
      if (handlerResult === ABORTED || controller.signal.aborted) return;
      result = normalizeElicitationResult(handlerResult);
    } catch {
      result = { action: 'decline' };
    }
    if (controller.signal.aborted || this._elicitationPending.get(id) !== controller) return;
    this._elicitationPending.delete(id);
    this._writeMessage({ jsonrpc: '2.0', id, result });
  }

  _abortElicitations() {
    for (const controller of this._elicitationPending.values()) controller.abort();
    this._elicitationPending.clear();
  }

  _writeMessage(message) {
    try {
      this._child?.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      this._fail(makeError('Record MCP 响应发送失败', 'ConnectionError'));
    }
  }

  _fail(error) {
    if (this._state === 'closed' || this._state === 'failed') return;
    const hadPending = this._pending.size > 0;
    this._state = 'failed';
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._rejectPending(error);
    if (!hadPending) this._emitDiagnostic({ stage: 'connection', error });
    this._abortElicitations();
    try { this._child?.kill?.(); } catch { /* The child may already have exited. */ }
  }
}
