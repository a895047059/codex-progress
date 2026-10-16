import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApprovalStore } from '../src/approval-store.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.responses = [];
    this.responseErrors = [];
    this.rpcErrors = [];
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.responseErrors.push({ id, code, message });
  }

  _sendRpcError(id, code, message) {
    this.rpcErrors.push({ id, code, message });
  }
}

function request(client, id, method, params) {
  client.emit('request', { id, method, params });
}

test('按 thread 隔离请求，并以不暴露 rpcId 的稳定 ID 去重重放', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  const params = { threadId: 'thread-a', reason: '需要执行命令', command: 'npm test' };

  request(client, 'rpc-approval-1', 'item/commandExecution/requestApproval', params);
  const [first] = store.list('thread-a');
  assert.ok(first);
  assert.notEqual(first.id, 'rpc-approval-1');
  assert.deepEqual(store.list('thread-b'), []);

  request(client, 'rpc-approval-1', 'item/commandExecution/requestApproval', params);
  const replayed = store.list('thread-a');
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].id, first.id);
  assert.equal(store.revision('thread-a'), 1);
  assert.equal(client.responses.length, 0);
});

test('同 thread 同数量替换请求时修订号变化且 UI ID 使用新请求 ID', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-old', 'item/commandExecution/requestApproval', { threadId: 'thread-a', command: 'old' });
  const [oldApproval] = store.list('thread-a');
  const revision = store.revision('thread-a');

  client.emit('notification', { method: 'serverRequest/resolved', params: { requestId: 'rpc-old' } });
  request(client, 'rpc-new', 'item/commandExecution/requestApproval', { threadId: 'thread-a', command: 'new' });
  const [newApproval] = store.list('thread-a');

  assert.equal(store.list('thread-a').length, 1);
  assert.notEqual(newApproval.id, oldApproval.id);
  assert.ok(store.revision('thread-a') > revision);
});

test('相同 requestId 内容变化会刷新列表但保留 UI ID；相同内容重放不刷新', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  const original = { threadId: 'thread-a', reason: '原内容', command: 'echo old' };
  request(client, 'rpc-replay', 'item/commandExecution/requestApproval', original);
  const [first] = store.list('thread-a');
  const revision = store.revision('thread-a');

  const updated = { ...original, reason: '新内容', command: 'echo new' };
  request(client, 'rpc-replay', 'item/commandExecution/requestApproval', updated);
  const [replayed] = store.list('thread-a');
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.reason, '新内容');
  assert.equal(replayed.command, 'echo new');
  assert.equal(store.revision('thread-a'), revision + 1);

  request(client, 'rpc-replay', 'item/commandExecution/requestApproval', updated);
  assert.equal(store.revision('thread-a'), revision + 1);
});

test('审批修订号按 thread 隔离', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-a', 'item/commandExecution/requestApproval', { threadId: 'thread-a', reason: 'a' });
  request(client, 'rpc-b', 'item/commandExecution/requestApproval', { threadId: 'thread-b', reason: 'b' });
  const revisionB = store.revision('thread-b');

  request(client, 'rpc-a', 'item/commandExecution/requestApproval', { threadId: 'thread-a', reason: 'changed' });

  assert.equal(store.revision('thread-a'), 2);
  assert.equal(store.revision('thread-b'), revisionB);
});

test('拒绝跨 thread 和未提供的决策；resolved 后不能再响应', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-approval-2', 'item/commandExecution/requestApproval', {
    threadId: 'thread-a',
    availableDecisions: ['accept', 'decline'],
  });
  const [approval] = store.list('thread-a');

  assert.throws(() => store.answer('thread-b', approval.id, { decision: 'accept' }), /已处理或已失效/);
  assert.throws(() => store.answer('thread-a', approval.id, { decision: 'acceptForSession' }), /不可用/);
  assert.throws(() => store.answer('thread-a', approval.id, { decision: 'allow' }), /不可用/);
  assert.equal(client.responses.length, 0);
  const revision = store.revision('thread-a');

  client.emit('notification', {
    method: 'serverRequest/resolved',
    params: { requestId: 'rpc-approval-2' },
  });
  assert.deepEqual(store.list('thread-a'), []);
  assert.equal(store.revision('thread-a'), revision + 1);
  assert.throws(() => store.answer('thread-a', approval.id, { decision: 'accept' }), /已处理或已失效/);
  assert.equal(client.responses.length, 0);
  assert.equal(store.revision('thread-a'), revision + 1);
});

test('问题回答必须覆盖每个问题且内容非空，然后按原问题 ID 返回答案', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-question-1', 'item/tool/requestUserInput', {
    threadId: 'thread-a',
    questions: [{ id: 'q1', question: '目标目录？' }, { id: 'q2', question: '运行方式？' }],
  });
  const [question] = store.list('thread-a');

  assert.throws(() => store.answer('thread-a', question.id, { answers: {} }), /回答/);
  assert.throws(() => store.answer('thread-a', question.id, { answers: { q1: { answers: [' /tmp/project '] } } }), /回答所有问题/);
  assert.throws(() => store.answer('thread-a', question.id, {
    answers: { q1: { answers: ['   '] }, q2: { answers: ['shell'] } },
  }), /回答所有问题/);
  assert.throws(() => store.answer('thread-a', question.id, {
    answers: { q1: { answers: ['x'.repeat(10001)] }, q2: { answers: ['shell'] } },
  }), /回答所有问题/);
  assert.equal(client.responses.length, 0);

  store.answer('thread-a', question.id, {
    answers: { q1: { answers: ['/tmp/project'] }, q2: { answers: ['shell'] } },
  });
  assert.deepEqual(client.responses, [{
    id: 'rpc-question-1',
    result: { answers: { q1: { answers: ['/tmp/project'] }, q2: { answers: ['shell'] } } },
  }]);
});

test('权限只返回原请求的 permissions，并限定为当前 turn', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  const originalPermissions = {
    fileSystem: { read: ['/workspace/project'], write: [] },
    network: { enabled: false },
  };
  request(client, 'rpc-permission-1', 'item/permissions/requestApproval', {
    threadId: 'thread-a',
    permissions: originalPermissions,
  });
  const [approval] = store.list('thread-a');
  const revision = store.revision('thread-a');

  store.answer('thread-a', approval.id, {
    decision: 'accept',
    permissions: { fileSystem: { write: ['/'] }, network: { enabled: true } },
    scope: 'session',
  });
  assert.equal(client.responses.length, 1);
  assert.equal(client.responses[0].id, 'rpc-permission-1');
  assert.deepEqual(client.responses[0].result, { permissions: originalPermissions, scope: 'turn' });
  assert.equal(client.responses[0].result.permissions, originalPermissions);
  assert.equal(store.revision('thread-a'), revision + 1);
});

test('未支持的请求返回错误，不自动批准也不展示', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-unsupported-1', 'item/unknown/requestApproval', { threadId: 'thread-a' });

  assert.deepEqual(client.responses, []);
  assert.deepEqual(client.responseErrors, [{
    id: 'rpc-unsupported-1',
    code: -32601,
    message: 'This client cannot present this request',
  }]);
  assert.deepEqual(client.rpcErrors, []);
  assert.deepEqual(store.list('thread-a'), []);
});

test('断连时清除所有 thread 的待处理请求', () => {
  const client = new FakeClient();
  const store = new ApprovalStore(client);
  request(client, 'rpc-a', 'item/commandExecution/requestApproval', { threadId: 'thread-a' });
  request(client, 'rpc-b', 'item/fileChange/requestApproval', { threadId: 'thread-b' });

  assert.equal(store.list('thread-a').length, 1);
  assert.equal(store.list('thread-b').length, 1);
  const revisionA = store.revision('thread-a');
  const revisionB = store.revision('thread-b');
  client.emit('disconnect');
  assert.deepEqual(store.list('thread-a'), []);
  assert.deepEqual(store.list('thread-b'), []);
  assert.equal(store.revision('thread-a'), revisionA + 1);
  assert.equal(store.revision('thread-b'), revisionB + 1);
});
