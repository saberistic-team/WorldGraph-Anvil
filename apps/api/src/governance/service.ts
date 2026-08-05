import { createHmac } from 'node:crypto';

import type {
  GovernanceAuditViewV1,
  GovernanceCandidacyViewV1,
  GovernanceElectionViewV1,
  GovernanceInstitutionViewV1,
  GovernanceLawViewV1,
  GovernanceOfficeTermViewV1,
  GovernanceOfficeViewV1,
  GovernanceProposalViewV1,
} from '@worldgraph/contracts';

import { ApplicationError } from '../application/errors.js';
import type { AuthenticatedActor } from '../identity/service.js';
import type { GovernancePageQuery, GovernanceStreamBatchV1 } from './api-contracts.js';
import type { GovernanceCapabilityService } from './capabilities.js';
import {
  decodeGovernanceCursor,
  encodeGovernanceCursor,
  type GovernanceCursorResource,
} from './cursor.js';
import type { GovernanceReadPage, PostgresGovernanceReadRepository } from './repository.js';

export class GovernanceReadService {
  public constructor(
    private readonly repository: PostgresGovernanceReadRepository,
    private readonly cursorSecret: string,
    private readonly capabilityService?: GovernanceCapabilityService,
  ) {}

  public capabilities(actor: AuthenticatedActor, worldId: string) {
    if (!this.capabilityService) {
      throw new ApplicationError(
        'GOVERNANCE_CAPABILITY_UNAVAILABLE',
        'Governance capability projection is unavailable.',
        503,
      );
    }
    return this.capabilityService.capabilities(actor, worldId);
  }

  public async charter(actor: AuthenticatedActor, worldId: string) {
    return required(await this.repository.charter(actor.user.id, worldId));
  }

  public institutions(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceInstitutionViewV1>(
      actor,
      worldId,
      'institutions',
      query,
      (after, limit) =>
        this.repository.institutions({
          actorId: actor.user.id,
          after,
          limit,
          worldId,
        }),
    );
  }

  public laws(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceLawViewV1>(actor, worldId, 'laws', query, (after, limit) =>
      this.repository.laws({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public offices(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceOfficeViewV1>(actor, worldId, 'offices', query, (after, limit) =>
      this.repository.offices({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public terms(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceOfficeTermViewV1>(actor, worldId, 'terms', query, (after, limit) =>
      this.repository.terms({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public proposals(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceProposalViewV1>(actor, worldId, 'proposals', query, (after, limit) =>
      this.repository.proposals({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public elections(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceElectionViewV1>(actor, worldId, 'elections', query, (after, limit) =>
      this.repository.elections({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public candidacies(
    actor: AuthenticatedActor,
    worldId: string,
    electionId: string,
    query: GovernancePageQuery,
  ) {
    return this.page<GovernanceCandidacyViewV1>(
      actor,
      worldId,
      'candidacies',
      query,
      (after, limit) =>
        this.repository.candidacies({
          actorId: actor.user.id,
          after,
          electionId,
          limit,
          worldId,
        }),
    );
  }

  public audit(actor: AuthenticatedActor, worldId: string, query: GovernancePageQuery) {
    return this.page<GovernanceAuditViewV1>(actor, worldId, 'audit', query, (after, limit) =>
      this.repository.audit({ actorId: actor.user.id, after, limit, worldId }),
    );
  }

  public async proposalReceipt(actor: AuthenticatedActor, worldId: string, proposalId: string) {
    return required(await this.repository.proposalReceipt(actor.user.id, worldId, proposalId));
  }

  public async proposalResult(actor: AuthenticatedActor, worldId: string, proposalId: string) {
    return required(await this.repository.proposalResult(actor.user.id, worldId, proposalId));
  }

  public async electionReceipt(actor: AuthenticatedActor, worldId: string, electionId: string) {
    return required(await this.repository.electionReceipt(actor.user.id, worldId, electionId));
  }

  public async electionResult(actor: AuthenticatedActor, worldId: string, electionId: string) {
    return required(await this.repository.electionResult(actor.user.id, worldId, electionId));
  }

  public async streamBatch(
    actor: AuthenticatedActor,
    worldId: string,
    after: string,
  ): Promise<GovernanceStreamBatchV1> {
    const events = required(await this.repository.events(actor.user.id, worldId, after, 100));
    return {
      events,
      nextCursor: events.at(-1)?.eventCursor ?? after,
    };
  }

  private async page<T>(
    actor: AuthenticatedActor,
    worldId: string,
    resource: GovernanceCursorResource,
    query: GovernancePageQuery,
    read: (after: string | null, limit: number) => Promise<GovernanceReadPage<T> | null>,
  ) {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const actorScopeHash = this.actorScopeHash(actor.user.id);
    const after = query.cursor
      ? decodeGovernanceCursor(
          query.cursor,
          { actorScopeHash, resource, worldId },
          this.cursorSecret,
        ).position
      : null;
    const result = required(await read(after, limit + 1));
    const hasMore = result.items.length > limit;
    const items = result.items.slice(0, limit);
    const positions = result.positions.slice(0, limit);
    const position = positions.at(-1);
    return {
      items,
      page: {
        evaluatedAtTick: result.evaluatedAtTick,
        nextCursor:
          hasMore && position
            ? encodeGovernanceCursor(
                {
                  actorScopeHash,
                  kind: 'governance-page-v1',
                  position,
                  resource,
                  worldId,
                },
                this.cursorSecret,
              )
            : null,
        projectionRevision: result.projectionRevision,
      },
    };
  }

  private actorScopeHash(actorId: string): string {
    return createHmac('sha256', this.cursorSecret)
      .update(`worldgraph-governance-cursor-v1:${actorId}`)
      .digest('hex');
  }
}

function required<T>(value: T | null): T {
  if (value === null) {
    throw new ApplicationError('NOT_FOUND', 'The requested resource was not found.', 404);
  }
  return value;
}
