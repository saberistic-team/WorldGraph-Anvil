import type { ApplicationNotification } from '@worldgraph/contracts';

export interface NotificationSink {
  publish(notification: ApplicationNotification): Promise<void>;
}

export const discardNotifications: NotificationSink = {
  publish: async () => undefined,
};
