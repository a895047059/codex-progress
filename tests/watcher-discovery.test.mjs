import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProgressModel } from '../src/model.mjs';
import { RolloutWatcher } from '../src/watcher.mjs';

const oldTime = new Date('2018-01-02T03:04:05.000Z');
const line = record => `${JSON.stringify(record)}\n`;
const event = (type, timestamp, fields = {}) => ({
  timestamp,
  type: 'event_msg',
  payload: { type, ...fields }
});

async function writeOldLog(root, name, records) {
  const dir = path.join(root, '2018', '01', '02');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  await writeFile(file, records.map(line).join(''));
  await utimes(file, oldTime, oldTime);
  return file;
}

test('首次索引发现旧日期和旧 mtime 的所有主任务并跳过 subagent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-progress-old-watch-'));
  try {
    for (let i = 0; i < 12; i++) {
      const id = `old-task-${i}`;
      await writeOldLog(root, id, [
        { type: 'session_meta', payload: { id, source: 'exec' } },
        event('task_started', oldTime.toISOString(), { turn_id: `turn-${i}` }),
        event('task_complete', oldTime.toISOString())
      ]);
    }
    await writeOldLog(root, 'old-subagent', [
      { type: 'session_meta', payload: { id: 'old-subagent', source: { subagent: { parent_thread_id: 'old-task-0' } } } },
      event('task_started', oldTime.toISOString(), { turn_id: 'child-turn' }),
      event('task_complete', oldTime.toISOString())
    ]);

    const model = new ProgressModel();
    const watcher = new RolloutWatcher(model, root);
    await watcher.poll();

    const threads = model.snapshot().threads;
    assert.equal(threads.length, 12);
    assert.equal(threads.some(thread => thread.id === 'old-subagent'), false);
    assert.ok(threads.every(thread => thread.id.startsWith('old-task-') && thread.status === 'completed'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('已索引的旧日志追加新一轮记录后仍更新任务状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-progress-old-append-'));
  try {
    const id = 'reopened-old-task';
    const file = await writeOldLog(root, id, [
      { type: 'session_meta', payload: { id, source: 'exec' } },
      event('task_started', oldTime.toISOString(), { turn_id: 'turn-1' }),
      event('thread_goal_updated', oldTime.toISOString(), { goal: { objective: '旧目标', status: 'active' } }),
      event('task_complete', oldTime.toISOString())
    ]);
    const model = new ProgressModel();
    const watcher = new RolloutWatcher(model, root);
    await watcher.poll();
    assert.equal(model.ensure(id).status, 'completed');

    const nextTime = new Date(oldTime.getTime() + 60_000).toISOString();
    await appendFile(file, [
      event('task_started', nextTime, { turn_id: 'turn-2' }),
      event('thread_goal_updated', nextTime, { goal: { objective: '追加后的目标', status: 'active' } })
    ].map(line).join(''));
    await utimes(file, oldTime, oldTime);
    await watcher.poll();

    assert.equal(model.ensure(id).turnId, 'turn-2');
    assert.equal(model.ensure(id).goal, '追加后的目标');
    assert.equal(model.ensure(id).status, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('plan 历史分组使用 rollout 事件时间戳', () => {
  const model = new ProgressModel();
  const watcher = new RolloutWatcher(model, '/unused');
  const file = { id: null, skip: false };
  const first = '2026-10-15T01:02:03.000Z';
  const second = '2026-10-15T01:03:04.000Z';
  watcher.consume(file, { type: 'session_meta', payload: { id: 'thread-a', source: 'exec' } });
  watcher.consume(file, event('task_started', first, { turn_id: 'turn-1' }));
  watcher.consume(file, event('plan_update', first, { plan: [{ id: 'one', title: '第一阶段' }] }));
  watcher.consume(file, event('task_started', second, { turn_id: 'turn-2' }));
  watcher.consume(file, event('plan_update', second, { plan: [{ id: 'two', title: '第二阶段' }] }));

  assert.deepEqual(model.snapshot().threads[0].taskGroups.map(group => group.createdAt), [Date.parse(first), Date.parse(second)]);
});
