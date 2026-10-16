import { open, stat } from 'node:fs/promises';

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_LINES = 10000;
const MAX_EVENTS = 200;
const MAX_LINE_BYTES = 256 * 1024;
const SAFE_GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete']);
const SAFE_TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'blocked', 'failed']);

function redact(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/(\bBearer\s+)[^\s,;"'<>]+/gi, '$1[REDACTED]')
    .replace(/(\b(?:password|passwd|token|api[_ -]?key|secret)\b\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/(\b(?:password|passwd|token|api[_ -]?key|secret)\b\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]');
}

function safeText(value, limit = 500) {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/\u0000/g, '')
    .replace(/<environment_context\b[^>]*>[\s\S]*?<\/environment_context\s*>/gi, '')
    .replace(/<(?:system|developer|instructions)\b[^>]*>[\s\S]*?<\/(?:system|developer|instructions)\s*>/gi, '')
    .replace(/<(?:environment_context|system|developer|instructions)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/\r\n?/g, '\n');
  if (/^(?:#\s*(?:AGENTS(?:\.md)?\s+instructions|system\s+instructions)|\[(?:system|developer)\b|(?:system|developer)\s*(?:prompt|instructions)?\s*:)/i.test(text.trim())) return '';
  text = redact(text).trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function isoTime(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function inputSnapshot(model, threadId) {
  if (typeof model.inputs !== 'function') return [];
  const items = model.inputs(threadId);
  if (!Array.isArray(items)) return [];
  return items.slice(-8).map(item => ({
    at: isoTime(item.timestamp),
    text: safeText(item.text, 500)
  })).filter(item => item.text);
}

function taskSnapshot(thread) {
  if (!Array.isArray(thread.tasks)) return [];
  return thread.tasks.slice(0, 500).map(task => ({
    id: safeText(task.id, 120),
    title: safeText(task.title, 300),
    status: SAFE_TASK_STATUSES.has(task.status) ? task.status : 'pending',
    detail: safeText(task.detail, 300)
  }));
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part && ['output_text', 'text'].includes(part.type) && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

function toolName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) return '工具';
  return value;
}

function planSize(plan) {
  if (Array.isArray(plan)) return plan.length;
  if (plan && typeof plan === 'object') {
    if (Array.isArray(plan.steps)) return plan.steps.length;
    if (Array.isArray(plan.tasks)) return plan.tasks.length;
  }
  return null;
}

function errorText(value) {
  if (typeof value !== 'string') return '';
  const line = value.split(/\r?\n/).find(item => /\b(?:error|exception|failed|failure|denied|timed out)\b/i.test(item));
  if (!line) return '';
  const clean = safeText(line.replace(/^\s*(?:stderr:\s*)?/i, ''), 150);
  if (!clean || /<(?:environment_context|system|developer|instructions)\b/i.test(clean)) return '';
  return clean;
}

function outputSummary(payload) {
  const output = payload.output;
  const structured = output && typeof output === 'object' ? output : null;
  let exitCode = Number.isInteger(payload.exit_code) ? payload.exit_code
    : structured && Number.isInteger(structured.exit_code) ? structured.exit_code : null;
  let err = typeof payload.error === 'string' ? payload.error : '';
  if (structured) {
    if (!err && typeof structured.error === 'string') err = structured.error;
    if (!err && typeof structured.stderr === 'string') err = errorText(structured.stderr);
  }
  if (typeof output === 'string') {
    const codeMatch = /(?:process\s+)?(?:exited|exit(?:ed)?\s+with\s+code|exit code)\s*(?:with\s+code\s*)?[:= ]\s*(-?\d+)/i.exec(output);
    if (exitCode === null && codeMatch) exitCode = Number(codeMatch[1]);
    if (!err) err = errorText(output);
  }
  if (typeof err === 'string') err = errorText(err);
  const parts = [];
  if (exitCode !== null) parts.push(`退出码 ${exitCode}`);
  if (err) parts.push(`错误：${err}`);
  return parts.length ? `工具返回（${parts.join('；')}）` : '工具已返回';
}

function eventDetails(record, callNames) {
  const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record?.type === 'event_msg') {
    const kind = payload.type;
    if (kind === 'task_started') return { type: kind, summary: '任务轮次开始', progress: true };
    if (kind === 'task_complete' || kind === 'task_completed') return { type: 'task_completed', summary: '任务轮次完成', progress: true };
    if (['turn_aborted', 'task_aborted', 'task_interrupted'].includes(kind)) return { type: 'task_aborted', summary: '任务轮次中断', progress: true };
    if (kind === 'turn_failed' || kind === 'task_failed') return { type: 'task_failed', summary: '任务轮次失败', progress: true };
    if (kind === 'thread_goal_updated') {
      const status = SAFE_GOAL_STATUSES.has(payload.goal?.status) ? `（${payload.goal.status}）` : '';
      return { type: kind, summary: `目标状态更新${status}`, progress: true };
    }
    if (kind === 'plan_update') {
      const count = planSize(payload.plan);
      return { type: kind, summary: `计划更新${count === null ? '' : `（${count} 项）`}`, progress: true };
    }
    if (kind === 'agent_message') {
      const channel = payload.channel ?? record.channel;
      if (!['commentary', 'final'].includes(channel)) return null;
      const text = safeText(contentText(payload.message ?? payload.content), 220);
      return text ? { type: 'agent_message', summary: text, progress: false } : null;
    }
    return null;
  }
  if (record?.type !== 'response_item') return null;
  if (payload.type === 'message' && payload.role === 'assistant' && ['commentary', 'final'].includes(payload.channel)) {
    const text = safeText(contentText(payload.content), 220);
    return text ? { type: 'agent_message', summary: text, progress: false } : null;
  }
  if (payload.type === 'function_call') {
    const name = toolName(payload.name);
    if (typeof payload.call_id === 'string') callNames.set(payload.call_id, name);
    return { type: 'function_call', summary: `调用 ${name}`, progress: false };
  }
  if (payload.type === 'function_call_output') {
    const name = typeof payload.call_id === 'string' ? callNames.get(payload.call_id) : null;
    return { type: 'function_call_output', summary: `${name ? `${name}：` : ''}${outputSummary(payload)}`, progress: false };
  }
  return null;
}

function lineWindow(buffer, fileSize, startOffset) {
  let end = buffer.length;
  const trailingNewline = end > 0 && buffer[end - 1] === 0x0a;
  let partialLineOmitted = false;
  if (!trailingNewline) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    end = lastNewline + 1;
    partialLineOmitted = true;
  }

  let first = 0;
  if (startOffset > 0 && end > 0) {
    const newline = buffer.indexOf(0x0a);
    first = newline < 0 ? end : newline + 1;
  }

  let lineCount = 0;
  for (let cursor = end - 1; cursor >= first; cursor--) {
    if (buffer[cursor] === 0x0a) {
      lineCount++;
      if (lineCount >= MAX_SCAN_LINES) {
        const newline = buffer.lastIndexOf(0x0a, cursor - 1);
        first = newline < 0 ? first : newline + 1;
        break;
      }
    }
  }
  return {
    first,
    end,
    partialLineOmitted,
    scanCapped: first > (startOffset > 0 ? (buffer.indexOf(0x0a) + 1) : 0),
    scanStartByte: startOffset + first,
    fileSize
  };
}

async function selectSource(watcher, threadId) {
  if (!(watcher?.files instanceof Map)) return { reason: 'no_observed_log' };
  let selected = null;
  let missing = false;
  for (const [file, state] of watcher.files) {
    if (state?.id !== threadId || state.skip) continue;
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (!selected || info.mtimeMs > selected.info.mtimeMs) selected = { file, state, info };
    } catch (error) {
      if (error?.code === 'ENOENT') missing = true;
      else missing = true;
    }
  }
  return selected || { reason: missing ? 'observed_log_missing' : 'no_observed_log' };
}

function unavailableLog(reason) {
  return {
    available: false,
    coverage: { mode: 'unavailable', reason },
    lastEventAt: null,
    lastProgressAt: null,
    truncated: false,
    recentEvents: []
  };
}

async function collectLog(watcher, threadId) {
  const source = await selectSource(watcher, threadId);
  if (!source.file) return unavailableLog(source.reason);
  const current = watcher.files.get(source.file);
  if (current !== source.state || current?.id !== threadId || current.skip) return unavailableLog('observed_log_changed');

  let handle;
  try {
    handle = await open(source.file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return unavailableLog('observed_log_unreadable');
    const fileSize = info.size;
    const readSize = Math.min(fileSize, MAX_TAIL_BYTES);
    const startOffset = fileSize - readSize;
    const buffer = Buffer.alloc(readSize);
    if (readSize) {
      const { bytesRead } = await handle.read(buffer, 0, readSize, startOffset);
      if (bytesRead !== readSize) return unavailableLog('observed_log_changed');
    }
    const window = lineWindow(buffer, fileSize, startOffset);
    const recentEvents = [];
    const callNames = new Map();
    let lastEvent = null, lastProgress = null;
    let cursor = window.first;
    while (cursor < window.end) {
      const newline = buffer.indexOf(0x0a, cursor);
      if (newline < 0 || newline >= window.end) break;
      const length = newline - cursor;
      if (length > 0 && length <= MAX_LINE_BYTES) {
        try {
          const record = JSON.parse(buffer.toString('utf8', cursor, newline));
          const details = eventDetails(record, callNames);
          const at = isoTime(record?.timestamp);
          if (details && at) {
            const time = Date.parse(at);
            if (lastEvent === null || time > Date.parse(lastEvent)) lastEvent = at;
            if (details.progress && (lastProgress === null || time > Date.parse(lastProgress))) lastProgress = at;
            recentEvents.push({ at, type: details.type, summary: details.summary });
            if (recentEvents.length > MAX_EVENTS) recentEvents.shift();
          }
        } catch { /* Ignore malformed or incomplete records. */ }
      }
      cursor = newline + 1;
    }
    const watcherOffset = Number.isSafeInteger(current.offset) ? current.offset : null;
    const rotationDetected = watcherOffset !== null && watcherOffset > fileSize;
    const scanCapped = window.scanCapped;
    const truncated = startOffset > 0 || scanCapped || window.partialLineOmitted || rotationDetected;
    return {
      available: true,
      coverage: {
        mode: 'recent_tail',
        bytesRead: readSize,
        fileSize,
        startsAtByte: window.scanStartByte,
        complete: !truncated,
        maxBytes: MAX_TAIL_BYTES,
        maxScannedLines: MAX_SCAN_LINES,
        scannedLineLimitReached: scanCapped,
        partialLineOmitted: window.partialLineOmitted,
        rotationDetected,
        watcherOffset,
        watcherAheadBytes: watcherOffset === null ? null : Math.max(0, watcherOffset - fileSize),
        message: truncated ? '仅提供最近日志记录，覆盖范围有限。' : '已覆盖当前文件内容。'
      },
      lastEventAt: lastEvent,
      lastProgressAt: lastProgress,
      truncated,
      recentEvents
    };
  } catch {
    return unavailableLog('observed_log_unreadable');
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function collectInquiryEvidence({ model, watcher, threadId, now = Date.now() } = {}) {
  if (typeof threadId !== 'string' || threadId.length > 120 || !model?.threads?.has(threadId)) {
    throw new Error('找不到指定会话');
  }
  const thread = model.threads.get(threadId);
  return {
    threadId,
    capturedAt: isoTime(now),
    goal: safeText(thread.goal, 700),
    desc: safeText(thread.desc, 700),
    status: safeText(thread.status, 40) || 'unknown',
    goalStatus: SAFE_GOAL_STATUSES.has(thread.goalStatus) ? thread.goalStatus : null,
    tasks: taskSnapshot(thread),
    recentInputs: inputSnapshot(model, threadId),
    log: await collectLog(watcher, threadId)
  };
}
