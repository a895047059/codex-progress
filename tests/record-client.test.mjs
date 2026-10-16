import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { RecordClient } from '../src/record-client.mjs';

const tools = [
  { name: 'event_stream_start', inputSchema: { type: 'object', properties: {} } },
  { name: 'event_stream_status', inputSchema: { type: 'object', properties: {} } },
  { name: 'event_stream_stop', inputSchema: { type: 'object', properties: {} } },
  { name: 'other_tool', inputSchema: { type: 'object', properties: {} } },
];

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super();
    this.exitCode = null;
    this.killCount = 0;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let input = '';
    this.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input += chunk.toString();
        let boundary;
        while ((boundary = input.indexOf('\n')) !== -1) {
          const line = input.slice(0, boundary);
          input = input.slice(boundary + 1);
          if (line) onMessage(JSON.parse(line), thisChild);
        }
        callback();
      },
    });
    const thisChild = this;
  }

  send(message, split = false) {
    const line = Buffer.from(`${JSON.stringify(message)}\n`);
    if (!split || line.length < 2) {
      this.stdout.write(line);
      return;
    }
    const midpoint = Math.floor(line.length / 2);
    this.stdout.write(line.subarray(0, midpoint));
    setImmediate(() => this.stdout.write(line.subarray(midpoint)));
  }

  kill() {
    this.killCount += 1;
    setImmediate(() => {
      if (this.exitCode !== null) return;
      this.exitCode = 0;
      this.emit('exit', 0, null);
      this.stdout.end();
      this.emit('close', 0, null);
    });
    return true;
  }

  exit(code = 1) {
    this.exitCode = code;
    this.emit('exit', code, null);
    this.stdout.end();
    this.emit('close', code, null);
  }
}

function harness(onCall = () => {}, {
  onElicitation = null,
  onClientResponse = () => {},
  onDiagnostic = null,
  timeoutMs = 120,
} = {}) {
  const messages = [];
  let child;
  const spawnImpl = (command, args, options) => {
    assert.equal(command, '/mock/sky-client');
    assert.deepEqual(args, ['event-stream', 'mcp']);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    child = new FakeChild(message => {
      messages.push(message);
      if (message.method === 'initialize') {
        child.send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05' } }, true);
      } else if (message.method === 'tools/list') {
        child.send({ jsonrpc: '2.0', id: message.id, result: { tools } }, true);
      } else if (message.method === 'tools/call') {
        onCall(message, child);
      } else if (message.method === undefined) {
        onClientResponse(message, child);
      }
    });
    return child;
  };
  const client = new RecordClient({
    command: '/mock/sky-client',
    spawnImpl,
    timeoutMs,
    connectTimeoutMs: 120,
    onElicitation,
    onDiagnostic,
  });
  return { client, messages, get child() { return child; } };
}

test('MCP 握手、工具列表筛选与工具原始结果', async () => {
  const state = harness((message, child) => {
    child.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'recording status' }], isError: false },
    }, true);
  });
  try {
    const listed = await state.client.connect();
    assert.deepEqual(state.messages.slice(0, 3).map(message => message.method), [
      'initialize', 'notifications/initialized', 'tools/list',
    ]);
    assert.deepEqual(state.messages[0].params, {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'codex-progress', version: '0.2' },
    });
    assert.deepEqual(listed.map(tool => tool.name), [
      'event_stream_start', 'event_stream_status', 'event_stream_stop',
    ]);
    assert.deepEqual(await state.client.call('event_stream_status'), {
      content: [{ type: 'text', text: 'recording status' }],
      isError: false,
    });
    assert.deepEqual(state.messages.at(-1).params, {
      name: 'event_stream_status',
      arguments: {},
    });
  } finally {
    await state.client.close();
  }
});

test('JSON-RPC error 和 isError 都失败，错误文本不带入任意响应内容', async () => {
  const diagnostics = [];
  const state = harness((message, child) => {
    if (message.params.name === 'event_stream_start') {
      child.send({ jsonrpc: '2.0', id: message.id, error: { code: -32042, message: 'permission denied private stderr text' } });
    } else {
      child.send({
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: 'private tool detail' }] },
      });
    }
  }, { onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
  try {
    await state.client.connect();
    await assert.rejects(state.client.call('event_stream_start'), error => {
      assert.equal(error.name, 'RpcError');
      assert.equal(error.code, -32042);
      assert.equal(error.message, 'Record MCP 请求失败（-32042）');
      return true;
    });
    await assert.rejects(state.client.call('event_stream_stop'), error => {
      assert.equal(error.name, 'ToolError');
      assert.equal(error.message, 'Record 工具调用失败');
      return true;
    });
    assert.deepEqual(diagnostics[0], {
      stage: 'tool',
      category: 'permission',
      rpcCode: -32042,
    });
    assert.deepEqual(diagnostics[1], {
      stage: 'tool',
      category: 'unknown',
      mcpIsError: true,
    });
    assert.equal(JSON.stringify(diagnostics).includes('private'), false);
  } finally {
    await state.client.close();
  }
});

test('工具失败只输出受限分类、已知 code 和错误名', async () => {
  const diagnostics = [];
  const failures = [
    'operation timed out',
    'connection closed by peer',
    'permission denied by system',
    'approval required before recording',
    'recording cancelled by user',
    'private event payload -10005',
    'private event payload -10005 RecordPermissionError',
  ];
  const state = harness((message, child) => {
    const text = failures.shift();
    child.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isError: true, content: [{ type: 'text', text }] },
    });
  }, { onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
  try {
    await state.client.connect();
    for (let index = 0; index < 7; index += 1) {
      await assert.rejects(state.client.call('event_stream_start'), error => error.name === 'ToolError');
    }
    assert.deepEqual(diagnostics.map(diagnostic => diagnostic.category), [
      'timeout', 'connection', 'permission', 'approval', 'cancel', 'unknown',
      'permission',
    ]);
    assert.equal(diagnostics[5].code, -10005);
    assert.equal(diagnostics[6].code, -10005);
    assert.equal(diagnostics[6].errorName, 'RecordPermissionError');
    assert.equal(JSON.stringify(diagnostics).includes('private event payload'), false);
  } finally {
    await state.client.close();
  }
});

test('诊断回调抛错或返回拒绝不会改变请求错误语义', async () => {
  const state = harness(() => {}, {
    timeoutMs: 20,
    onDiagnostic: () => Promise.reject(new Error('diagnostic callback failure')),
  });
  try {
    await state.client.connect();
    await assert.rejects(state.client.call('event_stream_start'), error => {
      assert.equal(error.name, 'TimeoutError');
      assert.equal(error.message, 'Record MCP 请求超时');
      return true;
    });
  } finally {
    await state.client.close();
  }
});

test('未声明的工具在本地拒绝，不发送 tools/call', async () => {
  const state = harness();
  try {
    await state.client.connect();
    const count = state.messages.length;
    await assert.rejects(state.client.call('unlisted_tool'), error => error.name === 'ToolError');
    assert.equal(state.messages.length, count);
  } finally {
    await state.client.close();
  }
});

test('请求超时、进程退出与 close 都会拒绝 pending call，close 可重复调用', async () => {
  const state = harness();
  await state.client.connect();
  await assert.rejects(state.client.call('event_stream_start', { timeoutMs: 20 }), error => error.name === 'TimeoutError');

  const onExit = state.client.call('event_stream_status');
  state.child.exit();
  await assert.rejects(onExit, error => error.name === 'ConnectionError');
  await state.client.close();

  const closing = harness();
  await closing.client.connect();
  const pending = closing.client.call('event_stream_stop');
  const firstClose = closing.client.close();
  const secondClose = closing.client.close();
  await assert.rejects(pending, error => error.name === 'ConnectionError');
  await Promise.all([firstClose, secondClose]);
  assert.equal(closing.child.killCount, 1);
});

test('连接阶段在 connectTimeoutMs 到期时拒绝 initialize', async () => {
  let child;
  const client = new RecordClient({
    command: '/mock/sky-client',
    spawnImpl: () => {
      child = new FakeChild(() => {});
      return child;
    },
    connectTimeoutMs: 20,
  });
  await assert.rejects(client.connect(), error => error.name === 'TimeoutError');
  await client.close();
});

test('elicitation/create 与同 ID 的工具请求分流，只有 UI 明确空内容 accept 才回写接受', async () => {
  let approve;
  let received;
  let receivedSignal;
  const state = harness((call, child) => {
    child.send({
      jsonrpc: '2.0',
      id: call.id,
      method: 'elicitation/create',
      params: {
        message: 'Allow ChatGPT to record your actions on your Mac?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { requestTag: 'approval' },
      },
    });
  }, {
    onElicitation: (request, { signal }) => {
      received = request;
      receivedSignal = signal;
      return new Promise(resolve => { approve = resolve; });
    },
    onClientResponse: response => {
      if (response.result?.action === 'accept') {
        state.child.send({
          jsonrpc: '2.0',
          id: response.id,
          result: { isError: false, content: [{ type: 'text', text: 'recording started' }] },
        });
      }
    },
  });

  try {
    await state.client.connect();
    let callFinished = false;
    const call = state.client.call('event_stream_start').then(result => {
      callFinished = true;
      return result;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callFinished, false);
    assert.deepEqual(received, {
      message: 'Allow ChatGPT to record your actions on your Mac?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { requestTag: 'approval' },
    });
    assert.equal(receivedSignal.aborted, false);
    assert.equal(state.messages.some(message => message.id === 3 && message.result?.action === 'accept'), false);

    approve({ action: 'accept', content: {} });
    assert.deepEqual(await call, {
      isError: false,
      content: [{ type: 'text', text: 'recording started' }],
    });
    assert.deepEqual(state.messages.find(message => message.id === 3 && message.result?.action), {
      jsonrpc: '2.0',
      id: 3,
      result: { action: 'accept', content: {} },
    });
  } finally {
    await state.client.close();
  }
});

test('无 handler 或未知 elicitation schema 默认 decline，不调用 handler', async () => {
  const noHandler = harness((call, child) => {
    child.send({
      jsonrpc: '2.0',
      id: 501,
      method: 'elicitation/create',
      params: { message: 'Confirm recording', requestedSchema: { type: 'object', properties: {} } },
    });
    child.send({ jsonrpc: '2.0', id: call.id, result: { isError: false } });
  });
  try {
    await noHandler.client.connect();
    await noHandler.client.call('event_stream_start');
    assert.deepEqual(noHandler.messages.find(message => message.id === 501), {
      jsonrpc: '2.0', id: 501, result: { action: 'decline' },
    });
  } finally {
    await noHandler.client.close();
  }

  let handlerCalls = 0;
  const unknownSchema = harness((call, child) => {
    child.send({
      jsonrpc: '2.0',
      id: 502,
      method: 'elicitation/create',
      params: {
        message: 'Unexpected input request',
        requestedSchema: { type: 'object', properties: { token: { type: 'string' } } },
      },
    });
    child.send({ jsonrpc: '2.0', id: call.id, result: { isError: false } });
  }, { onElicitation: async () => { handlerCalls += 1; return { action: 'accept', content: {} }; } });
  try {
    await unknownSchema.client.connect();
    await unknownSchema.client.call('event_stream_start');
    assert.equal(handlerCalls, 0);
    assert.deepEqual(unknownSchema.messages.find(message => message.id === 502), {
      jsonrpc: '2.0', id: 502, result: { action: 'decline' },
    });
  } finally {
    await unknownSchema.client.close();
  }
});

test('elicitation callback 的 cancel 可回写；非空 accept 内容会降级为 decline', async () => {
  let nextAction = { action: 'cancel' };
  let activeCallId;
  const state = harness((call, child) => {
    activeCallId = call.id;
    const requestId = call.id + 100;
    child.send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'elicitation/create',
      params: { message: 'Confirm recording', requestedSchema: { type: 'object', properties: {} } },
    });
  }, {
    onElicitation: async () => nextAction,
    onClientResponse: (response, child) => {
      if (response.result?.action) child.send({ jsonrpc: '2.0', id: activeCallId, result: { isError: false } });
    },
  });
  try {
    await state.client.connect();
    await state.client.call('event_stream_start');
    assert.deepEqual(state.messages.find(message => message.id === 103), {
      jsonrpc: '2.0', id: 103, result: { action: 'cancel' },
    });

    nextAction = { action: 'accept', content: { secret: 'must not be sent' } };
    await state.client.call('event_stream_start');
    assert.deepEqual(state.messages.find(message => message.id === 104), {
      jsonrpc: '2.0', id: 104, result: { action: 'decline' },
    });
    assert.equal(JSON.stringify(state.messages).includes('must not be sent'), false);
  } finally {
    await state.client.close();
  }
});

test('close 或进程断开会 abort 未完成的 elicitation，不等待 UI 回答', async () => {
  const makeWaitingClient = () => {
    let signal;
    const state = harness((call, child) => {
      child.send({
        jsonrpc: '2.0',
        id: call.id + 200,
        method: 'elicitation/create',
        params: { message: 'Confirm recording', requestedSchema: { type: 'object', properties: {} } },
      });
    }, {
      onElicitation: (_request, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    return { state, get signal() { return signal; } };
  };

  const closing = makeWaitingClient();
  await closing.state.client.connect();
  const pendingCloseCall = assert.rejects(closing.state.client.call('event_stream_start'), error => error.name === 'ConnectionError');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closing.signal.aborted, false);
  await closing.state.client.close();
  await pendingCloseCall;
  assert.equal(closing.signal.aborted, true);
  assert.equal(closing.state.messages.some(message => message.result?.action === 'accept'), false);

  const disconnect = makeWaitingClient();
  await disconnect.state.client.connect();
  const pendingDisconnectCall = assert.rejects(disconnect.state.client.call('event_stream_start'), error => error.name === 'ConnectionError');
  await new Promise(resolve => setImmediate(resolve));
  disconnect.state.child.exit();
  await pendingDisconnectCall;
  assert.equal(disconnect.signal.aborted, true);
  await disconnect.state.client.close();
});
