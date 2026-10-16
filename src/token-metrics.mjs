const COUNTERS = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens'
];

const RATE_KIND = 'wall_output_tokens_per_second';
const DEDUPE_LIMIT = 64;

function readCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readTimestamp(value) {
  const match = typeof value === 'string'
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
    : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function readUsage(record) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  const usage = record.payload.info?.total_token_usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;

  const values = {};
  for (const field of COUNTERS) {
    const value = readCount(usage[field]);
    if (value !== null) values[field] = value;
  }
  return Object.keys(values).length ? values : null;
}

function fingerprint(timestamp, usage) {
  return JSON.stringify([timestamp ?? null, COUNTERS.map(field => usage[field] ?? null)]);
}

function createState() {
  return {
    raw: Object.fromEntries(COUNTERS.map(field => [field, null])),
    totals: Object.fromEntries(COUNTERS.map(field => [field, null])),
    points: [],
    recentEvents: new Set(),
    recentOrder: [],
    lastFingerprint: null,
    lastEventAt: null,
    rateAnchor: null,
    rateWindow: null,
    currentRate: null,
    updatedAt: null,
    sampled: false,
    lastUsed: 0
  };
}

export class TokenMetrics {
  constructor({ maxPoints = 720, maxThreads = Infinity } = {}) {
    this.maxPoints = Number.isSafeInteger(maxPoints) && maxPoints >= 2 ? maxPoints : 720;
    this.maxThreads = maxThreads === Infinity || (Number.isSafeInteger(maxThreads) && maxThreads >= 1)
      ? maxThreads
      : Infinity;
    this.threads = new Map();
    this.turnStarts = new Map();
    this.sequence = 0;
  }

  reset(threadId) {
    this.turnStarts.delete(threadId);
    return this.threads.delete(threadId);
  }

  beginTurn(threadId, at) {
    if (!Number.isFinite(at)) return;
    this.turnStarts.set(threadId, at);
    const state = this.threads.get(threadId);
    if (state) {
      this.lifecyclePoint(state, at);
      state.rateAnchor = { at };
      state.rateWindow = null;
      state.currentRate = null;
    }
  }

  endTurn(threadId, at) {
    const state = this.threads.get(threadId);
    if (state) this.lifecyclePoint(state, at);
  }

  lifecyclePoint(state, at) {
    if (!Number.isFinite(at) || !state.points.length || at <= state.points.at(-1).at) return;
    state.points.push({ at, totalTokens: state.totals.total_tokens, outputTokens: state.totals.output_tokens, rate: 0, estimated: false });
    this.compressPoints(state);
  }

  consume(threadId, record) {
    if (typeof threadId !== 'string' || !threadId) return false;
    const usage = readUsage(record);
    if (!usage) return false;

    const at = readTimestamp(record.timestamp);
    const key = fingerprint(record.timestamp, usage);
    let state = this.threads.get(threadId);
    if (state && (key === state.lastFingerprint || (at !== null && state.recentEvents.has(key)))) return false;
    if (!state) {
      if (this.threads.size >= this.maxThreads) this.evictLeastRecentlyUsed();
      state = createState();
      const start = this.turnStarts.get(threadId);
      if (Number.isFinite(start)) state.rateAnchor = { at: start };
      this.threads.set(threadId, state);
    }
    state.lastUsed = ++this.sequence;
    state.lastFingerprint = key;
    if (at !== null) {
      state.recentEvents.add(key);
      state.recentOrder.push(key);
      if (state.recentOrder.length > DEDUPE_LIMIT) {
        state.recentEvents.delete(state.recentOrder.shift());
      }
    }

    let outputDelta = null;
    for (const field of COUNTERS) {
      if (!(field in usage)) continue;
      const previous = state.raw[field];
      const current = usage[field];
      const delta = previous === null ? current : current >= previous ? current - previous : current;
      state.totals[field] = (state.totals[field] ?? 0) + delta;
      state.raw[field] = current;
      if (field === 'output_tokens' && (previous !== null || state.rateAnchor)) outputDelta = delta;
    }

    if (at === null) {
      state.currentRate = null;
      state.rateAnchor = null;
      state.rateWindow = null;
      state.lastEventAt = null;
      return true;
    }

    const timeRegressed = state.lastEventAt !== null && at <= state.lastEventAt;
    state.updatedAt = at;
    state.lastEventAt = at;

    let pointRate = null;
    if (timeRegressed) {
      state.currentRate = null;
      state.rateAnchor = null;
      state.rateWindow = null;
    } else if (!('output_tokens' in usage)) {
      state.currentRate = null;
      state.rateAnchor = null;
      state.rateWindow = null;
    } else {
      if (outputDelta !== null && state.rateAnchor && at > state.rateAnchor.at) {
        pointRate = outputDelta / ((at - state.rateAnchor.at) / 1000);
        state.rateWindow = { at: state.rateAnchor.at, outputDelta };
      } else {
        state.rateWindow = null;
      }
      state.currentRate = pointRate;
      state.rateAnchor = { at };
    }

    if (!timeRegressed && (state.points.length === 0 || at > state.points[state.points.length - 1].at)) {
      state.points.push({ at, totalTokens: state.totals.total_tokens, outputTokens: state.totals.output_tokens, rate: pointRate, estimated: false });
      this.compressPoints(state);
    }
    return true;
  }

  snapshot(threadId, now = Date.now(), { running = false } = {}) {
    const state = this.threads.get(threadId);
    if (!state) return this.emptySnapshot();
    state.lastUsed = ++this.sequence;

    const waiting = running && Number.isFinite(now) && state.updatedAt !== null && now > state.updatedAt;
    const rate = waiting ? this.estimateRate(state, now) : state.currentRate;
    const rateEstimated = waiting && rate !== null;
    const points = state.points.map(point => ({ ...point }));
    let trimmedForEstimate = false;
    if (running && Number.isFinite(now) && points.length && now > points.at(-1).at) {
      if (points.length >= this.maxPoints) {
        points.splice(1, points.length - this.maxPoints + 1);
        trimmedForEstimate = true;
      }
      points.push({
        at: now,
        totalTokens: state.totals.total_tokens,
        outputTokens: state.totals.output_tokens,
        rate: waiting ? rate : null,
        estimated: true
      });
    }

    return {
      available: true,
      totalTokens: state.totals.total_tokens,
      inputTokens: state.totals.input_tokens,
      outputTokens: state.totals.output_tokens,
      cachedInputTokens: state.totals.cached_input_tokens,
      reasoningOutputTokens: state.totals.reasoning_output_tokens,
      updatedAt: state.updatedAt,
      points,
      rate,
      rateEstimated,
      rateKind: RATE_KIND,
      coverage: {
        from: points[0]?.at ?? null,
        to: points.at(-1)?.at ?? null,
        retainedPoints: points.length,
        maxPoints: this.maxPoints,
        sampled: state.sampled || trimmedForEstimate
      }
    };
  }

  emptySnapshot() {
    return {
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
      rateKind: RATE_KIND,
      coverage: {
        from: null,
        to: null,
        retainedPoints: 0,
        maxPoints: this.maxPoints,
        sampled: false
      }
    };
  }

  estimateRate(state, now) {
    if (!state.rateWindow || !Number.isFinite(now) || now <= state.rateWindow.at) return null;
    // Spread the latest observed output delta across its sample interval and live wait.
    return state.rateWindow.outputDelta / ((now - state.rateWindow.at) / 1000);
  }

  compressPoints(state) {
    if (state.points.length <= this.maxPoints) return;
    const source = state.points;
    const firstAt = source[0].at;
    const lastAt = source.at(-1).at;
    const timeRange = lastAt - firstAt;
    if (this.maxPoints <= 3) {
      const selected = [0, source.length - 1];
      if (this.maxPoints === 3) {
        const midpoint = firstAt + timeRange / 2;
        let nearest = 1;
        for (let index = 2; index < source.length - 1; index++) {
          if (Math.abs(source[index].at - midpoint) < Math.abs(source[nearest].at - midpoint)) nearest = index;
        }
        selected.splice(1, 0, nearest);
      }
      state.points = selected.map(index => source[index]);
      state.sampled = true;
      return;
    }
    const selected = new Set([0, source.length - 1]);
    const bucketCount = Math.max(1, Math.floor((this.maxPoints - 2) / 2));
    const buckets = new Map();
    for (let index = 1; index < source.length - 1; index++) {
      const elapsed = source[index].at - firstAt;
      const bucket = timeRange > 0
        ? Math.min(bucketCount - 1, Math.floor(elapsed / timeRange * bucketCount))
        : 0;
      let summary = buckets.get(bucket);
      if (!summary) {
        summary = { first: index, last: index, minimum: null, maximum: null };
        buckets.set(bucket, summary);
      }
      summary.last = index;

      const rate = source[index].rate;
      if (!Number.isFinite(rate)) continue;
      if (!summary.minimum || rate < summary.minimum.rate) summary.minimum = { index, rate };
      if (!summary.maximum || rate > summary.maximum.rate) summary.maximum = { index, rate };
    }

    for (const summary of buckets.values()) {
      if (!summary.minimum || summary.minimum.index === summary.maximum.index) {
        selected.add(summary.first);
        selected.add(summary.last);
      } else {
        selected.add(summary.minimum.index);
        selected.add(summary.maximum.index);
      }
    }

    const remaining = this.maxPoints - selected.size;
    if (remaining > 0) {
      const fillBuckets = new Map();
      for (let index = 1; index < source.length - 1; index++) {
        if (selected.has(index)) continue;
        const elapsed = source[index].at - firstAt;
        const bucket = timeRange > 0
          ? Math.min(remaining - 1, Math.floor(elapsed / timeRange * remaining))
          : 0;
        if (!fillBuckets.has(bucket)) fillBuckets.set(bucket, index);
      }
      for (const index of fillBuckets.values()) {
        if (selected.size >= this.maxPoints) break;
        selected.add(index);
      }
    }
    for (let index = 1; selected.size < this.maxPoints && index < source.length - 1; index++) {
      selected.add(index);
    }
    state.points = [...selected].sort((a, b) => a - b).map(index => source[index]);
    state.sampled = true;
  }

  evictLeastRecentlyUsed() {
    let oldestId;
    let oldestUse = Infinity;
    for (const [threadId, state] of this.threads) {
      if (state.lastUsed < oldestUse) {
        oldestId = threadId;
        oldestUse = state.lastUsed;
      }
    }
    if (oldestId !== undefined) this.threads.delete(oldestId);
  }
}
