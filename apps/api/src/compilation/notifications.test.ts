import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import {
  COMPILER_VERSION,
  PREVIOUS_COMPILER_VERSION,
  type ApplicationNotification,
  type WorldCompilationRequestedQueue,
} from '@worldgraph/contracts';

import { CompilationNotificationSink } from './notifications.js';

describe('CompilationNotificationSink', () => {
  it('forwards requests and emits only a deterministic content-identity wake message', async () => {
    const forwarded: ApplicationNotification[] = [];
    const jobs: { data: WorldCompilationRequestedQueue; id: string | undefined }[] = [];
    const queue = {
      add: async (
        _name: string,
        data: WorldCompilationRequestedQueue,
        options: { jobId?: string },
      ) => {
        jobs.push({ data, id: options.jobId });
        return {};
      },
    } as Queue<WorldCompilationRequestedQueue>;
    const notification: Extract<ApplicationNotification, { type: 'WorldCompilationRequested' }> = {
      id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      occurredAt: '2026-07-22T12:00:00.000Z',
      payload: {
        actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        compilerVersion: PREVIOUS_COMPILER_VERSION,
        inputHash: 'a'.repeat(64),
        manifestRevisionId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        runId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        worldId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
      },
      schemaVersion: 1,
      type: 'WorldCompilationRequested',
    };
    const sink = new CompilationNotificationSink(queue, {
      publish: async (value) => void forwarded.push(value),
    });

    await sink.publish(notification);
    await sink.publish(notification);

    expect(forwarded).toEqual([notification, notification]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.data).toEqual({
      compilerConfigVersion: 1,
      compilerVersion: PREVIOUS_COMPILER_VERSION,
      inputHash: notification.payload.inputHash,
      manifestRevisionId: notification.payload.manifestRevisionId,
      runId: notification.payload.runId,
      schemaVersion: 1,
      type: 'WorldCompilationRequested',
    });
    expect(jobs[0]?.data).not.toHaveProperty('worldId');
    expect(jobs[0]?.data).not.toHaveProperty('manifest');
    expect(jobs[0]?.data).not.toHaveProperty('artifact');
    expect(jobs[0]?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(jobs[1]?.id).toBe(jobs[0]?.id);
  });

  it('keeps current-version compatibility for older request notifications', async () => {
    const jobs: WorldCompilationRequestedQueue[] = [];
    const queue = {
      add: async (_name: string, data: WorldCompilationRequestedQueue) => {
        jobs.push(data);
        return {};
      },
    } as Queue<WorldCompilationRequestedQueue>;
    const notification: Extract<ApplicationNotification, { type: 'WorldCompilationRequested' }> = {
      id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      occurredAt: '2026-07-22T12:00:00.000Z',
      payload: {
        actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e29',
        inputHash: 'a'.repeat(64),
        manifestRevisionId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        runId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        worldId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
      },
      schemaVersion: 1,
      type: 'WorldCompilationRequested',
    };
    const sink = new CompilationNotificationSink(queue, { publish: async () => undefined });

    await sink.publish(notification);

    expect(jobs[0]?.compilerVersion).toBe(COMPILER_VERSION);
  });
});
