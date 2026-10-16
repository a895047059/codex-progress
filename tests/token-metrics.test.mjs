import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenMetrics } from '../src/token-metrics.mjs';

const start = Date.parse('2026-10-15T00:00:00.000Z');

function tokenRecord(seconds, totalUsage, lastUsage = undefined) {
  return {
    timestamp: new Date(start + seconds * 1000).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: totalUsage,
        ...(lastUsage ? { last_token_usage: lastUsage } : {})
      }
    }
  };
}

test('只处理 token_count；缺少可用字段时明确返回 unavailable 和 null', () => {
  const metrics = new TokenMetrics();
  assert.equal(metrics.consume('a', { type: 'event_msg', payload: { type: 'task_started' } }), false);
  assert.equal(metrics.consume('a', tokenRecord(0, { input_tokens: -1, output_tokens: '4' })), false);

  assert.deepEqual(metrics.snapshot('a'), {
    available: false,
    totalTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    updatedAt: null,
    points: [],
    rate: null,
    rateEstimated: false,
    rateKind: 'wall_output_tokens_per_second',
    coverage: { from: null, to: null, retainedPoints: 0, maxPoints: 720, sampled: false }
  });
});

test('按 total_token_usage 累计，忽略 last_token_usage，重复事件不再次增加', () => {
  const metrics = new TokenMetrics();
  const first = tokenRecord(0, {
    input_tokens: 100,
    cached_input_tokens: 60,
    output_tokens: 10,
    reasoning_output_tokens: 4,
    total_tokens: 110
  }, { input_tokens: 900, output_tokens: 900, total_tokens: 1800 });
  const second = tokenRecord(2, {
    input_tokens: 120,
    cached_input_tokens: 70,
    output_tokens: 16,
    reasoning_output_tokens: 5,
    total_tokens: 136
  }, { input_tokens: 2000, output_tokens: 2000, total_tokens: 4000 });

  assert.equal(metrics.consume('thread-a', first), true);
  assert.equal(metrics.consume('thread-a', first), false);
  assert.equal(metrics.consume('thread-a', second), true);
  const snapshot = metrics.snapshot('thread-a', start + 2000);

  assert.equal(snapshot.totalTokens, 136);
  assert.equal(snapshot.inputTokens, 120);
  assert.equal(snapshot.outputTokens, 16);
  assert.equal(snapshot.cachedInputTokens, 70);
  assert.equal(snapshot.reasoningOutputTokens, 5);
  assert.equal(snapshot.points.length, 2);
  assert.deepEqual(snapshot.points.map(point => point.outputTokens), [10, 16]);
  assert.equal(snapshot.points[0].rate, null);
  assert.equal(snapshot.points[1].rate, 3);
  assert.equal(snapshot.rate, 3);
});

test('线程计数彼此独立，subset 不叠加到 totalTokens', () => {
  const metrics = new TokenMetrics();
  metrics.consume('thread-a', tokenRecord(0, {
    input_tokens: 40, cached_input_tokens: 30, output_tokens: 10,
    reasoning_output_tokens: 3, total_tokens: 50
  }));
  metrics.consume('thread-b', tokenRecord(0, {
    input_tokens: 5, cached_input_tokens: 4, output_tokens: 2,
    reasoning_output_tokens: 1, total_tokens: 7
  }));

  assert.equal(metrics.snapshot('thread-a').totalTokens, 50);
  assert.equal(metrics.snapshot('thread-a').cachedInputTokens, 30);
  assert.equal(metrics.snapshot('thread-a').reasoningOutputTokens, 3);
  assert.equal(metrics.snapshot('thread-b').totalTokens, 7);
  assert.equal(metrics.snapshot('thread-b').outputTokens, 2);
});

test('计数器下降视为上下文计数重置，累计线程总消耗并按 reset 后增量算速率', () => {
  const metrics = new TokenMetrics();
  metrics.consume('thread-a', tokenRecord(0, {
    input_tokens: 200, cached_input_tokens: 150, output_tokens: 40,
    reasoning_output_tokens: 8, total_tokens: 240
  }));
  metrics.consume('thread-a', tokenRecord(5, {
    input_tokens: 10, cached_input_tokens: 8, output_tokens: 5,
    reasoning_output_tokens: 1, total_tokens: 15
  }));
  const snapshot = metrics.snapshot('thread-a', start + 5000);

  assert.equal(snapshot.totalTokens, 255);
  assert.equal(snapshot.inputTokens, 210);
  assert.equal(snapshot.outputTokens, 45);
  assert.equal(snapshot.cachedInputTokens, 158);
  assert.equal(snapshot.reasoningOutputTokens, 9);
  assert.deepEqual(snapshot.points.map(point => point.outputTokens), [40, 45]);
  assert.equal(snapshot.points[1].rate, 1);
});

test('running 快照把最近采样增量按延长后的墙钟区间估算，并追加临时尾点', () => {
  const metrics = new TokenMetrics();
  metrics.consume('thread-a', tokenRecord(0, { output_tokens: 20, total_tokens: 20 }));
  assert.equal(metrics.snapshot('thread-a', start).rate, null);

  metrics.consume('thread-a', tokenRecord(1, { output_tokens: 20, total_tokens: 20 }));
  assert.equal(metrics.snapshot('thread-a', start + 1000).rate, 0);

  metrics.consume('thread-a', tokenRecord(2, { output_tokens: 25, total_tokens: 25 }));
  const live = metrics.snapshot('thread-a', start + 3000, { running: true });
  assert.equal(live.rate, 2.5);
  assert.equal(live.rateEstimated, true);
  assert.deepEqual(live.points.at(-1), {
    at: start + 3000,
    totalTokens: 25,
    outputTokens: 25,
    rate: 2.5,
    estimated: true
  });

  const later = metrics.snapshot('thread-a', start + 10000, { running: true });
  assert.ok(Math.abs(later.rate - (5 / 9)) < 1e-10);
  assert.equal(later.points.at(-1).estimated, true);
  assert.equal(later.points.at(-1).outputTokens, 25);

  const ended = metrics.snapshot('thread-a', start + 10000);
  assert.equal(ended.rate, 5);
  assert.equal(ended.rateEstimated, false);
  assert.equal(ended.points.length, 3);
});

test('坏时间戳和倒退时间不生成速率；速率从后续可靠时间点重新建立', () => {
  const metrics = new TokenMetrics();
  metrics.consume('thread-a', tokenRecord(2, { output_tokens: 10, total_tokens: 10 }));
  const regressed = tokenRecord(1, { output_tokens: 15, total_tokens: 15 });
  metrics.consume('thread-a', regressed);
  assert.equal(metrics.snapshot('thread-a', start + 2000).points.length, 1);

  metrics.consume('thread-a', tokenRecord(3, { output_tokens: 18, total_tokens: 18 }));
  assert.equal(metrics.snapshot('thread-a', start + 3000).points.at(-1).rate, null);
  metrics.consume('thread-a', tokenRecord(5, { output_tokens: 22, total_tokens: 22 }));
  assert.equal(metrics.snapshot('thread-a', start + 5000).points.at(-1).rate, 2);

  metrics.consume('thread-a', {
    ...tokenRecord(6, { output_tokens: 24, total_tokens: 24 }),
    timestamp: 'not-a-time'
  });
  assert.equal(metrics.snapshot('thread-a', start + 6000).rate, null);
  metrics.consume('thread-a', {
    ...tokenRecord(7, { output_tokens: 25, total_tokens: 25 }),
    timestamp: '0'
  });
  assert.equal(metrics.snapshot('thread-a', start + 7000).rate, null);
});

test('未知输出累计在采样点、生命周期点和运行尾点保持 null', () => {
  const metrics = new TokenMetrics();
  metrics.consume('thread-a', tokenRecord(0, { total_tokens: 10 }));
  metrics.endTurn('thread-a', start + 1000);

  const live = metrics.snapshot('thread-a', start + 2000, { running: true });
  assert.deepEqual(live.points.map(point => point.outputTokens), [null, null, null]);
  assert.equal(live.points.at(-1).estimated, true);
});

test('采样上限保留开头、结尾和线程总量；线程状态数量也有上限', () => {
  const metrics = new TokenMetrics({ maxPoints: 5, maxThreads: 2 });
  for (let seconds = 0; seconds < 20; seconds++) {
    const output = seconds < 10 ? seconds : seconds + 90;
    metrics.consume('thread-a', tokenRecord(seconds, {
      output_tokens: output,
      total_tokens: output
    }));
  }
  const snapshot = metrics.snapshot('thread-a', start + 19000);
  assert.equal(snapshot.points.length, 5);
  assert.equal(snapshot.points[0].at, start);
  assert.equal(snapshot.points.at(-1).at, start + 19000);
  assert.equal(snapshot.totalTokens, 109);
  assert.ok(snapshot.points.some(point => point.rate === 91));
  assert.equal(snapshot.coverage.sampled, true);
  assert.equal(snapshot.coverage.maxPoints, 5);

  const live = metrics.snapshot('thread-a', start + 20000, { running: true });
  assert.equal(live.points.length, 5);
  assert.equal(live.points.at(-1).estimated, true);
  assert.equal(live.points.at(-1).outputTokens, 109);
  assert.equal(live.coverage.sampled, true);

  metrics.consume('thread-b', tokenRecord(0, { total_tokens: 1 }));
  metrics.consume('thread-c', tokenRecord(0, { total_tokens: 2 }));
  assert.equal(metrics.threads.size, 2);
  assert.equal(metrics.snapshot('thread-a').available, false);
});

test('长时序按真实时间覆盖后半区，并保留后期速率峰谷', () => {
  const maxPoints = 8;
  const metrics = new TokenMetrics({ maxPoints });
  let output = 0;
  const samples = [[0, output]];

  for (let seconds = 1; seconds <= 500; seconds++) {
    output += 1;
    samples.push([seconds, output]);
  }
  for (let seconds = 520; seconds <= 2520; seconds += 20) {
    output += seconds === 2200 ? 100 : seconds === 2220 ? 0 : 20;
    samples.push([seconds, output]);
  }

  for (const [seconds, total] of samples) {
    metrics.consume('long-thread', tokenRecord(seconds, {
      output_tokens: total,
      total_tokens: total
    }));
  }

  const snapshot = metrics.snapshot('long-thread');
  const midpoint = start + 1260 * 1000;
  const laterPoints = snapshot.points.filter(point => point.at > midpoint);
  assert.equal(snapshot.points.length, maxPoints);
  assert.equal(snapshot.points[0].at, start);
  assert.equal(snapshot.points.at(-1).at, start + 2520 * 1000);
  assert.equal(snapshot.totalTokens, output);
  assert.ok(laterPoints.length >= 4);
  assert.ok(laterPoints.some(point => point.rate === 5));
  assert.ok(laterPoints.some(point => point.rate === 0));
  assert.equal(snapshot.coverage.sampled, true);
});

test('默认保留所有会话的累计状态', () => {
  const metrics = new TokenMetrics();
  for (let index = 0; index < 1001; index++) {
    metrics.consume(`thread-${index}`, tokenRecord(0, { total_tokens: index + 1 }));
  }

  assert.equal(metrics.threads.size, 1001);
  assert.equal(metrics.snapshot('thread-0').totalTokens, 1);
});

test('新一轮速率排除两次人工输入之间的空闲时间，首轮也以开始时间为基准', () => {
  const metrics = new TokenMetrics();
  metrics.beginTurn('a', start);
  metrics.consume('a', tokenRecord(5, { output_tokens: 10, total_tokens: 110 }));
  assert.equal(metrics.snapshot('a', start + 5000).rate, 2);
  metrics.beginTurn('a', start + 3600000);
  metrics.consume('a', tokenRecord(3605, { output_tokens: 30, total_tokens: 230 }));
  const result = metrics.snapshot('a', start + 3605000);
  assert.equal(result.totalTokens, 230);
  assert.equal(result.rate, 4);
});

test('结束与新轮次开始之间保持累计持平，速率回到零，不跨空闲画增长', () => {
  const metrics = new TokenMetrics();
  metrics.beginTurn('a', start);
  metrics.consume('a', tokenRecord(5, { output_tokens: 10, total_tokens: 110 }));
  metrics.endTurn('a', start + 6000);
  metrics.beginTurn('a', start + 3600000);
  const points = metrics.snapshot('a', start + 3600000).points;
  assert.deepEqual(points.slice(-2).map(p => [p.totalTokens, p.outputTokens, p.rate]), [[110, 10, 0], [110, 10, 0]]);
  assert.equal(points.at(-1).at, start + 3600000);
});
