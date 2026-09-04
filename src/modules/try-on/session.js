import { randomUUID } from 'node:crypto';

import config from '../../config/index.js';
import { NotFoundError } from '../fitting-room/errors.js';

/**
 * A try-on session holds the shopper's picks and the looks drawn from them.
 * Same shape as the fitting room's draft store, and swappable the same way.
 */
export class InMemoryTryOnStore {
  #sessions = new Map();
  #jobs = new Map();

  createSession(session) {
    this.#sessions.set(session.id, session);
    return session;
  }

  readSession(id) {
    const session = this.#sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  writeSession(session) {
    this.#sessions.set(session.id, session);
    return session;
  }

  deleteSession(id) {
    return this.#sessions.delete(id);
  }

  writeJob(job) {
    this.#jobs.set(job.id, job);
    return job;
  }

  readJob(id) {
    const job = this.#jobs.get(id);
    if (!job) return null;
    if (job.expiresAt <= Date.now()) {
      this.#jobs.delete(id);
      return null;
    }
    return job;
  }

  deleteJobsForSession(sessionId) {
    let removed = 0;
    for (const [id, job] of this.#jobs) {
      if (job.sessionId === sessionId) {
        this.#jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(id);
        removed += 1;
      }
    }
    for (const [id, job] of this.#jobs) {
      if (job.expiresAt <= now) {
        this.#jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get sizes() {
    return { sessions: this.#sessions.size, jobs: this.#jobs.size };
  }
}

let store = new InMemoryTryOnStore();

export const setTryOnStore = (nextStore) => {
  store = nextStore;
};

export const getTryOnStore = () => store;

export const createSession = ({ ttlMs = config.sessionTtlMs } = {}) => {
  const now = Date.now();
  return store.createSession({
    id: `tro_${randomUUID().replace(/-/g, '')}`,
    picks: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + ttlMs,
  });
};

export const readSession = (id) => {
  const session = store.readSession(id);
  if (!session) throw new NotFoundError(`Try-on session "${id}" has expired or does not exist.`);
  return session;
};

export const saveSession = (session, changes = {}) =>
  store.writeSession({ ...session, ...changes, updatedAt: new Date().toISOString() });

export const createJob = (job) =>
  store.writeJob({ ...job, expiresAt: Date.now() + config.sessionTtlMs });

export const updateJob = (job, changes) => store.writeJob({ ...job, ...changes });

export const readJob = (id) => {
  const job = store.readJob(id);
  if (!job) throw new NotFoundError(`Look "${id}" has expired or does not exist.`);
  return job;
};

export const clearJobs = (sessionId) => store.deleteJobsForSession(sessionId);

export const sweepTryOn = (now) => store.sweep(now);
