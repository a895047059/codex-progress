import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { RecordService, handleRecording } from '../src/record-service.mjs';

const toolNames = ['event_stream_start', 'event_stream_status', 'event_stream_stop'];
const asResult = structuredContent => ({ structuredContent });
const noSessionResult = () => ({ content: [{ type: 'text', text: '{"isRecording":false,"maxDurationSeconds":1800}' }] });

class FakeClient {
  constructor(responses = {}) {
    this.responses = new Map(Object.entries(responses).map(([name, values]) => [name, [...values]]));
    this.calls = [];
    this.connects = 0;
    this.closed = false;
  }
  async connect() { this.connects += 1; return toolNames.map(name => ({ name })); }
  async call(name) {
    this.calls.push(name);
    const queue = this.responses.get(name) || [];
    const value = queue.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return value;
  }
  async close() { this.closed = true; }
}

async function harness(t, responses = {}, clock = Date.parse('2026-10-15T05:00:00.000Z')) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'record-service-'));
  const sessionDirectoryPath = path.join(root, 'session');
  await mkdir(sessionDirectoryPath);
  const metadataPath = path.join(sessionDirectoryPath, 'session.json');
  const eventsPath = path.join(sessionDirectoryPath, 'events.jsonl');
  const skillPath = path.join(root, 'SKILL.md');
  await Promise.all([writeFile(metadataPath, '{}'), writeFile(eventsPath, ''), writeFile(skillPath, '# skill')]);
  const client = new FakeClient(responses);
  const guards = [];
  const controller = { connected: true, async guard(id) { guards.push(id); if (!this.connected) throw Error('offline'); } };
  const service = new RecordService({ controller, client, skillPath, now: () => clock });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { service, client, controller, guards, root, sessionDirectoryPath, metadataPath, eventsPath, skillPath, clock };
}

function session(h, { id = 'session-a', isRecording = true, startedAt, endReason = null } = {}) {
  return {
    isRecording, sessionID: id, sessionDirectoryPath: h.sessionDirectoryPath,
    eventsPath: h.eventsPath, metadataPath: h.metadataPath,
    startedAt: startedAt ?? new Date(h.clock).toISOString(),
    endedAt: isRecording ? null : new Date(h.clock).toISOString(),
    endReason, maxDurationSeconds: 1800,
  };
}

async function waitForConfirmation(service, threadId) {
  for (let i = 0; i < 40; i += 1) {
    const pending = service.snapshot(threadId).state.confirmation;
    if (pending) return pending;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('confirmation did not arrive');
}

async function startApproved(h, threadId = 'thread-a', result = asResult(session(h))) {
  h.client.responses.set('event_stream_start', [async () => {
    const choice = await h.service.handleElicitation({ requestedSchema: { type: 'object', properties: {} } });
    if (choice.action !== 'accept') throw Error('not approved');
    return result;
  }]);
  const starting = h.service.start(threadId);
  const pending = await waitForConfirmation(h.service, threadId);
  await h.service.confirm(threadId, { id: pending.id, action: 'accept' });
  return starting;
}

async function request(service, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers };
  let response;
  const handled = await handleRecording(req, new URL(url, 'http://localhost'), (status, value) => { response = { status, value }; }, service);
  return { handled, ...response };
}

test('start binds a fresh session to one thread and snapshots never leak it to another', async t => {
  const h = await harness(t);
  const started = await startApproved(h);
  assert.equal(started.state.status, 'recording');
  assert.equal(started.state.owned, true);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
  const other = h.service.snapshot('thread-b');
  assert.equal(other.state.status, 'idle');
  assert.equal(other.state.occupied, true);
  assert.equal('draft' in other, false);
  assert.match(other.state.message, /另一个任务/);
  await assert.rejects(h.service.start('thread-b'), /另一个任务正在录制/);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
});

test('the actual no-session MCP response leaves start idle without recording a missing session ID', async t => {
  const h = await harness(t);
  const result = await startApproved(h, 'thread-a', noSessionResult());
  assert.equal(result.state.status, 'idle');
  assert.equal(result.state.owned, true);
  assert.equal(result.state.hasDraft, false);
  assert.equal('draft' in result, false);
  assert.equal(h.service.seenSessionIds.has(undefined), false);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
});

test('a previously active start result requires explicit adoption before stop', async t => {
  const h = await harness(t);
  const old = session(h, { startedAt: new Date(h.clock - 10_000).toISOString() });
  const result = await startApproved(h, 'thread-a', asResult(old));
  assert.equal(result.state.status, 'adoption');
  await assert.rejects(h.service.stop('thread-a'), /没有已绑定的录制/);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
  const adopted = await h.service.adopt('thread-a');
  assert.equal(adopted.state.status, 'recording');
  assert.deepEqual(h.client.calls, ['event_stream_start']);
  h.client.responses.set('event_stream_status', [asResult(old)]);
  h.client.responses.set('event_stream_stop', [asResult(session(h, { isRecording: false }))]);
  const stopped = await h.service.stop('thread-a');
  assert.equal(stopped.state.status, 'completed');
  assert.equal(stopped.draft.attachments.length, 3);
});

test('capability and snapshots do not poll status; stop remains available after controller disconnects', async t => {
  const h = await harness(t);
  assert.deepEqual(await h.service.capability(), { available: true });
  h.service.snapshot('thread-a');
  await startApproved(h);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
  h.controller.connected = false;
  h.client.responses.set('event_stream_status', [asResult(session(h))]);
  h.client.responses.set('event_stream_stop', [asResult(session(h, { isRecording: false }))]);
  const result = await h.service.stop('thread-a');
  assert.equal(result.state.status, 'completed');
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status', 'event_stream_stop']);
  assert.deepEqual(h.guards, ['thread-a']);
});

test('cancelled sessions never produce drafts or send a second stop', async t => {
  const h = await harness(t);
  await startApproved(h);
  h.client.responses.set('event_stream_status', [asResult(session(h))]);
  h.client.responses.set('event_stream_stop', [asResult(session(h, { isRecording: false, endReason: 'recording_controls_cancelled' }))]);
  const result = await h.service.stop('thread-a');
  assert.equal(result.state.status, 'cancelled');
  assert.equal('draft' in result, false);
  await h.service.stop('thread-a');
  assert.equal(h.client.calls.filter(name => name === 'event_stream_stop').length, 1);
});

test('preflight refresh recognizes system cancellation and a replaced session without calling stop', async t => {
  const h = await harness(t);
  await startApproved(h);
  h.client.responses.set('event_stream_status', [asResult(session(h, { isRecording: false, endReason: 'recording_controls_cancelled' }))]);
  const cancelled = await h.service.stop('thread-a');
  assert.equal(cancelled.state.status, 'cancelled');
  assert.equal('draft' in cancelled, false);
  await h.service.stop('thread-a');
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status']);

  const other = await harness(t);
  await startApproved(other);
  other.client.responses.set('event_stream_status', [asResult(session(other, { id: 'external-session' }))]);
  const changed = await other.service.stop('thread-a');
  assert.equal(changed.state.status, 'adoption');
  assert.equal(changed.state.owned, false);
  assert.deepEqual(other.client.calls, ['event_stream_start', 'event_stream_status']);
});

test('refresh after system stop returns a draft that remains available from state', async t => {
  const h = await harness(t);
  await startApproved(h);
  h.client.responses.set('event_stream_status', [asResult(session(h, { isRecording: false }))]);
  const refreshed = await h.service.refresh('thread-a');
  assert.equal(refreshed.state.status, 'completed');
  assert.equal(refreshed.draft.attachments.length, 3);
  assert.deepEqual(h.service.snapshot('thread-a').draft, refreshed.draft);
  const stop = await h.service.stop('thread-a');
  assert.deepEqual(stop.draft, refreshed.draft);
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status']);
});

test('unknown start output is retained for user refresh and never treated as success', async t => {
  const h = await harness(t);
  await assert.rejects(startApproved(h, 'thread-a', { structuredContent: { isRecording: true } }), /启动结果未能确认/);
  const result = h.service.snapshot('thread-a');
  assert.equal(result.state.status, 'error');
  assert.equal(result.state.owned, false);
  assert.deepEqual(h.client.calls, ['event_stream_start']);
  await assert.rejects(h.service.stop('thread-a'), /没有已绑定的录制/);
  h.client.responses.set('event_stream_status', [asResult(session(h))]);
  const refreshed = await h.service.refresh('thread-a');
  assert.equal(refreshed.state.status, 'adoption');
  assert.equal(refreshed.state.owned, false);
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status']);
});

test('refresh clears an unknown active result when status reports no session', async t => {
  const h = await harness(t);
  await assert.rejects(startApproved(h, 'thread-a', { structuredContent: { isRecording: true } }), /启动结果未能确认/);
  h.client.responses.set('event_stream_status', [noSessionResult()]);
  const refreshed = await h.service.refresh('thread-a');
  assert.equal(refreshed.state.status, 'idle');
  assert.equal(refreshed.state.hasDraft, false);
  assert.equal('draft' in refreshed, false);
  assert.equal(h.service.active, null);
  assert.equal(h.service.snapshot('thread-b').state.occupied, undefined);
  await h.service.stop('thread-a');
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status']);
});

test('stop does not call event_stream_stop when preflight status reports no session', async t => {
  const h = await harness(t);
  await startApproved(h);
  h.client.responses.set('event_stream_status', [noSessionResult()]);
  const result = await h.service.stop('thread-a');
  assert.equal(result.state.status, 'idle');
  assert.equal(result.state.hasDraft, false);
  assert.equal('draft' in result, false);
  assert.deepEqual(h.client.calls, ['event_stream_start', 'event_stream_status']);
});

test('elicitation requires a matching thread and one-time confirmation nonce', async t => {
  const h = await harness(t);
  h.client.responses.set('event_stream_start', [async () => {
    const choice = await h.service.handleElicitation({ message: 'ignored raw MCP text' });
    if (choice.action !== 'accept') throw Error('declined');
    return asResult(session(h));
  }]);
  const starting = h.service.start('thread-a');
  const pending = await waitForConfirmation(h.service, 'thread-a');
  assert.ok(pending?.id);
  assert.equal(pending.message, 'Record & Replay 请求开始录制，请确认后继续');
  assert.equal(h.service.snapshot('thread-b').state.confirmation, undefined);
  await assert.rejects(h.service.confirm('thread-b', { id: pending.id, action: 'accept' }), /确认请求已失效/);
  await assert.rejects(h.service.confirm('thread-a', { id: 'wrong', action: 'accept' }), /确认请求已失效/);
  await h.service.confirm('thread-a', { id: pending.id, action: 'accept' });
  const result = await starting;
  assert.equal(result.state.status, 'recording');
  await assert.rejects(h.service.confirm('thread-a', { id: pending.id, action: 'accept' }), /确认请求已失效/);
});

test('declining elicitation records cancellation even if start reports an error', async t => {
  const h = await harness(t);
  h.client.responses.set('event_stream_start', [async () => {
    const choice = await h.service.handleElicitation({});
    assert.equal(choice.action, 'decline');
    throw Error('tool rejected');
  }]);
  const starting = h.service.start('thread-a');
  const pending = await waitForConfirmation(h.service, 'thread-a');
  await h.service.confirm('thread-a', { id: pending.id, action: 'decline' });
  const result = await starting;
  assert.equal(result.state.status, 'cancelled');
  assert.equal('draft' in result, false);
});

test('HTTP handler rejects oversized bodies and sanitizes arbitrary client errors', async t => {
  const h = await harness(t, { event_stream_start: [new Error('SECRET /private/path stderr details')] });
  const oversized = await request(h.service, 'POST', '/api/recording/start', 'x'.repeat(8193), { 'content-type': 'application/json' });
  assert.equal(oversized.status, 413);
  const invalidType = await request(h.service, 'POST', '/api/recording/start', { threadId: 'thread-a' }, { 'content-type': 'text/plain' });
  assert.equal(invalidType.status, 415);
  const failed = await request(h.service, 'POST', '/api/recording/start', { threadId: 'thread-a' });
  assert.equal(failed.status, 409);
  assert.doesNotMatch(JSON.stringify(failed.value), /SECRET|private|stderr/);
});

