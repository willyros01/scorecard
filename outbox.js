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

/* Errors that will NEVER succeed however long we wait.
 *
 * Retrying these fifty times achieved nothing except keeping the queue stuck —
 * and because a failure stopped the whole flush, one refused write held every
 * later one behind it. That is what left a red "2 waiting" on a phone with a
 * perfectly good connection. */
const PERMANENT = [
  "permission-denied", "insufficient permissions", "not-found",
  "invalid-argument", "failed-precondition", "unauthenticated",
];

const isPermanent = (error) => {
  const text = String((error && (error.code || error.message)) || "").toLowerCase();
  return PERMANENT.some((code) => text.includes(code));
};

const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};
const write = (ops) => {
  try { localStorage.setItem(KEY, JSON.stringify(ops)); return true; } catch { return false; }
};

export const pending = () => read();
export const count = () => read().length;
export const isEmpty = () => read().length === 0;

/* type: 'set' | 'update' | 'delete' | 'batch'
 *
 * A single-document operation carries path and data. A 'batch' carries writes:
 * an array of { op, path, data } that must all land together or not at all.
 * The batch is one queue entry on purpose — replayed as one commit, it can
 * never half-apply, which is what was corrupting data. */
export function enqueue({ type, path = null, data = null, writes = null, opId = null }) {
  const ops = read();
  const op = {
    opId: opId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type, path, data, writes,
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
  /* Batches are never merged. Collapsing them would break the very guarantee
     they exist to provide. */
  if (operation.type === "batch") return enqueue(operation);

  const ops = read();
  const key = operation.path.join("/");
  const existing = [...ops].reverse().find((o) => o.path && o.path.join("/") === key);

  /* A document created and then deleted while still offline never needs to
     reach the database at all. Sending both meant the create was refused or the
     delete arrived for something that did not exist yet — and either way the
     queue jammed. Cancelling the pair locally is correct AND saves a round
     trip. */
  if (operation.type === "delete" && existing && existing.type === "set") {
    write(ops.filter((o) => o.opId !== existing.opId));
    return { opId: existing.opId, cancelled: true };
  }

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

      /* Give up at once on something that can never succeed, rather than fifty
         times over — and carry on with the rest of the queue instead of letting
         one refused write block everything behind it. */
      if (isPermanent(error) || op.attempts >= MAX_ATTEMPTS) {
        abandoned.push({
          ...op,
          error: String((error && (error.code || error.message)) || error),
          permanent: isPermanent(error),
        });
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
