import { EventEmitter } from 'node:events';

import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createDatabaseClient, observeDatabasePoolErrors } from './index.js';

describe('database pool error observation', () => {
  it('guards acquired and idle clients without exposing the client to observers', () => {
    const poolEvents = new EventEmitter();
    const clientEvents = new EventEmitter();
    const pool = poolEvents as unknown as pg.Pool;
    const client = clientEvents as unknown as pg.PoolClient;
    const checkedOutObserver = vi.fn();
    const poolIdleListener = vi.fn();
    const idleObserver = vi.fn();
    const stop = observeDatabasePoolErrors(pool, {
      onCheckedOutClientError: checkedOutObserver,
      onIdleClientError: idleObserver,
    });
    const outage = new Error('Connection terminated unexpectedly');

    poolEvents.emit('acquire', client);
    poolEvents.emit('acquire', client);
    expect(clientEvents.listenerCount('error')).toBe(1);
    expect(() => clientEvents.emit('error', outage)).not.toThrow();
    expect(checkedOutObserver).toHaveBeenCalledOnce();
    expect(checkedOutObserver).toHaveBeenCalledWith(outage);

    // pg-pool restores this listener before it emits release. The guard must
    // remove only its checked-out listener and leave the pool listener intact.
    clientEvents.on('error', poolIdleListener);
    poolEvents.emit('release', undefined, client);
    expect(clientEvents.listenerCount('error')).toBe(1);
    clientEvents.emit('error', outage);
    expect(poolIdleListener).toHaveBeenCalledOnce();
    expect(checkedOutObserver).toHaveBeenCalledOnce();

    expect(() => poolEvents.emit('error', outage, client)).not.toThrow();
    expect(idleObserver).toHaveBeenCalledOnce();
    expect(idleObserver).toHaveBeenCalledWith(outage);

    stop();
    expect(poolEvents.listenerCount('error')).toBe(0);
    expect(poolEvents.listenerCount('acquire')).toBe(0);
    expect(poolEvents.listenerCount('release')).toBe(0);
  });

  it('contains observer failures and removes active listeners when stopped', () => {
    const poolEvents = new EventEmitter();
    const clientEvents = new EventEmitter();
    const pool = poolEvents as unknown as pg.Pool;
    const client = clientEvents as unknown as pg.PoolClient;
    const stop = observeDatabasePoolErrors(pool, {
      onCheckedOutClientError: () => {
        throw new Error('logger unavailable');
      },
      onIdleClientError: () => {
        throw new Error('logger unavailable');
      },
    });

    poolEvents.emit('acquire', client);
    expect(() => clientEvents.emit('error', new Error('database unavailable'))).not.toThrow();
    expect(() => poolEvents.emit('error', new Error('database unavailable'), client)).not.toThrow();
    stop();
    expect(clientEvents.listenerCount('error')).toBe(0);
  });

  it('installs idle and checked-out protection in the shared client factory', async () => {
    const database = createDatabaseClient(
      'postgres://worldgraph:worldgraph@127.0.0.1/worldgraph',
      'pool-observer-test',
    );

    expect(database.pool.listenerCount('error')).toBe(1);
    expect(database.pool.listenerCount('acquire')).toBe(1);
    expect(database.pool.listenerCount('release')).toBe(1);
    await database.pool.end();
  });
});
