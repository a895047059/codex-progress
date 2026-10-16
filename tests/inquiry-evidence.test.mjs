import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProgressModel } from '../src/model.mjs';
import { collectInquiryEvidence } from '../src/inquiry-evidence.mjs';

const line = record => `${JSON.stringify(record)}\n`;
const event = (type, timestamp, payload = {}) => ({ type, timestamp, payload });

test('只读取 watcher 中与所选 thread 匹配的日志，并提取完成、计划和安全工具摘要', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inquiry-evidence-'));
  try {
    const selected = path.join(root, 'selected.jsonl'), other = path.join(root, 'other.jsonl');
    await writeFile(selected, [
      event('event_msg', '2026-10-15T01:00:00.000Z', { type: 'task_started' }),
      event('event_msg', '2026-10-15T01:00:01.000Z', { type: 'thread_goal_updated', goal: { status: 'active' } }),
      event('event_msg', '2026-10-15T01:00:02.000Z', { type: 'plan_update', plan: [{}, {}] }),
      event('response_item', '2026-10-15T01:00:03.000Z', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private reasoning must not leak' }] }),
      event('response_item', '2026-10-15T01:00:04.000Z', { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '完成检查，token 这个普通词应保留。' }] }),
      event('response_item', '2026-10-15T01:00:05.000Z', { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"cat /private/secret"}' }),
      event('response_item', '2026-10-15T01:00:06.000Z', { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 7\nError: permission denied token=private-output-secret\nsecret stdout must not be kept' }),
      event('event_msg', '2026-10-15T01:00:07.000Z', { type: 'task_complete' })
    ].map(JSON.stringify).join('\n') + '\n');
    await writeFile(other, line(event('event_msg', '2026-10-15T02:00:00.000Z', { type: 'turn_failed', message: 'other-thread-only-marker' })));
    const model = new ProgressModel();
    model.start('selected-thread', 'turn-1', Date.parse('2026-10-15T01:00:00.000Z'));
    model.plan('selected-thread', [{ id: 'step', title: 'Keep token as a normal word', detail: 'password=task-secret' }]);
    model.addInput('selected-thread', 'token is an ordinary word; token=input-secret; Bearer input-bearer-secret', Date.parse('2026-10-15T00:59:00Z'));
    model.ensure('other-thread');
    const watcher = { files: new Map([[selected, { id: 'selected-thread', skip: false, offset: 0 }], [other, { id: 'other-thread', skip: false, offset: 0 }]]) };

    const evidence = await collectInquiryEvidence({ model, watcher, threadId: 'selected-thread', now: Date.parse('2026-10-15T03:00:00Z') });
    const serialized = JSON.stringify(evidence);
    assert.equal(evidence.capturedAt, '2026-10-15T03:00:00.000Z');
    assert.equal(evidence.log.available, true);
    assert.equal(evidence.log.lastEventAt, '2026-10-15T01:00:07.000Z');
    assert.equal(evidence.log.lastProgressAt, '2026-10-15T01:00:07.000Z');
    assert.deepEqual(evidence.log.recentEvents.map(item => item.type), [
      'task_started', 'thread_goal_updated', 'plan_update', 'agent_message',
      'function_call', 'function_call_output', 'task_completed'
    ]);
    assert.match(evidence.log.recentEvents[2].summary, /2 项/);
    assert.match(evidence.log.recentEvents[4].summary, /exec_command/);
    assert.match(evidence.log.recentEvents[5].summary, /退出码 7/);
    assert.match(evidence.log.recentEvents[5].summary, /permission denied/);
    assert.match(evidence.log.recentEvents[3].summary, /token 这个普通词/);
    assert.equal(serialized.includes('private reasoning'), false);
    assert.equal(serialized.includes('secret stdout'), false);
    assert.equal(serialized.includes('/private/secret'), false);
    assert.equal(serialized.includes('other-thread-only-marker'), false);
    assert.equal(serialized.includes('input-secret'), false);
    assert.equal(serialized.includes('input-bearer-secret'), false);
    assert.equal(serialized.includes('task-secret'), false);
    assert.match(serialized, /token is an ordinary word/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('大文件仅读尾部，处理 UTF-8 边界并忽略未换行的半条记录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inquiry-evidence-tail-'));
  try {
    const file = path.join(root, 'large.jsonl');
    const latest = event('event_msg', '2026-10-15T04:00:00.000Z', { type: 'task_started', label: '中文末尾' });
    const partial = JSON.stringify(event('event_msg', '2026-10-15T04:00:01.000Z', { type: 'turn_failed', marker: 'half-line-must-not-appear' }));
    await writeFile(file, `${JSON.stringify({ type: 'irrelevant', text: '前缀'.repeat(700000) })}\n${line(latest)}${partial}`);
    const model = new ProgressModel(); model.start('large-thread', 'turn');
    const watcher = { files: new Map([[file, { id: 'large-thread', skip: false, offset: 0 }]]) };

    const evidence = await collectInquiryEvidence({ model, watcher, threadId: 'large-thread' });
    assert.equal(evidence.log.available, true);
    assert.equal(evidence.log.truncated, true);
    assert.ok(evidence.log.coverage.bytesRead <= 2 * 1024 * 1024);
    assert.ok(evidence.log.coverage.fileSize > evidence.log.coverage.bytesRead);
    assert.equal(evidence.log.coverage.partialLineOmitted, true);
    assert.deepEqual(evidence.log.recentEvents.map(item => item.type), ['task_started']);
    assert.equal(evidence.log.recentEvents[0].at, '2026-10-15T04:00:00.000Z');
    assert.equal(JSON.stringify(evidence).includes('half-line-must-not-appear'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('日志未观察或源文件消失时返回快照并明确说明不可用', async () => {
  const model = new ProgressModel(); model.start('snapshot-only', 'turn');
  const absent = await collectInquiryEvidence({ model, watcher: { files: new Map() }, threadId: 'snapshot-only' });
  assert.equal(absent.status, 'running');
  assert.equal(absent.log.available, false);
  assert.equal(absent.log.coverage.reason, 'no_observed_log');

  const missingPath = path.join(os.tmpdir(), `inquiry-missing-${process.pid}.jsonl`);
  const missing = await collectInquiryEvidence({
    model,
    watcher: { files: new Map([[missingPath, { id: 'snapshot-only', skip: false }]]) },
    threadId: 'snapshot-only'
  });
  assert.equal(missing.log.available, false);
  assert.equal(missing.log.coverage.reason, 'observed_log_missing');
});

test('不接受不存在的 thread，且跳过的子代理日志不能作为证据', async () => {
  const model = new ProgressModel(); model.start('parent', 'turn');
  const file = path.join(os.tmpdir(), `inquiry-skipped-${process.pid}.jsonl`);
  const watcher = { files: new Map([[file, { id: 'parent', skip: true }]]) };
  await assert.rejects(collectInquiryEvidence({ model, watcher, threadId: 'unknown' }), /找不到指定会话/);
  const evidence = await collectInquiryEvidence({ model, watcher, threadId: 'parent' });
  assert.equal(evidence.log.available, false);
  assert.equal(evidence.log.coverage.reason, 'no_observed_log');
});
