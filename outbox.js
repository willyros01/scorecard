/* outbox.js — the offline write queue.
 *
 * Version 1 held one snapshot of everything and pushed it whole. Version 2
 * writes individual documents, so an offline device has to remember a list of
 * changes and replay them in order when the connection returns.
 *
 * This is the part of version 2 most likely to lose someone's round, so the
 * design is deliberately boring:
 *
 *   - every operation carries an opId, and replaying one twice produces the
 *     same result as replaying it once
 *   - operations replay oldest first, so an edit never lands before the create
 *     it depends on
 *   - an operation is removed only after the write is confirmed
 *   - a failure stops the run rather than skipping ahead, because skipping
 *     would apply changes out of order
 *
 * Nothing here talks to Firebase. It is handed a writer function, which makes
 * it testable without a network.
 */

const KEY = "golf:v2:outbox";
const MAX_ATTEMPTS = 50;

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};
const write = (ops) => {
  try { localStorage.setItem(KEY, JSON.stringify(ops)); return true; } catch { return false; }
};

export const pending = () => read();
export const count = () => read().length;
export const isEmpty = () => read().length === 0;

/* type: 'set' | 'update' | 'delete'
   path: array of path segments, e.g. ['associations', a, 'rounds', id] */
export function enqueue({ type, path, data = null, opId = null }) {
  const ops = read();
  const op = {
    opId: opId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type, path, data,
    queuedAt: Date.now(),
    attempts: 0,
  };
  ops.push(op);
  write(ops);
  return op;
}

/* Collapses repeated edits to the same document while still offline, so ten
   corrections to one round replay as one write rather than ten. Creates are
   never collapsed away — only later updates fold into an earlier one. */
export function enqueueOrMerge(operation) {
  const ops = read();
  const key = operation.path.join("/");
  const existing = [...ops].reverse().find((o) => o.path.join("/") === key);

  if (existing && operation.type === "update" && (existing.type === "set" || existing.type === "update")) {
    existing.data = { ...(existing.data || {}), ...(operation.data || {}) };
    write(ops);
    return existing;
  }
  return enqueue(operation);
}

export function remove(opId) {
  write(read().filter((o) => o.opId !== opId));
}

export function clear() {
  write([]);
}

/* Replays the queue against `writer`, which is given one operation and should
 * resolve when the write has landed and reject if it has not.
 *
 * Returns { sent, failed, remaining, stoppedOn }.
 *
 * A rejection stops the run. The operation stays queued and is retried on the
 * next flush, unless it has failed MAX_ATTEMPTS times — at that point it is
 * moved aside rather than blocking every later change forever.
 */
export async function flush(writer) {
  let sent = 0;
  let stoppedOn = null;
  const abandoned = [];

  for (;;) {
    const ops = read();
    if (ops.length === 0) break;

    const op = ops[0];
    try {
      await writer(op);
      remove(op.opId);
      sent++;
    } catch (error) {
      op.attempts = (op.attempts || 0) + 1;
      if (op.attempts >= MAX_ATTEMPTS) {
        /* Permanently rejected — a deleted parent, or a rule that will never
           allow it. Set it aside so the rest of the queue can drain. */
        abandoned.push({ ...op, error: String(error && error.message) });
        remove(op.opId);
        continue;
      }
      write(ops);
      stoppedOn = { opId: op.opId, attempts: op.attempts, error: String(error && error.message) };
      break;
    }
  }

  if (abandoned.length) {
    try {
      const previous = JSON.parse(localStorage.getItem("golf:v2:abandoned") || "[]");
      localStorage.setItem("golf:v2:abandoned", JSON.stringify([...previous, ...abandoned].slice(-50)));
    } catch { /* nothing more we can do, and it must not break the flush */ }
  }

  return { sent, failed: abandoned.length, remaining: count(), stoppedOn };
}

/* Anything the queue gave up on, kept so it can be shown rather than vanishing. */
export function abandoned() {
  try { return JSON.parse(localStorage.getItem("golf:v2:abandoned") || "[]"); } catch { return []; }
}
