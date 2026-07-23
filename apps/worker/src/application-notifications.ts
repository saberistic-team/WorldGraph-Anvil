import type { ApplicationNotification } from '@worldgraph/contracts';

/**
 * M03 application notifications are best-effort process signals. PostgreSQL
 * primitive_index_jobs and sanitized worker logs remain the operational audit
 * trail until the authoritative M06 event ledger exists.
 */
export interface WorkerNotificationSink {
  publish(notification: ApplicationNotification): Promise<void>;
}

export const discardWorkerNotifications: WorkerNotificationSink = {
  publish: async () => undefined,
};
