import { randomUUID } from 'node:crypto';

import config from '../../config/index.js';
import { NotFoundError } from './errors.js';

/**
 * Drafts of a fitting room in progress, so a shopper can leave the page and
 * come back to the same make-up.
 *
 * The in-memory implementation below is deliberately behind a tiny interface —
 * swap it for Redis or a table by passing another store to `setSessionStore`.
 */
export class InMemorySessionStore {
  #sessions = new Map();

  create(session) {
    this.#sessions.set(session.id, session);
    return session;
  }

  read(id) {
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  write(session) {
    this.#sessions.set(session.id, session);
    return session;
  }

  delete(id) {
    return this.#sessions.delete(id);
  }

  /** Drop everything that has timed out. Safe to call on a timer. */
  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.#sessions.size;
  }
}

let store = new InMemorySessionStore();

export const setSessionStore = (nextStore) => {
  store = nextStore;
};

export const getSessionStore = () => store;

export const createSession = ({ productSlug, selection, ttlMs = config.sessionTtlMs }) => {
  const now = Date.now();
  return store.create({
    id: `frs_${randomUUID().replace(/-/g, '')}`,
    productSlug,
    selection,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  });
};

export const readSession = (id) => {
  const session = store.read(id);
  if (!session) throw new NotFoundError(`Fitting room session "${id}" has expired or does not exist.`);
  return session;
};

export const saveSession = (session, { selection } = {}) =>
  store.write({
    ...session,
    selection: selection ?? session.selection,
    updatedAt: new Date().toISOString(),
  });

export const deleteSession = (id) => store.delete(id);

export const sweepSessions = (now) => store.sweep(now);
