import { ScheduledActionDetail } from './schedule-detail';

export default async function ScheduledActionDetailPage({
  params,
}: {
  params: Promise<{ scheduleId: string; worldId: string }>;
}) {
  const { scheduleId, worldId } = await params;
  return <ScheduledActionDetail scheduleId={scheduleId} worldId={worldId} />;
}
