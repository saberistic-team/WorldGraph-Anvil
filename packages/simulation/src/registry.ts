import {
  AssessPeriodicTaxScheduledActionPayloadV1Schema,
  CertifyAndEnactProposalScheduledActionPayloadV1Schema,
  CertifyElectionScheduledActionPayloadV1Schema,
  CloseAndTallyElectionScheduledActionPayloadV1Schema,
  CloseAndTallyProposalScheduledActionPayloadV1Schema,
  CompleteProductionRunScheduledActionPayloadV1Schema,
  EmitWorldNoticePayloadV1Schema,
  ExpireMarketListingScheduledActionPayloadV1Schema,
  OpenElectionScheduledActionPayloadV1Schema,
  OpenProposalVotingScheduledActionPayloadV1Schema,
  SIMULATION_PRNG_ALGORITHM_VERSION,
  SIMULATION_PROCESS_REGISTRY_VERSION,
  SettlePayrollScheduledActionPayloadV1Schema,
  SimulationProcessContextV1Schema,
  createValidator,
  type AssessPeriodicTaxScheduledActionPayloadV1,
  type CertifyAndEnactProposalScheduledActionPayloadV1,
  type CertifyElectionScheduledActionPayloadV1,
  type CloseAndTallyElectionScheduledActionPayloadV1,
  type CloseAndTallyProposalScheduledActionPayloadV1,
  type CompleteProductionRunScheduledActionPayloadV1,
  type EmitWorldNoticePayloadV1,
  type ExpireMarketListingScheduledActionPayloadV1,
  type OpenElectionScheduledActionPayloadV1,
  type OpenProposalVotingScheduledActionPayloadV1,
  type ScheduledActionType,
  type SettlePayrollScheduledActionPayloadV1,
  type SimulationProcessContextV1,
  type SimulationProcessDescriptorV1,
  type SimulationProcessResultV1,
} from '@worldgraph/contracts';

import { validateProcessResultV1 } from './budgets.js';
import { SimulationDomainError } from './errors.js';
import { SimulationPrngV1, simulationScheduleProcessKeyV1 } from './prng.js';

const noticePayloadValidator = createValidator<EmitWorldNoticePayloadV1>(
  EmitWorldNoticePayloadV1Schema,
);
const productionPayloadValidator = createValidator<CompleteProductionRunScheduledActionPayloadV1>(
  CompleteProductionRunScheduledActionPayloadV1Schema,
);
const payrollPayloadValidator = createValidator<SettlePayrollScheduledActionPayloadV1>(
  SettlePayrollScheduledActionPayloadV1Schema,
);
const listingPayloadValidator = createValidator<ExpireMarketListingScheduledActionPayloadV1>(
  ExpireMarketListingScheduledActionPayloadV1Schema,
);
const taxPayloadValidator = createValidator<AssessPeriodicTaxScheduledActionPayloadV1>(
  AssessPeriodicTaxScheduledActionPayloadV1Schema,
);
const openProposalPayloadValidator = createValidator<OpenProposalVotingScheduledActionPayloadV1>(
  OpenProposalVotingScheduledActionPayloadV1Schema,
);
const closeProposalPayloadValidator =
  createValidator<CloseAndTallyProposalScheduledActionPayloadV1>(
    CloseAndTallyProposalScheduledActionPayloadV1Schema,
  );
const enactProposalPayloadValidator =
  createValidator<CertifyAndEnactProposalScheduledActionPayloadV1>(
    CertifyAndEnactProposalScheduledActionPayloadV1Schema,
  );
const openElectionPayloadValidator = createValidator<OpenElectionScheduledActionPayloadV1>(
  OpenElectionScheduledActionPayloadV1Schema,
);
const closeElectionPayloadValidator =
  createValidator<CloseAndTallyElectionScheduledActionPayloadV1>(
    CloseAndTallyElectionScheduledActionPayloadV1Schema,
  );
const certifyElectionPayloadValidator = createValidator<CertifyElectionScheduledActionPayloadV1>(
  CertifyElectionScheduledActionPayloadV1Schema,
);
const contextValidator = createValidator<SimulationProcessContextV1>(
  SimulationProcessContextV1Schema,
);

function descriptor(
  actionType: ScheduledActionType,
  payloadSchemaId: SimulationProcessDescriptorV1['payloadSchemaId'],
  authorityPolicy: SimulationProcessDescriptorV1['authorityPolicy'],
  maxEvents: number,
): SimulationProcessDescriptorV1 {
  const value: SimulationProcessDescriptorV1 = {
    actionSchemaVersion: 1,
    actionType,
    authorityPolicy,
    compatibility: {
      maximumActionSchemaVersion: 1,
      minimumActionSchemaVersion: 1,
      prngAlgorithmVersions: [SIMULATION_PRNG_ALGORITHM_VERSION],
    },
    maxEvents,
    maxSchedules: 0,
    payloadSchemaId,
    processSchemaVersion: 1,
    processType: actionType,
    processVersion: '1.0.0',
    registryVersion: SIMULATION_PROCESS_REGISTRY_VERSION,
    resultSchemaId: 'SimulationProcessResultV1',
  };
  Object.freeze(value.compatibility.prngAlgorithmVersions);
  Object.freeze(value.compatibility);
  return Object.freeze(value);
}

export const EMIT_WORLD_NOTICE_DESCRIPTOR_V1 = descriptor(
  'EmitWorldNoticeV1',
  'EmitWorldNoticePayloadV1',
  'creator_or_administrator',
  1,
);
export const COMPLETE_PRODUCTION_RUN_DESCRIPTOR_V1 = descriptor(
  'CompleteProductionRunV1',
  'CompleteProductionRunScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const SETTLE_PAYROLL_DESCRIPTOR_V1 = descriptor(
  'SettlePayrollV1',
  'SettlePayrollScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const EXPIRE_MARKET_LISTING_DESCRIPTOR_V1 = descriptor(
  'ExpireMarketListingV1',
  'ExpireMarketListingScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const ASSESS_PERIODIC_TAX_DESCRIPTOR_V1 = descriptor(
  'AssessPeriodicTaxV1',
  'AssessPeriodicTaxScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const OPEN_PROPOSAL_VOTING_DESCRIPTOR_V1 = descriptor(
  'OpenProposalVotingV1',
  'OpenProposalVotingScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const CLOSE_AND_TALLY_PROPOSAL_DESCRIPTOR_V1 = descriptor(
  'CloseAndTallyProposalV1',
  'CloseAndTallyProposalScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const CERTIFY_AND_ENACT_PROPOSAL_DESCRIPTOR_V1 = descriptor(
  'CertifyAndEnactProposalV1',
  'CertifyAndEnactProposalScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const OPEN_ELECTION_DESCRIPTOR_V1 = descriptor(
  'OpenElectionV1',
  'OpenElectionScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const CLOSE_AND_TALLY_ELECTION_DESCRIPTOR_V1 = descriptor(
  'CloseAndTallyElectionV1',
  'CloseAndTallyElectionScheduledActionPayloadV1',
  'system_scheduler',
  0,
);
export const CERTIFY_ELECTION_DESCRIPTOR_V1 = descriptor(
  'CertifyElectionV1',
  'CertifyElectionScheduledActionPayloadV1',
  'system_scheduler',
  0,
);

const descriptors: Readonly<Record<ScheduledActionType, SimulationProcessDescriptorV1>> =
  Object.freeze({
    AssessPeriodicTaxV1: ASSESS_PERIODIC_TAX_DESCRIPTOR_V1,
    CertifyAndEnactProposalV1: CERTIFY_AND_ENACT_PROPOSAL_DESCRIPTOR_V1,
    CertifyElectionV1: CERTIFY_ELECTION_DESCRIPTOR_V1,
    CloseAndTallyElectionV1: CLOSE_AND_TALLY_ELECTION_DESCRIPTOR_V1,
    CloseAndTallyProposalV1: CLOSE_AND_TALLY_PROPOSAL_DESCRIPTOR_V1,
    CompleteProductionRunV1: COMPLETE_PRODUCTION_RUN_DESCRIPTOR_V1,
    EmitWorldNoticeV1: EMIT_WORLD_NOTICE_DESCRIPTOR_V1,
    ExpireMarketListingV1: EXPIRE_MARKET_LISTING_DESCRIPTOR_V1,
    OpenElectionV1: OPEN_ELECTION_DESCRIPTOR_V1,
    OpenProposalVotingV1: OPEN_PROPOSAL_VOTING_DESCRIPTOR_V1,
    SettlePayrollV1: SETTLE_PAYROLL_DESCRIPTOR_V1,
  });

export interface RunSimulationProcessInputV1 {
  readonly actionSchemaVersion: number;
  readonly actionType: ScheduledActionType;
  readonly context: Readonly<SimulationProcessContextV1>;
  readonly payload: unknown;
  readonly processVersion: string;
}

export interface SimulationProcessHandlerInputV1<TPayload> {
  readonly context: Readonly<SimulationProcessContextV1>;
  readonly payload: Readonly<TPayload>;
  readonly prng: SimulationPrngV1;
}

export type SimulationProcessHandlerV1<TPayload> = (
  input: SimulationProcessHandlerInputV1<TPayload>,
) => SimulationProcessResultV1;

function immutableCopyV1<T>(input: T): Readonly<T> {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  const copy = structuredClone(input);
  freeze(copy);
  return copy;
}

export const emitWorldNoticeV1: SimulationProcessHandlerV1<EmitWorldNoticePayloadV1> = ({
  context,
  payload,
}) => ({
  events: [
    {
      eventSchemaVersion: 1,
      eventType: 'WorldNoticeEmittedV1',
      payload: {
        emittedAtTick: context.tick,
        text: payload.text,
        visibility: payload.visibility,
      },
    },
  ],
  processSchemaVersion: 1,
  schedules: [],
});

/**
 * Commerce processes commit only the deterministic scheduler trigger. A
 * durable worker bridge subsequently submits the target-ID-only domain
 * command through the ordinary economy command boundary.
 */
function commerceDispatchTriggerV1(): SimulationProcessResultV1 {
  return { events: [], processSchemaVersion: 1, schedules: [] };
}

export function runSimulationProcessV1(
  input: RunSimulationProcessInputV1,
): SimulationProcessResultV1 {
  const resolved = resolveSimulationProcessDescriptorV1(
    input.actionType,
    input.processVersion,
    input.actionSchemaVersion,
  );
  if (!payloadMatches(input.actionType, input.payload)) {
    throw new SimulationDomainError(
      'SIMULATION_HANDLER_FAILED',
      'Scheduled action payload does not match the registered schema.',
    );
  }
  if (!contextValidator.is(input.context)) {
    throw new SimulationDomainError(
      'SIMULATION_HANDLER_FAILED',
      'Simulation context does not match the registered schema.',
    );
  }
  if (
    input.context.stableProcessKey !==
    simulationScheduleProcessKeyV1(input.context.scheduleSequence)
  ) {
    throw new SimulationDomainError(
      'SIMULATION_HANDLER_FAILED',
      'Simulation context stable process key does not match its schedule sequence.',
    );
  }
  const prng = new SimulationPrngV1({
    processType: resolved.processType,
    processVersion: resolved.processVersion,
    stableProcessKey: input.context.stableProcessKey,
    tick: input.context.tick,
    worldSeed: input.context.worldSeed,
  });
  if (input.actionType !== 'EmitWorldNoticeV1') {
    return validateProcessResultV1(commerceDispatchTriggerV1());
  }
  return validateProcessResultV1(
    emitWorldNoticeV1({
      context: immutableCopyV1(input.context),
      payload: immutableCopyV1(input.payload as EmitWorldNoticePayloadV1),
      prng,
    }),
  );
}

function payloadMatches(actionType: ScheduledActionType, payload: unknown): boolean {
  switch (actionType) {
    case 'EmitWorldNoticeV1':
      return noticePayloadValidator.is(payload);
    case 'CompleteProductionRunV1':
      return productionPayloadValidator.is(payload);
    case 'SettlePayrollV1':
      return payrollPayloadValidator.is(payload);
    case 'ExpireMarketListingV1':
      return listingPayloadValidator.is(payload);
    case 'AssessPeriodicTaxV1':
      return taxPayloadValidator.is(payload);
    case 'OpenProposalVotingV1':
      return openProposalPayloadValidator.is(payload);
    case 'CloseAndTallyProposalV1':
      return closeProposalPayloadValidator.is(payload);
    case 'CertifyAndEnactProposalV1':
      return enactProposalPayloadValidator.is(payload);
    case 'OpenElectionV1':
      return openElectionPayloadValidator.is(payload);
    case 'CloseAndTallyElectionV1':
      return closeElectionPayloadValidator.is(payload);
    case 'CertifyElectionV1':
      return certifyElectionPayloadValidator.is(payload);
  }
}

export function simulationProcessDescriptorsV1(): readonly SimulationProcessDescriptorV1[] {
  return [
    EMIT_WORLD_NOTICE_DESCRIPTOR_V1,
    COMPLETE_PRODUCTION_RUN_DESCRIPTOR_V1,
    SETTLE_PAYROLL_DESCRIPTOR_V1,
    EXPIRE_MARKET_LISTING_DESCRIPTOR_V1,
    ASSESS_PERIODIC_TAX_DESCRIPTOR_V1,
    OPEN_PROPOSAL_VOTING_DESCRIPTOR_V1,
    CLOSE_AND_TALLY_PROPOSAL_DESCRIPTOR_V1,
    CERTIFY_AND_ENACT_PROPOSAL_DESCRIPTOR_V1,
    OPEN_ELECTION_DESCRIPTOR_V1,
    CLOSE_AND_TALLY_ELECTION_DESCRIPTOR_V1,
    CERTIFY_ELECTION_DESCRIPTOR_V1,
  ];
}

export function resolveSimulationProcessDescriptorV1(
  actionType: string,
  processVersion: string,
  actionSchemaVersion: number,
): SimulationProcessDescriptorV1 {
  const resolved = descriptors[actionType as ScheduledActionType];
  if (!resolved) {
    throw new SimulationDomainError(
      'SIMULATION_PROCESS_UNKNOWN',
      'Scheduled action is not in the code-owned process registry.',
    );
  }
  if (processVersion !== resolved.processVersion) {
    throw new SimulationDomainError(
      'SIMULATION_PROCESS_VERSION_MISMATCH',
      'Scheduled action process version is unsupported.',
    );
  }
  if (
    !Number.isSafeInteger(actionSchemaVersion) ||
    actionSchemaVersion < resolved.compatibility.minimumActionSchemaVersion ||
    actionSchemaVersion > resolved.compatibility.maximumActionSchemaVersion
  ) {
    throw new SimulationDomainError(
      'SIMULATION_PROCESS_VERSION_MISMATCH',
      'Scheduled action schema version is unsupported.',
    );
  }
  return resolved;
}
