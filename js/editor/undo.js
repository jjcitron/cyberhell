/* ===========================================================================
   undo.js — command stack.

   Full-snapshot undo, capped by ESTIMATED BYTES rather than step count, because
   levels differ by two orders of magnitude: pack1/json1 is ~850 walls, dv/json2
   is ~20k. 40 steps of the latter would be hundreds of MB. The budget keeps 40
   steps on an ordinary level and silently fewer on a monster one.
   ponytail: element-count size estimate, no stringify (that would cost more than
   the clone it measures); switch to JSON-patch deltas only if this still bites.
   =========================================================================== */
(function () {
  'use strict';

  function UndoStack(opts) {
    this.get = opts.get;          // () -> level
    this.set = opts.set;          // (level) -> void
    this.onChange = opts.onChange || function () {};
    this.limit = opts.limit || 40;
    this.budget = opts.budget || 64 * 1024 * 1024;   // bytes of retained history
    this.past = [];
    this.future = [];
    this.bytes = 0;
  }

  /* Rough retained size of one level snapshot. Per-element constants are the
     measured average JSON size of each record type in the corpus. */
  function estimateBytes(level) {
    if (!level) return 0;
    return 2048 +
      (level.walls || []).length * 140 +
      (level.sectors || []).length * 420 +
      (level.entities || []).length * 90 +
      (level.triggers || []).length * 130;
  }

  UndoStack.prototype._trim = function () {
    while (this.past.length > this.limit ||
           (this.past.length > 1 && this.bytes > this.budget)) {
      var dropped = this.past.shift();
      this.bytes -= dropped.bytes;
    }
  };

  UndoStack.prototype.reset = function () {
    this.past.length = 0;
    this.future.length = 0;
    this.bytes = 0;
    this.onChange();
  };

  /* Runs mutator(level) between snapshots. If the mutator throws, the level is
     restored from the snapshot so a half-applied edit never survives. */
  UndoStack.prototype.apply = function (mutator, label) {
    var level = this.get();
    if (!level) return false;
    var before = JSON.parse(JSON.stringify(level));
    try {
      mutator(level);
    } catch (err) {
      this.set(before);
      throw err;
    }
    var size = estimateBytes(before);
    this.past.push({ level: before, label: label || 'edit', bytes: size });
    this.bytes += size;
    this._trim();
    this.future.length = 0;
    this.onChange();
    return true;
  };

  UndoStack.prototype.canUndo = function () { return this.past.length > 0; };
  UndoStack.prototype.canRedo = function () { return this.future.length > 0; };
  UndoStack.prototype.undoLabel = function () { return this.past.length ? this.past[this.past.length - 1].label : ''; };
  UndoStack.prototype.redoLabel = function () { return this.future.length ? this.future[this.future.length - 1].label : ''; };

  UndoStack.prototype.undo = function () {
    if (!this.past.length) return null;
    var entry = this.past.pop();
    this.bytes -= entry.bytes;
    this.future.push({ level: JSON.parse(JSON.stringify(this.get())), label: entry.label, bytes: entry.bytes });
    this.set(entry.level);
    this.onChange();
    return entry.label;
  };

  UndoStack.prototype.redo = function () {
    if (!this.future.length) return null;
    var entry = this.future.pop();
    this.past.push({ level: JSON.parse(JSON.stringify(this.get())), label: entry.label, bytes: entry.bytes });
    this.bytes += entry.bytes;
    this.set(entry.level);
    this.onChange();
    return entry.label;
  };

  if (typeof window !== 'undefined') window.EdUndoStack = UndoStack;
  if (typeof module !== 'undefined' && module.exports) module.exports = UndoStack;
})();
