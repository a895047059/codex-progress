import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AppServerClient } from '../src/rpc-client.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serverFrame(opcode, value, fin = true) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const headerSize = payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10;
  const header = Buffer.alloc(headerSize);
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (headerSize === 2) header[1] = payload.length;
  else if (headerSize === 4) {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function jsonFrame(value, fin = true, opcode = 1) {
  return serverFrame(opcode, JSON.stringify(value), fin);
}

async function mockServer(onMessage, { handshake = true } = {}) {
  const socketPath = path.join(os.tmpdir(), `rpc-${randomUUID()}.sock`);
  const sockets = new Set();
  const serverErrors = [];
  let pongResolve;
  const pong = new Promise(resolve => { pongResolve = resolve; });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let mode = 'handshake';
    let buffer = Buffer.alloc(0);
    let fragments = [];
    let fragmentSize = 0;
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (mode === 'handshake') {
        const boundary = buffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const headers = buffer.subarray(0, boundary).toString('latin1');
        buffer = buffer.subarray(boundary + 4);
        if (!handshake) return;
        const key = headers.match(/\r\nSec-WebSocket-Key: ([^\r\n]+)/i)?.[1];
        if (!key) {
          serverErrors.push(new Error('missing WebSocket key'));
          socket.destroy();
          return;
        }
        const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        mode = 'frames';
      }
      while (mode === 'frames' && buffer.length >= 2) {
        const first = buffer[0], second = buffer[1];
        let length = second & 0x7f, headerSize = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          headerSize = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const large = buffer.readBigUInt64BE(2);
          if (large > 32n * 1024n * 1024n) {
            serverErrors.push(new Error('client frame exceeded 32 MiB'));
            socket.destroy();
            return;
          }
          length = Number(large);
          headerSize = 10;
        }
        const masked = !!(second & 0x80);
        const frameSize = headerSize + (masked ? 4 : 0) + length;
        if (buffer.length < frameSize) return;
        if (!masked) {
          serverErrors.push(new Error('client frame was not masked'));
          socket.destroy();
          return;
        }
        const maskOffset = headerSize;
        const payload = Buffer.from(buffer.subarray(maskOffset + 4, frameSize));
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(frameSize);
        const opcode = first & 0x0f;
        if (opcode === 9) {
          socket.write(serverFrame(10, payload));
        } else if (opcode === 10) {
          pongResolve(payload.toString());
        } else if (opcode === 8) {
          socket.write(serverFrame(8, payload));
          socket.end();
          return;
        } else if (opcode === 1) {
          if (first & 0x80) onMessage(JSON.parse(payload.toString()), socket);
          else {
            fragments = [payload];
            fragmentSize = payload.length;
          }
        } else if (opcode === 0) {
          fragments.push(payload);
          fragmentSize += payload.length;
          if (first & 0x80) {
            onMessage(JSON.parse(Buffer.concat(fragments, fragmentSize).toString()), socket);
            fragments = [];
            fragmentSize = 0;
          }
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    serverErrors,
    pong,
    sockets,
    send(socket, ...frames) { socket.write(Buffer.concat(frames)); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('Unix WebSocket 握手、initialize、并发请求、扩展长度、分片与 ping/pong', async () => {
  let initialized = false;
  let resolveInitialized;
  const serverInitialized = new Promise(resolve => { resolveInitialized = resolve; });
  let mock;
  const parallel = [];
  mock = await mockServer((message, socket) => {
    if (message.method === 'initialize') {
      assert.deepEqual(message.params, {
        clientInfo: { name: 'codex-progress', version: '0.2' },
        capabilities: { experimentalApi: true },
      });
      mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, result: {} }));
    } else if (message.method === 'initialized') {
      initialized = true;
      resolveInitialized();
      const notification = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'server/ready', params: { ok: true } }));
      const split = Math.floor(notification.length / 2);
      mock.send(socket,
        serverFrame(1, notification.subarray(0, split), false),
        serverFrame(9, 'probe'),
        serverFrame(0, notification.subarray(split)),
      );
    } else if (message.method === 'echo') {
      mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, result: message.params }));
    } else if (message.method === 'parallel') {
      parallel.push({ id: message.id, index: message.params.index });
      if (parallel.length === 2) {
        for (const { id, index } of parallel.reverse()) mock.send(socket, jsonFrame({ jsonrpc: '2.0', id, result: { index } }));
      }
    }
  });
  const client = new AppServerClient({ socketPath: mock.socketPath, timeoutMs: 1000 });
  const notification = new Promise(resolve => client.once('notification', resolve));
  try {
    assert.equal(await client.connect(), client);
    await serverInitialized;
    assert.equal(initialized, true);
    assert.deepEqual(await notification, { method: 'server/ready', params: { ok: true } });
    assert.equal(await mock.pong, 'probe');
    const mediumText = 'y'.repeat(200);
    assert.equal((await client.request('echo', { text: mediumText })).text.length, mediumText.length);
    const longText = 'x'.repeat(70 * 1024);
    assert.equal((await client.request('echo', { text: longText })).text.length, longText.length);
    const results = await Promise.all([
      client.request('parallel', { index: 1 }),
      client.request('parallel', { index: 2 }),
    ]);
    assert.deepEqual(results, [{ index: 1 }, { index: 2 }]);
    assert.deepEqual(mock.serverErrors, []);
  } finally {
    await client.close();
    await mock.close();
  }
});

test('断连时拒绝所有 pending request 并发出 disconnect', async () => {
  let mock;
  mock = await mockServer((message, socket) => {
    if (message.method === 'initialize') mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, result: {} }));
    else if (message.method === 'hang') socket.destroy();
  });
  const client = new AppServerClient({ socketPath: mock.socketPath, timeoutMs: 1000 });
  const disconnected = new Promise(resolve => client.once('disconnect', resolve));
  try {
    await client.connect();
    await assert.rejects(client.request('hang'), /disconnect|closed/i);
    assert.match((await disconnected).message, /disconnect/i);
  } finally {
    await client.close();
    await mock.close();
  }
});

test('请求超时、AbortSignal 与 JSON-RPC 错误按各自 request id 返回', async () => {
  let mock;
  mock = await mockServer((message, socket) => {
    if (message.method === 'initialize') mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, result: {} }));
    else if (message.method === 'fail') mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'mock failure' } }));
    else if (message.method === 'echo') mock.send(socket, jsonFrame({ jsonrpc: '2.0', id: message.id, result: message.params }));
  });
  const client = new AppServerClient({ socketPath: mock.socketPath, timeoutMs: 1000 });
  try {
    await client.connect();
    await assert.rejects(client.request('fail'), error => error.name === 'RpcError' && error.code === -32000);
    const controller = new AbortController();
    const aborted = client.request('wait-for-abort', {}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, error => error.name === 'AbortError');
    await assert.rejects(client.request('wait-for-timeout', {}, { timeoutMs: 20 }), error => error.name === 'TimeoutError');
    assert.deepEqual(await client.request('echo', { ok: true }), { ok: true });
  } finally {
    await client.close();
    await mock.close();
  }
});

test('连接握手超时会拒绝 connect 并关闭 socket', async () => {
  const mock = await mockServer(() => {}, { handshake: false });
  const client = new AppServerClient({ socketPath: mock.socketPath, timeoutMs: 30 });
  try {
    await assert.rejects(client.connect(), /timed out/i);
  } finally {
    await client.close();
    await mock.close();
  }
});

test('服务端审批请求与客户端请求使用相同id时仍分别路由',async()=>{
  let mock,received=false;
  mock=await mockServer((message,socket)=>{
    if(message.method==='initialize')mock.send(socket,jsonFrame({id:message.id,result:{}}));
    else if(message.method==='trigger')mock.send(socket,jsonFrame({id:message.id,method:'item/commandExecution/requestApproval',params:{threadId:'a'}}));
    else if(message.result?.decision==='decline'){
      received=true;mock.send(socket,jsonFrame({id:message.id,result:{done:true}}));
    }
  });
  const client=new AppServerClient({socketPath:mock.socketPath,timeoutMs:1000});
  client.on('request',request=>client.respond(request.id,{decision:'decline'}));
  try{await client.connect();assert.deepEqual(await client.request('trigger',{}),{done:true});assert.equal(received,true);}
  finally{await client.close();await mock.close();}
});
