import type {
  CommerceScheduledActionType,
  IdGenerator,
  ScheduledActionV1,
} from '@worldgraph/contracts';

export const ECONOMY_OFFER_EXPIRY_ACTOR_ID = 'worldgraph:economy-offer-reconciler' as const;
export const ECONOMY_OFFER_EXPIRY_AUTHORIZATION_RULE_ID = 'system.economy.offer_expire' as const;
export const COMMERCE_SCHEDULER_ACTOR_ID = 'worldgraph:commerce-scheduler' as const;
export const COMMERCE_SCHEDULER_AUTHORIZATION_RULE_ID =
  'system.commerce.scheduler.execute' as const;

interface CommerceScheduledCommandRequestBase {
  commandId: string;
  completedEventId: string;
  dueTick: string;
  idempotencyKey: string;
  scheduleSequence: string;
  scheduledActionId: string;
  worldId: string;
}

export type CommerceScheduledCommandRequest = CommerceScheduledCommandRequestBase &
  (
    | {
        actionType: 'CompleteProductionRunV1';
        payload: Extract<ScheduledActionV1, { actionType: 'CompleteProductionRunV1' }>['payload'];
      }
    | {
        actionType: 'SettlePayrollV1';
        payload: Extract<ScheduledActionV1, { actionType: 'SettlePayrollV1' }>['payload'];
      }
    | {
        actionType: 'ExpireMarketListingV1';
        payload: Extract<ScheduledActionV1, { actionType: 'ExpireMarketListingV1' }>['payload'];
      }
    | {
        actionType: 'AssessPeriodicTaxV1';
        payload: Extract<ScheduledActionV1, { actionType: 'AssessPeriodicTaxV1' }>['payload'];
      }
  );

export type CommerceScheduledCommandResult =
  | { resultingStateRevision: string; status: 'applied' }
  | { status: 'already_terminal' | 'conflict' | 'not_ready' };

/**
 * System-only target-ID command boundary. Implementations derive all mutable
 * state, money, quantities, policy, and the authoritative current tick.
 */
export interface CommerceScheduledCommandPort {
  execute(request: CommerceScheduledCommandRequest): Promise<CommerceScheduledCommandResult>;
}

export interface PostgresCommerceScheduledCommandOptions {
  disabledTaxPolicyIds?: readonly string[];
  ids: IdGenerator;
  maximumSerializationAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
}

export const COMMERCE_SCHEDULED_COMMAND_TYPES = [
  'CompleteProductionRunV1',
  'SettlePayrollV1',
  'ExpireMarketListingV1',
  'AssessPeriodicTaxV1',
] as const satisfies readonly CommerceScheduledActionType[];

export interface ExpireAssetTransferOfferRequest {
  commandId: string;
  eventId: string;
  expectedOfferVersion: string;
  expectedStateRevision: string;
  expectedTick: string;
  expectedWorldVersion: string;
  idempotencyKey: string;
  offerId: string;
  worldId: string;
}

export type ExpireAssetTransferOfferResult =
  | { resultingStateRevision: string; status: 'expired' }
  | { status: 'already_terminal' | 'conflict' | 'not_due' };

export interface EconomyOfferExpiryCommandPort {
  expire(request: ExpireAssetTransferOfferRequest): Promise<ExpireAssetTransferOfferResult>;
}

export interface PostgresEconomyOfferExpiryCommandOptions {
  ids: IdGenerator;
  maximumSerializationAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
}
