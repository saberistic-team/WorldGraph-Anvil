import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { ApplicationNotification, PrimitiveIndexRequested } from '@worldgraph/contracts';

import { PrimitiveIndexNotificationSink } from './index-notifications.js';

describe('PrimitiveIndexNotificationSink', () => {
  it('forwards notifications and enqueues a deterministic typed wake message', async () => {
    const forwarded: ApplicationNotification[] = [];
    const jobs: { data: PrimitiveIndexRequested; id: string | undefined }[] = [];
    const queue = {
      add: async (_name: string, data: PrimitiveIndexRequested, options: { jobId?: string }) => {
        jobs.push({ data, id: options.jobId });
        return {};
      },
    } as Queue<PrimitiveIndexRequested>;
    const sink = new PrimitiveIndexNotificationSink(queue, {
      publish: async (notification) => {
        forwarded.push(notification);
      },
    });
    const notification: Extract<ApplicationNotification, { type: 'PrimitiveIndexRequested' }> = {
      id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
      occurredAt: '2026-07-21T12:00:00.000Z',
      payload: {
        actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
        contentHash: 'a'.repeat(64),
        indexSchemaVersion: 1,
        primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
        providerConfigurationId: 'disabled-v1',
      },
      schemaVersion: 1,
      type: 'PrimitiveIndexRequested',
    };
    await sink.publish(notification);
    await sink.publish(notification);
    expect(forwarded).toEqual([notification, notification]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.data).toEqual({
      contentHash: 'a'.repeat(64),
      indexSchemaVersion: 1,
      primitiveVersionId: notification.payload.primitiveVersionId,
      providerConfigurationId: 'disabled-v1',
      schemaVersion: 1,
      type: 'PrimitiveIndexRequested',
    });
    expect(jobs[0]?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(jobs[1]?.id).toBe(jobs[0]?.id);
  });
});
