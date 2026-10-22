import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(HERE, '..', 'worker-entry.js');

/**
 * A tiny fixed worker pool for the CPU-bound engine calls.
 *
 * Fixed, not elastic, and with a bounded queue: the point is to keep the event
 * loop free AND to put a ceiling on how much work the process will accept. An
 * unbounded queue converts a denial-of-service into a slower denial-of-service
 * plus an out-of-memory kill.
 *
 * Workers are respawned if they die (an OOM inside one must not take the
 * service down permanently), and a job whose worker dies mid-flight is failed
 * rather than left hanging.
 */
export class WorkerPool {
  constructor({ size = 2, queueLimit = 8, jobTimeoutMs = 180_000 } = {}) {
    this.size = Math.max(1, size);
    this.queueLimit = queueLimit;
    this.jobTimeoutMs = jobTimeoutMs;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.jobs = new Map();
    this.seq = 0;
    this.closed = false;
    // True once ANY worker has finished loading the engine. Readiness must not
    // flip back to false merely because every worker is busy.
    this.warmed = false;
    for (let i = 0; i < this.size; i++) this.spawn();
  }

  spawn() {
    const w = new Worker(ENTRY);
    w.busyWith = null;
    w.on('message', (msg) => {
      if (msg && msg.ready) { this.warmed = true; this.release(w); return; }
      const job = this.jobs.get(msg.id);
      if (!job) return;
      this.jobs.delete(msg.id);
      clearTimeout(job.timer);
      w.busyWith = null;
      this.release(w);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error));
    });
    w.on('error', (err) => this.fail(w, err));
    w.on('exit', (code) => {
      if (!this.closed && code !== 0) this.fail(w, new Error(`worker exited (${code})`));
    });
    this.workers.push(w);
    return w;
  }

  /** A dead worker fails only its own job, then is replaced. */
  fail(w, err) {
    if (w.busyWith) {
      const job = this.jobs.get(w.busyWith);
      if (job) { this.jobs.delete(w.busyWith); clearTimeout(job.timer); job.reject(err); }
      w.busyWith = null;
    }
    this.workers = this.workers.filter((x) => x !== w);
    this.idle = this.idle.filter((x) => x !== w);
    w.terminate().catch(() => {});
    if (!this.closed && this.workers.length < this.size) this.spawn();
  }

  release(w) {
    const next = this.queue.shift();
    if (next) return this.dispatch(w, next);
    this.idle.push(w);
  }

  dispatch(w, job) {
    w.busyWith = job.id;
    this.jobs.set(job.id, job);
    job.timer = setTimeout(() => {
      // A job past its deadline has the worker wedged; kill it rather than
      // letting one poisoned document hold a slot forever.
      this.jobs.delete(job.id);
      job.reject(Object.assign(new Error('This document took too long to process.'), { code: 'TIMEOUT' }));
      this.fail(w, new Error('job timeout'));
    }, this.jobTimeoutMs);
    w.postMessage({ id: job.id, op: job.op, payload: job.payload }, job.transfer || []);
  }

  run(op, payload, transfer) {
    if (this.closed) return Promise.reject(new Error('pool is closed'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.seq, op, payload, transfer, resolve, reject };
      const w = this.idle.pop();
      if (w) return this.dispatch(w, job);
      if (this.queue.length >= this.queueLimit) {
        return reject(Object.assign(new Error('Server is busy. Try again in a moment.'), { code: 'BUSY' }));
      }
      this.queue.push(job);
    });
  }

  stats() {
    return { warmed: this.warmed, workers: this.workers.length, idle: this.idle.length, queued: this.queue.length, inflight: this.jobs.size };
  }

  async close() {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
  }
}
