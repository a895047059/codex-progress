import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const MAX_MESSAGE_SIZE = 32 * 1024 * 1024;
const MAX_HANDSHAKE_SIZE = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.codex', 'app-server-control', 'app-server-control.sock');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function errorWithName(message, name = 'Error') {
  const error = new Error(message);
  error.name = name;
  return error;
}

function encodeFrame(opcode, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (payload.length > MAX_MESSAGE_SIZE) throw new RangeError('WebSocket message exceeds 32 MiB');

  const headerSize = payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10;
  const mask = randomBytes(4);
  const header = Buffer.alloc(headerSize + 4);
  header[0] = 0x80 | opcode;
  if (headerSize === 2) {
    header[1] = 0x80 | payload.length;
  } else if (headerSize === 4) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const maskOffset = headerSize;
  mask.copy(header, maskOffset);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index % 4];
  return Buffer.concat([header, masked]);
}

export class AppServerClient extends EventEmitter {
  constructor({ socketPath = DEFAULT_SOCKET_PATH, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (typeof socketPath !== 'string' || socketPath.length === 0) throw new TypeError('socketPath must be a non-empty string');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive number');

    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this._state = 'disconnected';
    this._socket = null;
    this._connectPromise = null;
    this._startup = null;
    this._connectTimer = null;
    this._handshakeBuffer = Buffer.alloc(0);
    this._frameBuffer = Buffer.alloc(0);
    this._fragments = null;
    this._nextId = 1;
    this._pending = new Map();
    this._closing = false;
  }

  connect() {
    if (this._state === 'ready') return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;

    this._state = 'connecting';
    this._closing = false;
    this._handshakeBuffer = Buffer.alloc(0);
    this._frameBuffer = Buffer.alloc(0);
    this._fragments = null;

    let resolveStartup;
    let rejectStartup;
    const startup = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    this._connectPromise = startup;
    this._startup = { resolve: resolveStartup, reject: rejectStartup };
    startup.then(
      () => { if (this._connectPromise === startup) this._connectPromise = null; },
      () => { if (this._connectPromise === startup) this._connectPromise = null; },
    );

    const socket = net.createConnection({ path: this.socketPath });
    this._socket = socket;
    socket.on('connect', () => this._sendHandshake(socket));
    socket.on('data', chunk => this._handleData(socket, chunk));
    socket.on('error', error => this._disconnect(error, socket));
    socket.on('close', () => this._disconnect(errorWithName('Socket disconnected', 'ConnectionError'), socket));
    this._connectTimer = setTimeout(() => {
      this._disconnect(errorWithName('Connection timed out', 'TimeoutError'), socket);
    }, this.timeoutMs);
    return startup;
  }

  request(method, params, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this._state !== 'ready') return Promise.reject(errorWithName('Client is not connected', 'ConnectionError'));
    return this._sendRequest(method, params, timeoutMs, signal);
  }

  respond(id, result) {
    if (this._state !== 'ready') throw errorWithName('Client is not connected', 'ConnectionError');
    const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));
    if (body.length > MAX_MESSAGE_SIZE) throw new RangeError('JSON-RPC response exceeds 32 MiB');
    this._socket.write(encodeFrame(1,body));
  }
  respondError(id,code,message) { this._sendRpcError(id,code,message); }

  async close() {
    const socket = this._socket;
    if (!socket) return;
    if (this._state !== 'ready') {
      this._disconnect(errorWithName('Connection closed', 'ConnectionError'), socket);
      return;
    }

    this._closing = true;
    try {
      socket.write(encodeFrame(8, Buffer.from([0x03, 0xe8])));
    } catch {
      socket.destroy();
    }
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this._socket === socket) this._disconnect(errorWithName('Connection closed', 'ConnectionError'), socket);
  }

  _sendHandshake(socket) {
    if (socket !== this._socket || this._state !== 'connecting') return;
    this._state = 'handshake';
    const key = randomBytes(16).toString('base64');
    this._expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
      'GET / HTTP/1.1',
      `Host: localhost`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  }

  _handleData(socket, chunk) {
    if (socket !== this._socket) return;
    if (this._state === 'handshake') {
      this._handshakeBuffer = Buffer.concat([this._handshakeBuffer, chunk]);
      const boundary = this._handshakeBuffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (this._handshakeBuffer.length > MAX_HANDSHAKE_SIZE) this._disconnect(errorWithName('WebSocket handshake is too large', 'ProtocolError'), socket);
        return;
      }
      if (boundary > MAX_HANDSHAKE_SIZE) {
        this._disconnect(errorWithName('WebSocket handshake is too large', 'ProtocolError'), socket);
        return;
      }
      const header = this._handshakeBuffer.subarray(0, boundary).toString('latin1');
      const remainder = this._handshakeBuffer.subarray(boundary + 4);
      this._handshakeBuffer = Buffer.alloc(0);
      if (!this._validateHandshake(header)) {
        this._disconnect(errorWithName('Invalid WebSocket handshake response', 'ProtocolError'), socket);
        return;
      }
      this._state = 'initializing';
      if (remainder.length) this._processFrames(socket, remainder);
      if (socket === this._socket) this._initialize(socket);
      return;
    }
    if (this._state === 'initializing' || this._state === 'ready') this._processFrames(socket, chunk);
  }

  _validateHandshake(header) {
    const lines = header.split('\r\n');
    if (!/^HTTP\/1\.[01] 101(?:\s|$)/.test(lines.shift() || '')) return false;
    const headers = new Map();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon <= 0) return false;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
    }
    const connection = (headers.get('connection') || '').toLowerCase().split(',').map(value => value.trim());
    return (headers.get('upgrade') || '').toLowerCase() === 'websocket'
      && connection.includes('upgrade')
      && headers.get('sec-websocket-accept') === this._expectedAccept;
  }

  async _initialize(socket) {
    try {
      await this._sendRequest('initialize', {
        clientInfo: { name: 'codex-progress', version: '0.2' },
        capabilities: { experimentalApi: true },
      }, this.timeoutMs);
      if (socket !== this._socket || this._state !== 'initializing') return;
      this._sendNotification('initialized', {});
      this._state = 'ready';
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      const startup = this._startup;
      this._startup = null;
      startup?.resolve(this);
    } catch (error) {
      this._disconnect(error, socket);
    }
  }

  _sendRequest(method, params, timeoutMs, signal) {
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method must be a non-empty string'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('timeoutMs must be a positive number'));
    if (signal?.aborted) return Promise.reject(errorWithName('Request aborted', 'AbortError'));

    const id = this._nextId++;
    const message = { jsonrpc: '2.0', id, method };
    if (params !== undefined) message.params = params;
    let body;
    try {
      body = Buffer.from(JSON.stringify(message));
      if (body.length > MAX_MESSAGE_SIZE) throw new RangeError('JSON-RPC request exceeds 32 MiB');
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const settle = (error, value) => {
        if (!this._pending.delete(id)) return;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => settle(errorWithName('Request aborted', 'AbortError'));
      const timer = setTimeout(() => settle(errorWithName(`Request timed out: ${method}`, 'TimeoutError')), timeoutMs);
      const pending = { resolve: value => settle(null, value), reject: error => settle(error), cleanup };
      this._pending.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (!this._socket || this._socket.destroyed) throw errorWithName('Socket disconnected', 'ConnectionError');
        this._socket.write(encodeFrame(1, body));
      } catch (error) {
        settle(error);
      }
    });
  }

  _sendNotification(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_MESSAGE_SIZE) throw new RangeError('JSON-RPC notification exceeds 32 MiB');
    this._socket.write(encodeFrame(1, body));
  }

  _processFrames(socket, chunk) {
    this._frameBuffer = Buffer.concat([this._frameBuffer, chunk]);
    let offset = 0;
    while (socket === this._socket && this._frameBuffer.length - offset >= 2) {
      const first = this._frameBuffer[offset];
      const second = this._frameBuffer[offset + 1];
      const fin = !!(first & 0x80);
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
        this._disconnect(errorWithName('Invalid WebSocket frame flags', 'ProtocolError'), socket);
        return;
      }

      let length = second & 0x7f;
      let headerSize = 2;
      if (length === 126) {
        if (this._frameBuffer.length - offset < 4) break;
        length = this._frameBuffer.readUInt16BE(offset + 2);
        headerSize = 4;
      } else if (length === 127) {
        if (this._frameBuffer.length - offset < 10) break;
        const longLength = this._frameBuffer.readBigUInt64BE(offset + 2);
        if (longLength > BigInt(MAX_MESSAGE_SIZE)) {
          this._disconnect(errorWithName('WebSocket frame exceeds 32 MiB', 'ProtocolError'), socket);
          return;
        }
        length = Number(longLength);
        headerSize = 10;
      }
      if (length > MAX_MESSAGE_SIZE) {
        this._disconnect(errorWithName('WebSocket frame exceeds 32 MiB', 'ProtocolError'), socket);
        return;
      }
      const control = opcode >= 8;
      if (control && (!fin || length > 125 || ![8, 9, 10].includes(opcode))) {
        this._disconnect(errorWithName('Invalid WebSocket control frame', 'ProtocolError'), socket);
        return;
      }
      const frameSize = headerSize + length;
      if (this._frameBuffer.length - offset < frameSize) break;
      const payload = this._frameBuffer.subarray(offset + headerSize, offset + frameSize);
      offset += frameSize;
      if (control) {
        if (opcode === 9) this._socket.write(encodeFrame(10, payload));
        else if (opcode === 8) {
          if (payload.length === 1) {
            this._disconnect(errorWithName('Invalid WebSocket close frame', 'ProtocolError'), socket);
            return;
          }
          if (!this._closing) this._socket.write(encodeFrame(8, payload));
          this._socket.end();
          this._disconnect(errorWithName('WebSocket peer closed', 'ConnectionError'), socket);
          return;
        }
        continue;
      }
      if (opcode === 1) {
        if (this._fragments) {
          this._disconnect(errorWithName('Unexpected WebSocket data frame', 'ProtocolError'), socket);
          return;
        }
        if (fin) this._handleText(payload, socket);
        else this._fragments = { chunks: [payload], length, opcode };
      } else if (opcode === 0) {
        if (!this._fragments) {
          this._disconnect(errorWithName('Unexpected WebSocket continuation frame', 'ProtocolError'), socket);
          return;
        }
        this._fragments.length += length;
        if (this._fragments.length > MAX_MESSAGE_SIZE) {
          this._disconnect(errorWithName('Fragmented WebSocket message exceeds 32 MiB', 'ProtocolError'), socket);
          return;
        }
        this._fragments.chunks.push(payload);
        if (fin) {
          const message = Buffer.concat(this._fragments.chunks, this._fragments.length);
          this._fragments = null;
          this._handleText(message, socket);
        }
      } else {
        this._disconnect(errorWithName('Unsupported WebSocket data opcode', 'ProtocolError'), socket);
        return;
      }
    }
    if (offset) this._frameBuffer = this._frameBuffer.subarray(offset);
    if (this._frameBuffer.length > MAX_MESSAGE_SIZE + 14) {
      this._disconnect(errorWithName('WebSocket receive buffer exceeds 32 MiB', 'ProtocolError'), socket);
    }
  }

  _handleText(payload, socket) {
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
      this._disconnect(errorWithName('Invalid JSON-RPC message', 'ProtocolError'), socket);
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._disconnect(errorWithName('Invalid JSON-RPC message', 'ProtocolError'), socket);
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      if (typeof message.method === 'string') {
        if (this.listenerCount('request')) this.emit('request', {id:message.id,method:message.method,params:message.params});
        else this._sendRpcError(message.id, -32601, 'Method not found');
        return;
      }
      const pending = this._pending.get(message.id);
      if (pending) {
        if (message.error && typeof message.error === 'object') {
          const error = errorWithName(message.error.message || 'JSON-RPC request failed', 'RpcError');
          error.code = message.error.code;
          if (Object.hasOwn(message.error, 'data')) error.data = message.error.data;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }
    if (typeof message.method === 'string') this.emit('notification', { method: message.method, params: message.params });
  }

  _sendRpcError(id, code, message) {
    if (!this._socket || this._socket.destroyed) return;
    try {
      const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
      if (body.length > MAX_MESSAGE_SIZE) throw new RangeError('JSON-RPC response exceeds 32 MiB');
      this._socket.write(encodeFrame(1, body));
    } catch (error) {
      this._disconnect(error, this._socket);
    }
  }

  _disconnect(error, socket) {
    if (socket !== this._socket) return;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._socket = null;
    this._state = 'disconnected';
    this._closing = false;
    const startup = this._startup;
    this._startup = null;
    startup?.reject(error);
    for (const pending of this._pending.values()) pending.reject(error);
    if (!socket.destroyed) socket.destroy();
    this.emit('disconnect', error);
  }
}

export default AppServerClient;
