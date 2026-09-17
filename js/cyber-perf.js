/* ==========================================================================
   CyberPerf — hitch instrumentation (job 20260908-1150).

   The average-cost buckets already on the engine (perfAdd/perfStats) answer
   "what does a normal frame cost". They cannot answer the question the
   playtester actually asked, which was "why did it stop for a second".

   This records the other half:

     - frame ms measured rAF-to-rAF, so a stall that happens OUTSIDE the game
       loop (a fetch callback rebuilding the scene, a first-hit shader
       compile) still lands on a frame instead of vanishing between them
     - sim ms, the JS the loop itself spent
     - running max + rolling p99 for both
     - a cause tag on every frame over budget (~33 ms), built from exclusive
       section time, so the fix goes where the milliseconds are

   Classic script, no module system, same shape as the other js/ modules.
   Cost when nothing is over budget is two performance.now() calls per frame
   plus one per instrumented section, so it stays on in shipping builds.
   ========================================================================== */
(function () {
  'use strict';

  var RING = 4096;          // frames kept for percentiles (~68 s at 60 fps)
  var MAX_HITCHES = 512;    // worst-N kept when a run produces more

  function nowMs() { return performance.now(); }

  function Perf() {
    this.budgetMs = 33;     // "frame took longer than two vsyncs"
    this.enabled = true;
    this.longTasks = [];
    this.maxLongTask = 0;
    this.reset('boot');
    this._initLongTasks();
  }

  /* The browser's own answer to "how long was the main thread blocked".
     Frame time cannot answer it: a frame can be long because the GPU is slow
     (or, in a headless QA run, because the rasteriser is software), and none
     of that is a hang. A long task is main-thread work that could not be
     interrupted, which is exactly what a player feels as the game stopping.
     Chrome only reports tasks over 50 ms, which is well under any budget
     worth arguing about. */
  Perf.prototype._initLongTasks = function () {
    if (this._ltObs || typeof PerformanceObserver === 'undefined') return;
    var self = this;
    try {
      this._ltObs = new PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          if (e.startTime + e.duration < self.t0) continue;   // before this run
          var rec = { at: +(e.startTime - self.t0).toFixed(0), ms: +e.duration.toFixed(1) };
          self.longTasks.push(rec);
          if (e.duration > self.maxLongTask) self.maxLongTask = e.duration;
          if (self.longTasks.length > 4000) self.longTasks.shift();
        }
      });
      this._ltObs.observe({ entryTypes: ['longtask'] });
    } catch (err) { /* not supported: the frame/sim numbers still stand */ }
  };

  Perf.prototype.reset = function (label) {
    this.label = label || '';
    this.t0 = nowMs();
    this.frames = 0;
    this._frame = new Float64Array(RING);
    this._sim = new Float64Array(RING);
    this._n = 0;
    this.maxFrame = 0; this.maxFrameCause = ''; this.maxFrameAt = 0;
    this.maxSim = 0; this.maxSimCause = '';
    this.hitches = [];
    this.overBudget = 0;
    this.totals = {};       // tag -> { ms, n, max } inclusive
    this._cur = {};         // tag -> exclusive ms in the current interval
    this._stack = [];
    // Seeded, not zeroed: the interval from reset() to the first rAF callback
    // is a real interval, and on an "enter the level" run it is the one that
    // contains the whole rebuild. Zeroing it here is how you lose the stall
    // you came to measure.
    this._prevStart = this.t0;
    this._simMs = 0;
    this._notes = [];       // free-text markers carried onto the next hitch
    this.longTasks = [];
    this.maxLongTask = 0;
  };

  /* ---- sections ---------------------------------------------------------
     begin/end nest. A tag is charged its EXCLUSIVE time for cause tagging
     (so 'sim.enemies' does not swallow 'sim.lod') and its INCLUSIVE time in
     totals, which is what a "where does the frame go" table wants. */
  Perf.prototype.begin = function (tag) {
    if (!this.enabled) return;
    this._stack.push({ tag: tag, t: nowMs(), child: 0 });
  };

  Perf.prototype.end = function () {
    if (!this.enabled || !this._stack.length) return 0;
    var f = this._stack.pop();
    var dt = nowMs() - f.t;
    var self = dt - f.child;
    if (self < 0) self = 0;
    this._cur[f.tag] = (this._cur[f.tag] || 0) + self;
    var tot = this.totals[f.tag] || (this.totals[f.tag] = { ms: 0, n: 0, max: 0 });
    tot.ms += dt; tot.n++; if (dt > tot.max) tot.max = dt;
    if (this._stack.length) this._stack[this._stack.length - 1].child += dt;
    return dt;
  };

  /** Measure a synchronous block. Returns whatever fn returns. */
  Perf.prototype.span = function (tag, fn) {
    this.begin(tag);
    try { return fn(); } finally { this.end(); }
  };

  /** Charge time already measured elsewhere (engine perfMark/perfAdd sites,
      loadLevel's own phase timestamps) to a tag. */
  Perf.prototype.add = function (tag, ms) {
    if (!this.enabled || !(ms > 0)) return;
    this._cur[tag] = (this._cur[tag] || 0) + ms;
    var tot = this.totals[tag] || (this.totals[tag] = { ms: 0, n: 0, max: 0 });
    tot.ms += ms; tot.n++; if (ms > tot.max) tot.max = ms;
  };

  /** A label with no duration — "a level change started here". Attached to
      whatever hitch the current interval produces. */
  Perf.prototype.note = function (text) {
    if (!this.enabled) return;
    if (this._notes.indexOf(text) === -1) this._notes.push(text);
  };

  /* ---- frame boundaries ------------------------------------------------- */

  /** Top of the rAF callback. Closes the previous interval. */
  Perf.prototype.frame = function () {
    if (!this.enabled) return;
    var t = nowMs();
    if (this._prevStart) this._flush(t - this._prevStart, t);
    this._prevStart = t;
    this._cur = {};
    this._notes = [];
    this._simMs = 0;
    this._stack.length = 0;
  };

  /** Bottom of the rAF callback, after render submit. */
  Perf.prototype.endFrame = function () {
    if (!this.enabled || !this._prevStart) return;
    this._simMs = nowMs() - this._prevStart;
  };

  Perf.prototype._flush = function (frameMs, at) {
    var simMs = this._simMs;
    var i = this._n % RING;
    this._frame[i] = frameMs;
    this._sim[i] = simMs;
    this._n++;
    this.frames++;

    if (frameMs > this.maxFrame) {
      this.maxFrame = frameMs;
      this.maxFrameAt = +(at - this.t0).toFixed(0);
      this.maxFrameCause = this._cause(frameMs);
    }
    if (simMs > this.maxSim) {
      this.maxSim = simMs;
      this.maxSimCause = this._cause(simMs);
    }
    if (frameMs > this.budgetMs) {
      this.overBudget++;
      this.hitches.push({
        at: +(at - this.t0).toFixed(0),
        frameMs: +frameMs.toFixed(1),
        simMs: +simMs.toFixed(1),
        cause: this._cause(frameMs),
        notes: this._notes.slice()
      });
      if (this.hitches.length > MAX_HITCHES * 2) {
        this.hitches.sort(function (a, b) { return b.frameMs - a.frameMs; });
        this.hitches.length = MAX_HITCHES;
        this.hitches.sort(function (a, b) { return a.at - b.at; });
      }
    }
  };

  /** Top exclusive contributors, plus what the sections could not explain.
      Unattributed time on a long frame is the browser doing something we did
      not wrap — GPU compile/link, GC, layout, decode. */
  Perf.prototype._cause = function (frameMs) {
    var tags = [], k, accounted = 0;
    for (k in this._cur) { tags.push([k, this._cur[k]]); accounted += this._cur[k]; }
    tags.sort(function (a, b) { return b[1] - a[1]; });
    var parts = [];
    for (var i = 0; i < tags.length && i < 3; i++) {
      if (tags[i][1] < 0.4) break;
      parts.push(tags[i][0] + '=' + tags[i][1].toFixed(1));
    }
    var rest = frameMs - accounted;
    if (rest > 1 && (rest > frameMs * 0.25 || !parts.length)) {
      parts.push('unattributed=' + rest.toFixed(1));
    }
    return parts.length ? parts.join(' ') : 'idle';
  };

  /* ---- readout ---------------------------------------------------------- */

  function pct(arr, count, p) {
    if (!count) return 0;
    var n = Math.min(count, RING);
    var copy = Array.prototype.slice.call(arr.subarray(0, n));
    copy.sort(function (a, b) { return a - b; });
    var idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
    return +copy[idx].toFixed(2);
  }

  Perf.prototype.snapshot = function () {
    var worst = this.hitches.slice().sort(function (a, b) { return b.frameMs - a.frameMs; });
    var mods = {};
    for (var k in this.totals) {
      var t = this.totals[k];
      mods[k] = { totalMs: +t.ms.toFixed(1), n: t.n, maxMs: +t.max.toFixed(2), avgMs: +(t.ms / t.n).toFixed(3) };
    }
    // Pair each long task with the cause tag of the hitch it overlaps, so the
    // "main thread was blocked for N ms" number arrives with a reason.
    var lt = this.longTasks.slice().sort(function (a, b) { return b.ms - a.ms; }).slice(0, 8);
    for (var i = 0; i < lt.length; i++) {
      var best = null;
      for (var j = 0; j < this.hitches.length; j++) {
        var h = this.hitches[j];
        if (h.at >= lt[i].at - 40 && h.at <= lt[i].at + lt[i].ms + 40) {
          if (!best || h.frameMs > best.frameMs) best = h;
        }
      }
      if (best) { lt[i].cause = best.cause; lt[i].notes = best.notes; }
    }
    var ltMs = this.longTasks.map(function (x) { return x.ms; });
    var ltArr = new Float64Array(ltMs.length);
    for (var k = 0; k < ltMs.length; k++) ltArr[k] = ltMs[k];

    return {
      label: this.label,
      durationMs: +(nowMs() - this.t0).toFixed(0),
      maxLongTaskMs: +this.maxLongTask.toFixed(1),
      p99LongTaskMs: pct(ltArr, ltArr.length, 0.99),
      longTaskCount: this.longTasks.length,
      worstLongTasks: lt,
      frames: this.frames,
      budgetMs: this.budgetMs,
      maxFrameMs: +this.maxFrame.toFixed(1),
      maxFrameCause: this.maxFrameCause,
      maxFrameAtMs: this.maxFrameAt,
      maxSimMs: +this.maxSim.toFixed(1),
      maxSimCause: this.maxSimCause,
      p99FrameMs: pct(this._frame, this._n, 0.99),
      p95FrameMs: pct(this._frame, this._n, 0.95),
      medianFrameMs: pct(this._frame, this._n, 0.5),
      p99SimMs: pct(this._sim, this._n, 0.99),
      p95SimMs: pct(this._sim, this._n, 0.95),
      overBudgetFrames: this.overBudget,
      hitchCount: this.hitches.length,
      worstHitches: worst.slice(0, 12),
      sections: mods
    };
  };

  window.CyberPerf = new Perf();
}());
