import { open } from 'node:fs/promises';

const safe = (value, max = 12000) => typeof value === 'string' ? value
  .replace(/\u0000/g, '').replace(/\bsk-[\w-]{8,}\b/gi, '[REDACTED]')
  .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
  .replace(/((?:password|api[_-]?key|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]').slice(0, max) : '';

async function readPart(file, tail = false) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size, start = tail ? Math.max(0, size - 512 * 1024) : 0;
    const buffer = Buffer.alloc(Math.min(size, tail ? 512 * 1024 : 64 * 1024));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } finally { await handle.close(); }
}

export class SubagentService {
  constructor(watcher) { this.watcher = watcher; this.headers = new Map(); }
  async index() {
    const files = [...this.watcher.files.entries()]
      .filter(([, state]) => state?.skip === true)
      .map(([file]) => file);
    for (let i = 0; i < files.length; i += 16) {
      await Promise.all(files.slice(i, i + 16).map(async file => {
        if (this.headers.has(file)) return;
        try {
          const records = await readPart(file), meta = records.find(r => r.type === 'session_meta')?.payload;
          if (!meta) return;
          const spawn = meta.source?.subagent?.thread_spawn || meta.source?.subagent;
          const parent = meta.parent_thread_id || spawn?.parent_thread_id;
          this.headers.set(file, parent && meta.id ? { id: meta.id, parent, file,
            title: safe(meta.agent_path || spawn?.agent_path || meta.agent_nickname || '子代理', 180).replace(/^\/root\//, ''),
            startedAt: Date.parse(meta.timestamp) || Date.parse(records[0]?.timestamp) || null } : null);
        } catch { /* A growing or removed log can be retried later. */ }
      }));
    }
    return [...this.headers.values()].filter(Boolean);
  }
  async read(meta, detail = false) {
    const records = await readPart(meta.file, true), outputs = [];
    let status = 'unknown', updatedAt = meta.startedAt;
    for (const r of records) {
      const p = r.payload || {}, at = Date.parse(r.timestamp) || null;
      if (at) updatedAt = Math.max(updatedAt || 0, at);
      if (r.type === 'event_msg') {
        if (p.type === 'task_started') status = 'running';
        if (['task_complete', 'task_completed'].includes(p.type)) status = 'completed';
        if (['turn_aborted', 'task_interrupted'].includes(p.type)) status = 'interrupted';
        if (p.type === 'turn_failed') status = 'failed';
      }
      if (!detail) continue;
      const channel = p.channel || p.phase;
      const kind = ['final', 'final_answer'].includes(channel) ? 'final' : channel === 'commentary' ? 'commentary' : null;
      if (r.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && kind) {
        const text = safe(Array.isArray(p.content) ? p.content.filter(c => ['output_text', 'text'].includes(c.type)).map(c => c.text || '').join('\n') : p.content);
        if (text) outputs.push({ at, text, kind });
      }
      if (r.type === 'response_item' && p.type === 'function_call') outputs.push({ at, text: safe(p.name, 100), kind: 'tool' });
    }
    return { id: meta.id, title: meta.title, status, startedAt: meta.startedAt, updatedAt,
      ...(detail ? { outputs: outputs.slice(-80), limited: true } : {}) };
  }
  async list(threadId) {
    const all = await this.index(), descendants = new Set([threadId]);
    let changed = true;
    while (changed) { changed = false; for (const m of all) if (descendants.has(m.parent) && !descendants.has(m.id)) { descendants.add(m.id); changed = true; } }
    return (await Promise.all(all.filter(m => m.id !== threadId && descendants.has(m.id)).map(m => this.read(m).catch(() => null))))
      .filter(Boolean).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id));
  }
  async detail(threadId, agentId) {
    const agents = await this.index(), byId = new Map(agents.filter(Boolean).map(meta => [meta.id, meta]));
    const meta = byId.get(agentId);
    if (!meta || agentId === threadId) return null;
    const seen = new Set();
    let current = meta;
    while (current && !seen.has(current.id)) {
      if (current.parent === threadId) return this.read(meta, true);
      seen.add(current.id);
      current = byId.get(current.parent);
    }
    return null;
  }
}
