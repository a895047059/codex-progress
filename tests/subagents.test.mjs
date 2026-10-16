import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SubagentService } from '../src/subagents.mjs';

test('子代理按父任务隔离并包含后代，详情仅展示可见输出', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'progress-agents-'));
  const files = new Map();
  async function child(id, parent) {
    const file = path.join(root, id + '.jsonl'); files.set(file, { skip: true });
    await writeFile(file, [
      { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: '/root/' + id } } } } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE_REASONING' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: '完成校验 api_key=example-secret' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: '正在检查权限映射' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '权限检查已完成' }] } },
      { type: 'event_msg', payload: { type: 'task_complete' } }
    ].map(JSON.stringify).join('\n') + '\n');
  }
  try {
    await child('one', 'parent'); await child('two', 'one'); await child('other', 'foreign');
    const service = new SubagentService({ files });
    assert.deepEqual((await service.list('parent')).map(a => a.id), ['one', 'two']);
    const detailReads = [], originalRead = service.read.bind(service);
    service.read = async (meta, detail = false) => { detailReads.push(meta.id); return originalRead(meta, detail); };
    const detail = await service.detail('parent', 'one');
    assert.equal(detail.status, 'completed'); assert.equal(detail.title, 'one');
    assert.deepEqual(detailReads, ['one']);
    assert.deepEqual(detail.outputs.map(output => output.kind), ['final', 'commentary', 'final']);
    assert.match(detail.outputs[0].text, /REDACTED/);
    assert.match(detail.outputs[2].text, /权限检查已完成/);
    assert.equal(JSON.stringify(detail).includes('PRIVATE_REASONING'), false);
    assert.equal(await service.detail('parent', 'other'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
