// Undo / redo command history (per open document)
import { bus } from './util.js';

const undoStack = [];
const redoStack = [];
const LIMIT = 60;
let running = false;

/** Record an already-applied action. undo/redo are async functions. */
export function record(label, undo, redo) {
  if (running) return;
  undoStack.push({ label, undo, redo });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  bus.emit('history');
}

export async function undo() {
  const a = undoStack.pop(); if (!a) return null;
  running = true;
  try { await a.undo(); redoStack.push(a); } finally { running = false; bus.emit('history'); }
  return a.label;
}
export async function redo() {
  const a = redoStack.pop(); if (!a) return null;
  running = true;
  try { await a.redo(); undoStack.push(a); } finally { running = false; bus.emit('history'); }
  return a.label;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const peekUndo = () => undoStack[undoStack.length - 1]?.label;
export const peekRedo = () => redoStack[redoStack.length - 1]?.label;
export function clearHistory() { undoStack.length = 0; redoStack.length = 0; bus.emit('history'); }
export const isReplaying = () => running;
