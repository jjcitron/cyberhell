/* ===========================================================================
   undo.js — command stack.

   Full-snapshot undo: every apply() clones the level before the mutator runs.
   A big converted level is ~1-3 MB of JSON, so the stack is capped at 40 steps.
   ponytail: full snapshots, switch to JSON-patch deltas only if memory bites.
   =========================================================================== */
(function () {
  'use strict';

  function UndoStack(opts) {
    this.get = opts.get;          // () -> level
    this.set = opts.set;          // (level) -> void
    this.onChange = opts.onChange || function () {};
    this.limit = opts.limit || 40;
    this.past = [];
    this.future = [];
  }

  UndoStack.prototype.reset = function () {
    this.past.length = 0;
    this.future.length = 0;
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
    this.past.push({ level: before, label: label || 'edit' });
    if (this.past.length > this.limit) this.past.shift();
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
    this.future.push({ level: JSON.parse(JSON.stringify(this.get())), label: entry.label });
    this.set(entry.level);
    this.onChange();
    return entry.label;
  };

  UndoStack.prototype.redo = function () {
    if (!this.future.length) return null;
    var entry = this.future.pop();
    this.past.push({ level: JSON.parse(JSON.stringify(this.get())), label: entry.label });
    this.set(entry.level);
    this.onChange();
    return entry.label;
  };

  if (typeof window !== 'undefined') window.EdUndoStack = UndoStack;
  if (typeof module !== 'undefined' && module.exports) module.exports = UndoStack;
})();
