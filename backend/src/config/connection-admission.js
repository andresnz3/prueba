'use strict';

function createConnectionAdmission({ limit, queueLimit, timeoutMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(queueLimit) || queueLimit < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('Invalid database admission settings');
  }
  let active = 0;
  let peakActive = 0;
  let waitCount = 0;
  let totalWaitMs = 0;
  let maxWaitMs = 0;
  let slowAcquisitions = 0;
  let timedOut = 0;
  let rejected = 0;
  let slowTransactions = 0;
  let transactionCount = 0;
  let maxTransactionMs = 0;
  let statementCount = 0;
  let slowStatements = 0;
  let maxStatementMs = 0;
  const waiters = [];

  function recordAcquisitionWait(durationMs) {
    const duration = Math.max(0, Number(durationMs) || 0);
    totalWaitMs += duration;
    maxWaitMs = Math.max(maxWaitMs, duration);
    if (duration >= 250) slowAcquisitions += 1;
  }

  function releasePermit() {
    active -= 1;
    while (waiters.length) {
      const waiter = waiters.shift();
      if (waiter.settled) continue;
      waiter.settled = true;
      clearTimer(waiter.timer);
      active += 1;
      peakActive = Math.max(peakActive, active);
      const waitedMs = Math.max(0, now() - waiter.enqueuedAt);
      recordAcquisitionWait(waitedMs);
      waiter.resolve({ waitedMs, release: once(releasePermit) });
      return;
    }
  }

  function once(fn) {
    let called = false;
    return () => { if (called) return false; called = true; fn(); return true; };
  }

  function acquire() {
    if (active < limit) {
      active += 1;
      peakActive = Math.max(peakActive, active);
      return Promise.resolve({ waitedMs: 0, release: once(releasePermit) });
    }
    if (waiters.length >= queueLimit) {
      rejected += 1;
      const error = new Error('Database connection admission queue is full');
      error.code = 'POS_POOL_QUEUE_FULL';
      return Promise.reject(error);
    }
    waitCount += 1;
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, enqueuedAt: now(), settled: false, timer: undefined };
      waiter.timer = setTimer(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        timedOut += 1;
        rejected += 1;
        recordAcquisitionWait(now() - waiter.enqueuedAt);
        const position = waiters.indexOf(waiter);
        if (position !== -1) waiters.splice(position, 1);
        const error = new Error('Database connection acquisition timed out');
        error.code = 'POS_POOL_ACQUIRE_TIMEOUT';
        reject(error);
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function recordTransaction(durationMs) {
    transactionCount += 1;
    const duration = Math.max(0, Number(durationMs) || 0);
    maxTransactionMs = Math.max(maxTransactionMs, duration);
    if (duration >= 1000) slowTransactions += 1;
  }

  function recordStatement(durationMs) {
    statementCount += 1;
    const duration = Math.max(0, Number(durationMs) || 0);
    maxStatementMs = Math.max(maxStatementMs, duration);
    if (duration >= 1000) slowStatements += 1;
  }

  return {
    acquire,
    recordTransaction,
    recordStatement,
    snapshot() {
      return Object.freeze({ active, peakActive, queued: waiters.length, limit, queueLimit, waitCount, averageWaitMs: waitCount ? totalWaitMs / waitCount : 0, maxWaitMs, slowAcquisitions, timedOut, rejected, transactionCount, slowTransactions, maxTransactionMs, statementCount, slowStatements, maxStatementMs });
    }
  };
}

function installBoundedAdmission(corePool, admission, onWait = () => {}) {
  const originalGetConnection = corePool.getConnection.bind(corePool);
  corePool.getConnection = callback => {
    if (typeof callback !== 'function') throw new TypeError('A connection callback is required');
    admission.acquire().then(permit => {
      if (permit.waitedMs > 0) onWait(permit.waitedMs);
      try {
        originalGetConnection((error, connection) => {
          if (error) { permit.release(); callback(error); return; }
          let released = false;
          const release = connection.release.bind(connection);
          const destroy = connection.destroy.bind(connection);
          const lease = new Proxy(connection, {
            get(target, property) {
              if (property === 'release') return (...args) => {
                if (released) return;
                released = true;
                try { return release(...args); } finally { permit.release(); }
              };
              if (property === 'destroy') return (...args) => {
                if (released) return;
                released = true;
                try { return destroy(...args); } finally { permit.release(); }
              };
              if ((property === 'execute' || property === 'query') && typeof target[property] === 'function') return (...args) => {
                const original = target[property].bind(target);
              const callbackIndex = args.findLastIndex(argument => typeof argument === 'function');
              if (callbackIndex === -1) return original(...args);
              const callback = args[callbackIndex];
              const startedAt = process.hrtime.bigint();
              args[callbackIndex] = (...results) => {
                const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
                admission.recordStatement(durationMs);
                if (durationMs >= 1000) onWait(durationMs, 'database_slow_statement');
                return callback(...results);
              };
              return original(...args);
              };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            }
          });
          callback(null, lease);
        });
      } catch (error) {
        permit.release();
        callback(error);
      }
    }, callback);
  };
}

module.exports = { createConnectionAdmission, installBoundedAdmission };
