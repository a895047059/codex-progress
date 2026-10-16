import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProgressModel } from '../src/model.mjs';
import { RolloutWatcher } from '../src/watcher.mjs';

const tokenRecord = (timestamp, totalTokens) => ({
  timestamp,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { output_tokens: totalTokens, total_tokens: totalTokens } }
  }
});

test('watcher 在确认普通会话后消费指标、去重并递增 revision', () => {
  const model = new ProgressModel();
  const watcher = new RolloutWatcher(model);
  const file = { id: null, skip: false };
  const timestamp = '2026-10-15T00:00:00.000Z';
  const record = tokenRecord(timestamp, 8);

  watcher.consume(file, { type: 'session_meta', payload: { id: 'thread-a', source: 'exec' } });
  watcher.consume(file, record);
  assert.equal(watcher.metrics.snapshot('thread-a').totalTokens, 8);
  assert.equal(model.revision, 1);

  watcher.consume(file, record);
  assert.equal(model.revision, 1);

  const child = { id: null, skip: false };
  watcher.consume(child, {
    type: 'session_meta',
    payload: { id: 'child', source: { subagent: { parent_thread_id: 'thread-a' } } }
  });
  watcher.consume(child, tokenRecord(timestamp, 99));
  assert.equal(watcher.metrics.snapshot('child').available, false);
  assert.equal(model.revision, 1);
});

test('日志截断后清除旧累计再重放', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-progress-token-watch-'));
  try {
    const date = new Date();
    const dir = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'rollout-token.jsonl');
    const meta = { type: 'session_meta', payload: { id: 'thread-a', source: 'exec' } };
    const line = value => `${JSON.stringify(value)}\n`;
    const timestamp = '2026-10-15T00:00:00.000Z';
    await writeFile(file, line(meta) + line(tokenRecord(timestamp, 1000000000)) + line(tokenRecord('2026-10-15T00:00:01.000Z', 2000000000)));

    const model = new ProgressModel();
    const watcher = new RolloutWatcher(model, root);
    await watcher.poll();
    assert.equal(watcher.metrics.snapshot('thread-a').totalTokens, 2000000000);
    assert.equal(watcher.metrics.snapshot('thread-a').outputTokens, 2000000000);

    await appendFile(file, line(tokenRecord('2026-10-15T00:00:02.000Z', 3000000000)));
    await watcher.poll();
    assert.equal(watcher.metrics.snapshot('thread-a').totalTokens, 3000000000);
    assert.equal(watcher.metrics.snapshot('thread-a').outputTokens, 3000000000);

    await writeFile(file, line(meta) + line(tokenRecord(timestamp, 1)));
    await watcher.poll();
    assert.equal(watcher.metrics.snapshot('thread-a').totalTokens, 1);
    assert.equal(watcher.metrics.snapshot('thread-a').outputTokens, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
