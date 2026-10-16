(() => {
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

  function valueAt(source, at, key) {
    let low = 0;
    let high = source.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (source[mid].at < at) low = mid + 1;
      else high = mid;
    }
    const end = source[low];
    if (end.at === at || low === 0) return valid(end[key]) ? end[key] : null;
    const start = source[low - 1];
    if (!valid(start[key]) || !valid(end[key]) || end[key] < start[key]) return null;
    return start[key] + (end[key] - start[key]) * (at - start.at) / (end.at - start.at);
  }

  // Average cumulative output over elapsed time, rather than averaging the
  // retained extrema: irregular logging and compressed samples must not add weight.
  function build(source, { maxPoints = 64, minWindowMs = 60_000 } = {}) {
    if (!source.length) return { points: [], windowMs: minWindowMs };
    const first = source[0].at;
    const last = source.at(-1).at;
    const count = Math.max(2, Math.min(96, Math.floor(maxPoints)));
    const step = Math.max(1000, Math.ceil((last - first) / (count - 1) / 1000) * 1000);
    const windowMs = Math.max(minWindowMs, step * 2);
    const times = [first];
    for (let at = first + step; at < last; at += step) times.push(at);
    if (last > first) times.push(last);
    const estimatedFrom = source.find(point => point.estimated)?.at ?? Infinity;
    const points = times.map(at => {
      const from = Math.max(first, at - windowMs);
      const total = valueAt(source, at, 'totalTokens');
      const previousTotal = valueAt(source, from, 'totalTokens');
      const output = valueAt(source, at, 'outputTokens');
      const previous = valueAt(source, from, 'outputTokens');
      const totalRate = at > from && total !== null && previousTotal !== null && total >= previousTotal
        ? (total - previousTotal) / ((at - from) / 1000)
        : null;
      const outputRate = at > from && output !== null && previous !== null && output >= previous
        ? (output - previous) / ((at - from) / 1000)
        : null;
      return { at, totalTokens: total, totalRate, outputRate,
        interpolated: !source.some(point => point.at === at), estimated: at >= estimatedFrom };
    });
    return { points, windowMs };
  }

  // Shape-preserving cubic interpolation: smooth joins without inventing peaks,
  // negative rates, or decreases in the cumulative Token curve.
  function segmentPath(coords) {
    if (!coords.length) return '';
    let path = `M${coords[0].x.toFixed(2)},${coords[0].y.toFixed(2)}`;
    if (coords.length === 1) return path;
    const slopes = coords.slice(1).map((point, index) =>
      (point.y - coords[index].y) / (point.x - coords[index].x));
    const tangents = coords.map((_, index) => index === 0 ? slopes[0]
      : index === coords.length - 1 ? slopes.at(-1)
        : slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2);
    for (let index = 0; index < slopes.length; index++) {
      const slope = slopes[index];
      if (slope === 0) { tangents[index] = 0; tangents[index + 1] = 0; continue; }
      const scale = Math.hypot(tangents[index] / slope, tangents[index + 1] / slope);
      if (scale > 3) {
        tangents[index] *= 3 / scale;
        tangents[index + 1] *= 3 / scale;
      }
    }
    coords.slice(1).forEach((point, index) => {
      const start = coords[index];
      const third = (point.x - start.x) / 3;
      path += `C${(start.x + third).toFixed(2)},${(start.y + tangents[index] * third).toFixed(2)} `
        + `${(point.x - third).toFixed(2)},${(point.y - tangents[index + 1] * third).toFixed(2)} `
        + `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    });
    return path;
  }

  function path(coords) {
    let result = '';
    let segment = [];
    for (const point of coords) {
      if (point === null) { result += segmentPath(segment); segment = []; }
      else segment.push(point);
    }
    return result + segmentPath(segment);
  }

  globalThis.TokenTrend = { build, path };
})();
