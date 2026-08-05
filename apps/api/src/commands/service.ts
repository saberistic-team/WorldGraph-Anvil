import { createHash } from 'node:crypto';

import { canonicalJson, type Clock } from '@worldgraph/contracts';
import { telemetry } from '@worldgraph/observability';
import type { GovernanceRecentCredentialProof } from '@worldgraph/governance-command';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type {
  ScheduledActionPageTransport,
  SimulationBatchPageTransport,
  SimulationClockViewTransport,
  SimulationListQueryTransport,
  SubmitWorldCommand,
  WorldCommandResultTransport,
  WorldHistoryDetailTransport,
  WorldHistoryEntryTransport,
  WorldHistoryQueryTransport,
  WorldRuntimeHeadTransport,
} from './api-contracts.js';
import type { WorldCommandBus } from './command-bus.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './history-cursor.js';
import type { CommandRepository } from './types.js';

export interface HistoryPage {
  items: WorldHistoryEntryTransport[];
  nextCursor: string | null;
}

export class WorldCommandService {
  public constructor(
    private readonly bus: WorldCommandBus,
    private readonly repository: CommandRepository,
    private readonly clock: Clock,
    private readonly cursorSecret: string,
    private readonly simulationWakeAvailable: () => boolean = () => true,
  ) {}

  public async submit(
    actor: AuthenticatedActor,
    worldId: string,
    request: SubmitWorldCommand,
    requestId: string,
    recentCredential?: GovernanceRecentCredentialProof,
  ) {
    const startedAt = performance.now();
    const commandType = boundedCommandType(request.type);
    try {
      const outcome = await this.bus.submit(
        actor,
        worldId,
        request,
        requestId,
        this.clock.now(),
        recentCredential,
      );
      const rejectionCode =
        outcome.result.status === 'rejected' || outcome.result.status === 'failed'
          ? outcome.result.rejectionCode
          : 'none';
      telemetry.commandOutcomes.add(1, {
        command_type: commandType,
        outcome: outcome.result.status,
        rejection_code: rejectionCode,
      });
      telemetry.commandEvents.record(outcome.result.eventIds.length, {
        command_type: commandType,
        outcome: outcome.result.status,
      });
      if (
        rejectionCode === 'REVISION_CONFLICT' ||
        rejectionCode === 'WORLD_VERSION_CONFLICT' ||
        rejectionCode === 'AGGREGATE_VERSION_CONFLICT'
      ) {
        telemetry.commandConflicts.add(1, {
          command_type: commandType,
          rejection_code: rejectionCode,
        });
      }
      return outcome;
    } catch (error) {
      telemetry.commandOutcomes.add(1, {
        command_type: commandType,
        outcome: 'failed_before_result',
        rejection_code:
          error instanceof ApplicationError ? boundedCommandError(error.code) : 'INTERNAL',
      });
      throw error;
    } finally {
      telemetry.commandDuration.record(performance.now() - startedAt, {
        command_type: commandType,
      });
    }
  }

  public async command(
    actor: AuthenticatedActor,
    commandId: string,
  ): Promise<WorldCommandResultTransport> {
    const result = await this.repository.getCommand(actor.user.id, commandId);
    if (!result) this.notFound();
    return result;
  }

  public async runtimeHead(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<WorldRuntimeHeadTransport> {
    const result = await this.repository.getRuntimeHead(actor.user.id, worldId);
    if (!result) this.notFound();
    return result;
  }

  public async simulationClock(
    actor: AuthenticatedActor,
    worldId: string,
  ): Promise<SimulationClockViewTransport> {
    const result = await this.repository.getSimulationClock(actor.user.id, worldId);
    if (!result) this.notFound();
    return { ...result, degradedWake: !this.simulationWakeAvailable() };
  }

  public async scheduledAction(actor: AuthenticatedActor, worldId: string, scheduleId: string) {
    const result = await this.repository.getScheduledAction(actor.user.id, worldId, scheduleId);
    if (!result) this.notFound();
    return result;
  }

  public async schedule(
    actor: AuthenticatedActor,
    worldId: string,
    query: SimulationListQueryTransport,
  ): Promise<ScheduledActionPageTransport> {
    const result = await this.repository.listScheduledActions({
      actorId: actor.user.id,
      query,
      worldId,
    });
    if (!result) this.notFound();
    return result;
  }

  public async simulationBatches(
    actor: AuthenticatedActor,
    worldId: string,
    query: SimulationListQueryTransport,
  ): Promise<SimulationBatchPageTransport> {
    const result = await this.repository.listSimulationBatches({
      actorId: actor.user.id,
      query,
      worldId,
    });
    if (!result) this.notFound();
    return result;
  }

  public async history(
    actor: AuthenticatedActor,
    worldId: string,
    query: WorldHistoryQueryTransport,
  ): Promise<HistoryPage> {
    if (!(await this.repository.getRuntimeHead(actor.user.id, worldId))) this.notFound();
    const limit = Number(query.limit ?? 50);
    const filters = {
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
    };
    const filterHash = createHash('sha256').update(canonicalJson(filters)).digest('hex');
    const beforeLedgerSequence = query.cursor
      ? decodeHistoryCursor(query.cursor, worldId, filterHash, this.cursorSecret)
          .beforeLedgerSequence
      : undefined;
    const rows = await this.repository.listHistory({
      actorId: actor.user.id,
      ...(beforeLedgerSequence ? { beforeLedgerSequence } : {}),
      limit: limit + 1,
      platformAdmin: actor.user.platformRole === 'platform_admin',
      query: filters,
      worldId,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeHistoryCursor(
              {
                beforeLedgerSequence: last.ledgerSequence,
                filterHash,
                kind: 'world-history-v1',
                worldId,
              },
              this.cursorSecret,
            )
          : null,
    };
  }

  public async historyEntry(
    actor: AuthenticatedActor,
    worldId: string,
    ledgerSequence: string,
  ): Promise<WorldHistoryDetailTransport> {
    const result = await this.repository.getHistoryEntry(
      actor.user.id,
      actor.user.platformRole === 'platform_admin',
      worldId,
      ledgerSequence,
    );
    if (!result) this.notFound();
    return result;
  }

  private notFound(): never {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
}

function boundedCommandError(code: string): string {
  return new Set([
    'COMMAND_IN_PROGRESS',
    'IDEMPOTENCY_KEY_REUSED',
    'LEDGER_NOT_ANCHORED',
    'NOT_FOUND',
    'SERIALIZATION_RETRY_EXHAUSTED',
  ]).has(code)
    ? code
    : 'OTHER';
}

function boundedCommandType(type: string): string {
  return new Set([
    'AdvanceSimulationV1',
    'CancelScheduledActionV1',
    'ConfigureWorldClockV1',
    'PauseWorldClockV1',
    'RenameWorldEntityV1',
    'ScheduleWorldNoticeV1',
    'StartWorldClockV1',
  ]).has(type)
    ? type
    : 'unregistered';
}
