import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(await readFile(new URL('../web/token-trend.js', import.meta.url), 'utf8'), sandbox);
const { build, path } = sandbox.TokenTrend;
const point = (seconds, outputTokens, totalTokens = outputTokens) =>
  ({ at: seconds * 1000, outputTokens, totalTokens, rate: 999, estimated: false });

test('不规则日志以输出差值除以时间求平均，日志密集程度不改变速率', () => {
  const sparse = [point(0, 0), point(10, 100), point(60, 100)];
  const dense = [...sparse.slice(0, 2), ...Array.from({ length: 49 }, (_, i) => point(11 + i, 100)), sparse[2]];
  const a = build(sparse);
  const b = build(dense);
  assert.equal(a.points.at(-1).outputRate, 100 / 60);
  assert.equal(a.points.at(-1).totalRate, 100 / 60);
  const values = trend => trend.points.map(p => [p.at, p.totalTokens, p.totalRate, p.outputRate]);
  assert.equal(JSON.stringify(values(a)), JSON.stringify(values(b)));
});

test('长任务绘制点数有界、保留真实累计终值，等待使时间平均速率下降', () => {
  const source = Array.from({ length: 2000 }, (_, i) => point(i * 60, i * 40, i * 1000));
  const trend = build(source, { maxPoints: 60 });
  assert.ok(trend.points.length <= 60);
  assert.equal(trend.points[0].totalTokens, 0);
  assert.equal(trend.points.at(-1).totalTokens, 1_999_000);
  assert.ok(trend.points.slice(1).every(p => Math.abs(p.outputRate - 2 / 3) < 1e-10));
  assert.ok(trend.points.slice(1).every(p => Math.abs(p.totalRate - 1000 / 60) < 1e-10));
  assert.ok(trend.windowMs > 60_000);
  const waiting = build([point(0, 0), point(60, 600), { ...point(120, 600), estimated: true }]);
  assert.equal(waiting.points.at(-1).outputRate, 0);
  assert.equal(waiting.points.at(-1).totalRate, 0);
  assert.equal(waiting.points.at(-1).estimated, true);
});

test('未知输出不伪造零速率，单点与空数据仍可展示', () => {
  const unknown = build([point(0, null, 20), point(60, null, 30)]);
  assert.ok(unknown.points.every(p => p.outputRate === null));
  assert.equal(unknown.points.at(-1).totalRate, 10 / 60);
  assert.equal(build([]).points.length, 0);
  const single = build([point(20, 8, 50)]).points;
  assert.equal(single.length, 1);
  assert.equal(single[0].totalTokens, 50);
  assert.equal(single[0].totalRate, null);
  assert.equal(single[0].outputRate, null);
});

test('读取平均速率时分别使用 totalTokens 与 outputTokens，忽略原始点的瞬时 rate', () => {
  const trend = build([
    { at: 0, totalTokens: 0, outputTokens: 0, rate: 999, estimated: false },
    { at: 60_000, totalTokens: 600, outputTokens: 120, rate: 999, estimated: false }
  ]);
  assert.equal(trend.points.at(-1).totalRate, 10);
  assert.equal(trend.points.at(-1).outputRate, 2);
});

test('平滑曲线通过各采样点且不超出相邻点范围，缺失段不跨接', () => {
  const coords = [{ x: 0, y: 30 }, { x: 1, y: 29 }, { x: 10, y: 2 }, { x: 12, y: 2 }, { x: 15, y: 10 }];
  const curve = path(coords);
  assert.ok(curve.startsWith('M0.00,30.00C'));
  const pieces = [...curve.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)];
  assert.equal(pieces.length, coords.length - 1);
  pieces.forEach((match, index) => {
    const [, x1, y1, x2, y2, x, y] = match.map(Number);
    const start = coords[index];
    const end = coords[index + 1];
    assert.equal(x, end.x); assert.equal(y, end.y);
    for (let t = 0; t <= 1; t += .05) {
      const value = (1 - t) ** 3 * start.y + 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3 * end.y;
      assert.ok(value >= Math.min(start.y, end.y) - .01 && value <= Math.max(start.y, end.y) + .01);
    }
    assert.ok(x1 >= start.x && x2 <= end.x);
  });
  assert.equal((path([coords[0], null, coords[2]]).match(/M/g) || []).length, 2);
});
