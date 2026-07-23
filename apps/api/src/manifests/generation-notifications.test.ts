import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';

import type { ApplicationNotification, ManifestGenerationRequested } from '@worldgraph/contracts';

import { ManifestGenerationNotificationSink } from './generation-notifications.js';

describe('ManifestGenerationNotificationSink', () => {
  it('forwards the notification and emits a deterministic wake without prompt content', async () => {
    const forwarded: ApplicationNotification[] = [];
    const jobs: { data: ManifestGenerationRequested; id: string | undefined }[] = [];
    const queue = {
      add: async (
        _name: string,
        data: ManifestGenerationRequested,
        options: { jobId?: string },
      ) => {
        jobs.push({ data, id: options.jobId });
        return {};
      },
    } as Queue<ManifestGenerationRequested>;
    const notification: Extract<ApplicationNotification, { type: 'ManifestGenerationRequested' }> =
      {
        id: '018f8652-3cb6-7d52-904b-cce7901d7e25',
        occurredAt: '2026-07-21T12:00:00.000Z',
        payload: {
          actorUserId: '018f8652-3cb6-7d52-904b-cce7901d7e26',
          inputHash: 'a'.repeat(64),
          runId: '018f8652-3cb6-7d52-904b-cce7901d7e27',
          worldId: '018f8652-3cb6-7d52-904b-cce7901d7e28',
        },
        schemaVersion: 1,
        type: 'ManifestGenerationRequested',
      };
    const sink = new ManifestGenerationNotificationSink(queue, 'disabled-v1', {
      publish: async (value) => void forwarded.push(value),
    });

    await sink.publish(notification);
    await sink.publish(notification);

    expect(forwarded).toEqual([notification, notification]);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.data).toEqual({
      generatorSchemaVersion: 1,
      inputHash: 'a'.repeat(64),
      promptTemplateVersion: 1,
      providerConfigurationId: 'disabled-v1',
      runId: notification.payload.runId,
      schemaVersion: 1,
      type: 'ManifestGenerationRequested',
      validatorVersion: 1,
    });
    expect(jobs[0]?.data).not.toHaveProperty('promptText');
    expect(jobs[0]?.data).not.toHaveProperty('worldId');
    expect(jobs[0]?.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(jobs[1]?.id).toBe(jobs[0]?.id);
  });
});
