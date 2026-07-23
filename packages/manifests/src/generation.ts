import {
  MANIFEST_GENERATOR_SCHEMA_VERSION,
  MANIFEST_PROMPT_TEMPLATE_VERSION,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VALIDATOR_VERSION,
  ManifestGenerationEnvelopeV1Schema,
  canonicalizeJson,
  type JsonValue,
  type ManifestDiagnostic,
  type ManifestGenerationEnvelopeV1,
} from '@worldgraph/contracts';

import { normalizeManifestPrompt, sha256 } from './canonical.js';
import type { ManifestCatalogSnapshot } from './catalog.js';
import {
  createDeterministicFallback,
  type DeterministicFallbackInput,
  type DeterministicFallbackResult,
} from './fallback.js';
import { validateManifestGenerationEnvelope, type ManifestValidationResult } from './validation.js';
import { parseSafeYaml } from './yaml.js';

export interface ManifestProviderConfiguration {
  configurationId: string;
  enabled: boolean;
  model: string;
  modelCapabilities: {
    network: false;
    tools: false;
  };
  provider: string;
}

interface ManifestProviderRequestBase {
  catalog: ManifestCatalogSnapshot;
  generatorSchemaVersion: typeof MANIFEST_GENERATOR_SCHEMA_VERSION;
  inputHash: string;
  manifestSchemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  maxCostMicrounits: number;
  maxInputTokens: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  modelCapabilities: {
    network: false;
    tools: false;
  };
  normalizedPrompt: string;
  outputSchema: typeof ManifestGenerationEnvelopeV1Schema;
  promptTemplateVersion: typeof MANIFEST_PROMPT_TEMPLATE_VERSION;
  seed: string;
  validatorVersion: typeof MANIFEST_VALIDATOR_VERSION;
}

export type ManifestProviderRequest =
  | (ManifestProviderRequestBase & { kind: 'generate' })
  | (ManifestProviderRequestBase & {
      kind: 'repair';
      priorCandidate: JsonValue;
      validationErrors: readonly {
        code: string;
        message: string;
        pointer: string;
      }[];
    });

export interface ManifestProviderResponse {
  costMicrounits: number;
  inputTokens: number;
  model: string;
  output: string;
  outputTokens: number;
  provider: string;
}

export interface ManifestGenerationProvider {
  readonly configuration: ManifestProviderConfiguration;
  generate(
    request: ManifestProviderRequest,
    signal: AbortSignal,
  ): Promise<ManifestProviderResponse>;
}

export interface ManifestGenerationPolicy {
  circuitCooldownMs: number;
  circuitFailureThreshold: number;
  maxCostMicrounits: number;
  maxCostMicrounitsPerCall: number;
  maxInputTokens: number;
  maxInputTokensPerCall: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  maxProviderCalls: number;
  maxRepairAttempts: number;
  maxTransientRetries: number;
  providerTimeoutMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

export const DEFAULT_MANIFEST_GENERATION_POLICY: ManifestGenerationPolicy = {
  circuitCooldownMs: 60_000,
  circuitFailureThreshold: 3,
  maxCostMicrounits: 5_000_000,
  maxCostMicrounitsPerCall: 1_000_000,
  maxInputTokens: 16_000,
  maxInputTokensPerCall: 4_000,
  maxOutputBytes: 131_072,
  maxOutputTokens: 16_000,
  maxProviderCalls: 6,
  maxRepairAttempts: 2,
  maxTransientRetries: 1,
  providerTimeoutMs: 30_000,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 2_000,
};

export type ManifestProviderFailureCode =
  | 'PROVIDER_CIRCUIT_OPEN'
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_TRANSIENT_FAILURE'
  | 'PROVIDER_PERMANENT_FAILURE'
  | 'PROVIDER_OUTPUT_INVALID'
  | 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'
  | 'PROVIDER_TOKEN_LIMIT_EXCEEDED'
  | 'PROVIDER_COST_LIMIT_EXCEEDED'
  | 'PROVIDER_CALL_LIMIT_EXCEEDED';

export interface ManifestGenerationDurableUsage {
  costMicrounits: number;
  inputTokens: number;
  outputTokens: number;
  providerCalls: number;
  repairAttempts: number;
}

export interface ManifestProviderCallReservation {
  id: string;
  maxCostMicrounits: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface ManifestProviderCallReservationRequest {
  kind: ManifestProviderRequest['kind'];
  maxCostMicrounits: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  model: string;
  provider: string;
  providerConfigurationId: string;
}

export interface ManifestProviderCallSettlement {
  costMicrounits: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider accounting is deliberately injected into the pure orchestration
 * package. Production supplies PostgreSQL-backed hooks; unit callers get a
 * volatile implementation with identical allowance semantics.
 */
export interface ManifestGenerationAccounting {
  initialUsage: ManifestGenerationDurableUsage;
  releaseProviderCall(reservation: ManifestProviderCallReservation): Promise<void>;
  reserveProviderCall(
    request: ManifestProviderCallReservationRequest,
  ): Promise<ManifestProviderCallReservation | null>;
  settleProviderCall(
    reservation: ManifestProviderCallReservation,
    settlement: ManifestProviderCallSettlement,
  ): Promise<void>;
}

export class ManifestProviderError extends Error {
  public constructor(
    public readonly code: ManifestProviderFailureCode,
    public readonly transient: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ManifestProviderError';
  }
}

export class ManifestGenerationCancelledError extends Error {
  public readonly code = 'MANIFEST_GENERATION_CANCELLED' as const;

  public constructor() {
    super('Manifest generation was cancelled.');
    this.name = 'ManifestGenerationCancelledError';
  }
}

export class ProviderEnvelopeParseError extends Error {
  public readonly code = 'PROVIDER_OUTPUT_INVALID' as const;

  public constructor(
    public readonly diagnostics: readonly ManifestDiagnostic[],
    public readonly candidate: JsonValue | null,
  ) {
    super('Provider output did not satisfy the manifest generation contract.');
    this.name = 'ProviderEnvelopeParseError';
  }
}

export interface ParsedProviderEnvelope {
  envelope: ManifestGenerationEnvelopeV1;
  validation: ManifestValidationResult;
}

function syntheticDiagnostic(code: string, message: string): ManifestDiagnostic {
  return {
    code,
    fixes: [],
    location: null,
    message,
    pointer: '',
    relatedPointers: [],
    severity: 'error',
  };
}

function isBoundedIdentifier(value: string, maximum: number): boolean {
  if (value.length < 1 || value.length > maximum) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

export function normalizeProviderEnvelopeProvenance(input: {
  catalog: ManifestCatalogSnapshot;
  configuration: ManifestProviderConfiguration;
  envelope: ManifestGenerationEnvelopeV1;
  inputHash: string;
  normalizedPrompt: string;
}): ManifestGenerationEnvelopeV1 {
  const primitiveIdentities = new Map(
    input.envelope.manifest.primitiveRefs.map((primitive) => [
      `${primitive.key}@${primitive.version}`,
      primitive,
    ]),
  );
  const promptHash = sha256(input.normalizedPrompt);
  const modelHash = sha256(
    `${input.configuration.configurationId}\u0000${input.configuration.provider}\u0000${input.configuration.model}\u0000${input.inputHash}`,
  );
  const provenance: ManifestGenerationEnvelopeV1['provenance'] = [];
  for (const entry of input.envelope.provenance) {
    if (entry.sourceType === 'fallback' || entry.sourceType === 'manual') {
      throw new ManifestProviderError(
        'PROVIDER_OUTPUT_INVALID',
        false,
        'Provider provenance claimed a forbidden authority source.',
      );
    }
    if (entry.sourceType === 'primitive') {
      const primitive = primitiveIdentities.get(entry.sourceRef);
      if (!primitive || primitive.contentHash !== entry.sourceHash) {
        throw new ManifestProviderError(
          'PROVIDER_OUTPUT_INVALID',
          false,
          'Provider provenance did not match an exact selected primitive.',
        );
      }
      provenance.push(entry);
    } else if (entry.sourceType === 'prompt') {
      provenance.push({
        ...entry,
        sourceHash: promptHash,
        sourceRef: `prompt:${promptHash.slice(0, 32)}`,
      });
    } else {
      provenance.push({
        ...entry,
        sourceHash: modelHash,
        sourceRef: `model:${modelHash.slice(0, 32)}`,
      });
    }
  }
  provenance.push(
    {
      pointer: '',
      sourceHash: promptHash,
      sourceRef: `prompt:${promptHash.slice(0, 32)}`,
      sourceType: 'prompt',
    },
    {
      pointer: '',
      sourceHash: modelHash,
      sourceRef: `model:${modelHash.slice(0, 32)}`,
      sourceType: 'model',
    },
    ...input.envelope.manifest.primitiveRefs.map((primitive, index) => ({
      pointer: `/primitiveRefs/${index}`,
      sourceHash: primitive.contentHash,
      sourceRef: `${primitive.key}@${primitive.version}`,
      sourceType: 'primitive' as const,
    })),
  );
  const unique = new Map<string, ManifestGenerationEnvelopeV1['provenance'][number]>();
  for (const entry of provenance) {
    unique.set(`${entry.pointer}\u0000${entry.sourceType}\u0000${entry.sourceRef}`, entry);
  }
  return {
    ...input.envelope,
    provenance: [...unique.values()].sort((left, right) => {
      const leftKey = `${left.pointer}\u0000${left.sourceType}\u0000${left.sourceRef}`;
      const rightKey = `${right.pointer}\u0000${right.sourceType}\u0000${right.sourceRef}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  };
}

export function parseProviderEnvelope(
  output: string,
  catalog: ManifestCatalogSnapshot,
  maxOutputBytes = DEFAULT_MANIFEST_GENERATION_POLICY.maxOutputBytes,
): ParsedProviderEnvelope {
  if (new TextEncoder().encode(output).byteLength > maxOutputBytes) {
    throw new ProviderEnvelopeParseError(
      [syntheticDiagnostic('PROVIDER_OUTPUT_LIMIT_EXCEEDED', 'Provider output exceeds its limit.')],
      null,
    );
  }
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new ProviderEnvelopeParseError(
      [syntheticDiagnostic('PROVIDER_OUTPUT_NOT_JSON', 'Provider output must be one JSON object.')],
      null,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new ProviderEnvelopeParseError(
      [syntheticDiagnostic('PROVIDER_OUTPUT_NOT_JSON', 'Provider output must be valid JSON.')],
      null,
    );
  }
  const duplicateCheck = parseSafeYaml(trimmed);
  if (!duplicateCheck.ok) {
    throw new ProviderEnvelopeParseError(
      duplicateCheck.issues.map((entry) =>
        syntheticDiagnostic(
          entry.code === 'YAML_DUPLICATE_KEY'
            ? 'PROVIDER_OUTPUT_DUPLICATE_KEY'
            : 'PROVIDER_OUTPUT_NOT_JSON',
          'Provider JSON contains a duplicate key or unsupported value.',
        ),
      ),
      null,
    );
  }
  let candidate: JsonValue;
  try {
    candidate = canonicalizeJson(parsed);
  } catch {
    throw new ProviderEnvelopeParseError(
      [
        syntheticDiagnostic(
          'PROVIDER_OUTPUT_NON_JSON_VALUE',
          'Provider output is not bounded JSON.',
        ),
      ],
      null,
    );
  }
  const validation = validateManifestGenerationEnvelope(candidate, catalog);
  if (!validation.valid) {
    throw new ProviderEnvelopeParseError(validation.diagnostics, candidate);
  }
  return { envelope: candidate as ManifestGenerationEnvelopeV1, validation };
}

interface CircuitState {
  consecutiveFailures: number;
  openUntilMs: number;
}

export interface ManifestCircuitSnapshot {
  consecutiveFailures: number;
  open: boolean;
  openUntilMs: number;
}

export interface ManifestGenerationOrchestratorOptions {
  fallbackFactory?: (input: DeterministicFallbackInput) => DeterministicFallbackResult;
  now?: () => number;
  policy?: Partial<ManifestGenerationPolicy>;
  random?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ManifestGenerationOrchestratorInput {
  catalog: ManifestCatalogSnapshot;
  expectedParentContentHash?: string | null;
  parentRevisionId?: string | null;
  prompt: string;
  seed?: string;
  signal?: AbortSignal;
}

export type ManifestGenerationStageCallback = (
  stage: 'fallback' | 'generation' | 'repair' | 'validation',
) => Promise<void> | void;

export interface ManifestGenerationEngine {
  generate(
    input: Omit<ManifestGenerationOrchestratorInput, 'signal'>,
    signal: AbortSignal,
    onStage?: ManifestGenerationStageCallback,
    accounting?: ManifestGenerationAccounting,
  ): Promise<ManifestGenerationOutcome>;
}

export interface ManifestGenerationOutcome {
  catalogSnapshotHash: string;
  contentHash: string;
  costMicrounits: number;
  envelope: ManifestGenerationEnvelopeV1;
  failures: readonly ManifestProviderFailureCode[];
  inputHash: string;
  inputTokens: number;
  mode: 'fallback' | 'provider';
  model: string | null;
  outputTokens: number;
  provider: string | null;
  providerConfigurationId: string | null;
  providerCalls: number;
  repairAttempts: number;
  resolvedInputHash: string;
  seed: string;
  latencyMs: number;
}

class ManifestStageCallbackError extends Error {
  public constructor() {
    super('Manifest generation stage callback failed.');
    this.name = 'ManifestStageCallbackError';
  }
}

class ManifestAccountingError extends Error {
  public constructor(errorCause: unknown) {
    super('Manifest provider accounting failed.', { cause: errorCause });
    this.name = 'ManifestAccountingError';
  }
}

function emptyAccounting(): ManifestGenerationAccounting {
  let sequence = 0;
  return {
    initialUsage: {
      costMicrounits: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerCalls: 0,
      repairAttempts: 0,
    },
    releaseProviderCall: async () => undefined,
    reserveProviderCall: async (request) => ({
      id: `volatile-provider-call-${(sequence += 1)}`,
      maxCostMicrounits: request.maxCostMicrounits,
      maxInputTokens: request.maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
    }),
    settleProviderCall: async () => undefined,
  };
}

function assertDurableUsage(usage: ManifestGenerationDurableUsage): void {
  const nonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  if (
    !nonnegativeInteger(usage.costMicrounits) ||
    !nonnegativeInteger(usage.inputTokens) ||
    !nonnegativeInteger(usage.outputTokens) ||
    !nonnegativeInteger(usage.providerCalls) ||
    !nonnegativeInteger(usage.repairAttempts) ||
    usage.repairAttempts > 2
  ) {
    throw new ManifestAccountingError(new Error('MANIFEST_DURABLE_USAGE_INVALID'));
  }
}

function validatePolicy(policy: ManifestGenerationPolicy): void {
  const integerIn = (value: number, minimum: number, maximum: number): boolean =>
    Number.isInteger(value) && value >= minimum && value <= maximum;
  if (!integerIn(policy.maxRepairAttempts, 0, 2))
    throw new RangeError('maxRepairAttempts must be 0..2.');
  if (!integerIn(policy.maxProviderCalls, 1, 9))
    throw new RangeError('maxProviderCalls must be 1..9.');
  if (!integerIn(policy.maxTransientRetries, 0, 2))
    throw new RangeError('maxTransientRetries must be 0..2.');
  if (!integerIn(policy.circuitFailureThreshold, 1, 20))
    throw new RangeError('circuitFailureThreshold must be 1..20.');
  if (!integerIn(policy.providerTimeoutMs, 100, 120_000))
    throw new RangeError('providerTimeoutMs must be 100..120000.');
  if (!integerIn(policy.maxOutputBytes, 1_024, 131_072))
    throw new RangeError('maxOutputBytes must be 1024..131072.');
  if (
    !integerIn(policy.maxInputTokens, 1, 100_000) ||
    !integerIn(policy.maxOutputTokens, 1, 100_000)
  )
    throw new RangeError('Token budgets must be bounded positive integers.');
  if (
    !integerIn(policy.maxInputTokensPerCall, 1, 100_000) ||
    policy.maxInputTokensPerCall > policy.maxInputTokens
  ) {
    throw new RangeError('maxInputTokensPerCall must fit the run input-token budget.');
  }
  if (!integerIn(policy.maxCostMicrounits, 0, 2_147_483_647))
    throw new RangeError('maxCostMicrounits is outside supported bounds.');
  if (
    !integerIn(policy.maxCostMicrounitsPerCall, 0, 2_147_483_647) ||
    policy.maxCostMicrounitsPerCall > policy.maxCostMicrounits
  ) {
    throw new RangeError('maxCostMicrounitsPerCall must fit the run cost budget.');
  }
  if (!integerIn(policy.circuitCooldownMs, 100, 86_400_000))
    throw new RangeError('circuitCooldownMs is outside supported bounds.');
  if (
    !integerIn(policy.retryBaseDelayMs, 0, 60_000) ||
    !integerIn(policy.retryMaxDelayMs, policy.retryBaseDelayMs, 60_000)
  ) {
    throw new RangeError('Retry delay policy is invalid.');
  }
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ManifestGenerationCancelledError());
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new ManifestGenerationCancelledError());
      },
      { once: true },
    );
  });
}

export class ManifestGenerationOrchestrator {
  readonly #circuits = new Map<string, CircuitState>();
  readonly #fallbackFactory: (input: DeterministicFallbackInput) => DeterministicFallbackResult;
  readonly #now: () => number;
  readonly #policy: ManifestGenerationPolicy;
  readonly #random: () => number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(options: ManifestGenerationOrchestratorOptions = {}) {
    const merged = { ...DEFAULT_MANIFEST_GENERATION_POLICY, ...options.policy };
    this.#policy = {
      ...merged,
      maxCostMicrounitsPerCall:
        options.policy?.maxCostMicrounitsPerCall ??
        Math.min(merged.maxCostMicrounitsPerCall, merged.maxCostMicrounits),
    };
    validatePolicy(this.#policy);
    this.#fallbackFactory = options.fallbackFactory ?? createDeterministicFallback;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#wait = options.wait ?? defaultWait;
  }

  public circuitSnapshot(configurationId: string): ManifestCircuitSnapshot {
    const state = this.#circuits.get(configurationId) ?? { consecutiveFailures: 0, openUntilMs: 0 };
    return {
      consecutiveFailures: state.consecutiveFailures,
      open: state.openUntilMs > this.#now(),
      openUntilMs: state.openUntilMs,
    };
  }

  public async generate(
    input: ManifestGenerationOrchestratorInput,
    provider: ManifestGenerationProvider,
    onStage?: ManifestGenerationStageCallback,
    accounting: ManifestGenerationAccounting = emptyAccounting(),
  ): Promise<ManifestGenerationOutcome> {
    const startedAtMs = this.#now();
    if (input.signal?.aborted) throw new ManifestGenerationCancelledError();
    assertDurableUsage(accounting.initialUsage);
    const configuration = provider.configuration;
    const fallback = this.#fallbackFactory({
      ...input,
      providerConfigurationId: configuration.configurationId,
    });
    const safeConfiguration =
      isBoundedIdentifier(configuration.configurationId, 120) &&
      isBoundedIdentifier(configuration.provider, 120) &&
      isBoundedIdentifier(configuration.model, 160);
    const failures: ManifestProviderFailureCode[] = [];
    const totals = {
      costMicrounits: accounting.initialUsage.costMicrounits,
      inputTokens: accounting.initialUsage.inputTokens,
      outputTokens: accounting.initialUsage.outputTokens,
      providerCalls: accounting.initialUsage.providerCalls,
    };
    const fallbackOutcome = (
      repairAttempts = accounting.initialUsage.repairAttempts,
    ): ManifestGenerationOutcome => ({
      catalogSnapshotHash: fallback.catalogSnapshotHash,
      contentHash: fallback.contentHash,
      costMicrounits: totals.costMicrounits,
      envelope: fallback.envelope,
      failures,
      inputHash: fallback.requestHash,
      inputTokens: totals.inputTokens,
      latencyMs: Math.max(0, this.#now() - startedAtMs),
      mode: 'fallback',
      model: safeConfiguration ? configuration.model : 'city-state-template-v1',
      outputTokens: totals.outputTokens,
      provider: safeConfiguration ? configuration.provider : 'worldgraph-fallback',
      providerConfigurationId: safeConfiguration
        ? configuration.configurationId
        : 'deterministic-fallback-v1',
      providerCalls: totals.providerCalls,
      repairAttempts,
      resolvedInputHash: fallback.resolvedInputHash,
      seed: fallback.seed,
    });
    const emitStage = async (
      stage: 'fallback' | 'generation' | 'repair' | 'validation',
    ): Promise<void> => {
      try {
        await onStage?.(stage);
      } catch {
        throw new ManifestStageCallbackError();
      }
    };
    if (!safeConfiguration) {
      failures.push('PROVIDER_PERMANENT_FAILURE');
      await emitStage('fallback');
      return fallbackOutcome();
    }
    if (!configuration.enabled) {
      failures.push('PROVIDER_DISABLED');
      await emitStage('fallback');
      return fallbackOutcome();
    }
    if (configuration.modelCapabilities.network || configuration.modelCapabilities.tools) {
      failures.push('PROVIDER_PERMANENT_FAILURE');
      await emitStage('fallback');
      return fallbackOutcome();
    }
    const circuit = this.#circuits.get(configuration.configurationId) ?? {
      consecutiveFailures: 0,
      openUntilMs: 0,
    };
    this.#circuits.set(configuration.configurationId, circuit);
    if (circuit.openUntilMs > this.#now()) {
      failures.push('PROVIDER_CIRCUIT_OPEN');
      await emitStage('fallback');
      return fallbackOutcome();
    }
    if (circuit.openUntilMs !== 0) {
      circuit.openUntilMs = 0;
      circuit.consecutiveFailures = 0;
    }

    const signal = input.signal ?? new AbortController().signal;
    const requestBase: ManifestProviderRequestBase = {
      catalog: input.catalog,
      generatorSchemaVersion: MANIFEST_GENERATOR_SCHEMA_VERSION,
      inputHash: fallback.resolvedInputHash,
      manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
      maxCostMicrounits: this.#policy.maxCostMicrounitsPerCall,
      maxInputTokens: this.#policy.maxInputTokensPerCall,
      maxOutputBytes: this.#policy.maxOutputBytes,
      maxOutputTokens: this.#policy.maxOutputTokens,
      modelCapabilities: { network: false, tools: false },
      normalizedPrompt: normalizeManifestPrompt(input.prompt),
      outputSchema: ManifestGenerationEnvelopeV1Schema,
      promptTemplateVersion: MANIFEST_PROMPT_TEMPLATE_VERSION,
      seed: fallback.seed,
      validatorVersion: MANIFEST_VALIDATOR_VERSION,
    };

    const callProvider = async (
      request: ManifestProviderRequest,
    ): Promise<ManifestProviderResponse> => {
      for (let retry = 0; ; retry += 1) {
        if (signal.aborted) throw new ManifestGenerationCancelledError();
        if (totals.providerCalls >= this.#policy.maxProviderCalls) {
          throw new ManifestProviderError(
            'PROVIDER_CALL_LIMIT_EXCEEDED',
            false,
            'Provider call allowance exhausted.',
          );
        }
        const remainingCost = this.#policy.maxCostMicrounits - totals.costMicrounits;
        const remainingInputTokens = this.#policy.maxInputTokens - totals.inputTokens;
        if (remainingCost < 0) {
          throw new ManifestProviderError(
            'PROVIDER_COST_LIMIT_EXCEEDED',
            false,
            'Provider cost budget exceeded.',
          );
        }
        if (remainingInputTokens <= 0) {
          throw new ManifestProviderError(
            'PROVIDER_TOKEN_LIMIT_EXCEEDED',
            false,
            'Provider token allowance exhausted.',
          );
        }
        const requestedReservation = {
          kind: request.kind,
          maxCostMicrounits: Math.min(remainingCost, this.#policy.maxCostMicrounitsPerCall),
          maxInputTokens: Math.min(remainingInputTokens, this.#policy.maxInputTokensPerCall),
          maxOutputTokens: this.#policy.maxOutputTokens,
          model: configuration.model,
          provider: configuration.provider,
          providerConfigurationId: configuration.configurationId,
        } satisfies ManifestProviderCallReservationRequest;
        let reservation: ManifestProviderCallReservation | null;
        try {
          reservation = await accounting.reserveProviderCall(requestedReservation);
        } catch (error) {
          throw new ManifestAccountingError(error);
        }
        if (!reservation) {
          throw new ManifestProviderError(
            'PROVIDER_COST_LIMIT_EXCEEDED',
            false,
            'The durable daily provider budget is exhausted.',
          );
        }
        if (
          !isBoundedIdentifier(reservation.id, 200) ||
          !Number.isSafeInteger(reservation.maxCostMicrounits) ||
          reservation.maxCostMicrounits < 0 ||
          reservation.maxCostMicrounits > requestedReservation.maxCostMicrounits ||
          !Number.isSafeInteger(reservation.maxInputTokens) ||
          reservation.maxInputTokens < 1 ||
          reservation.maxInputTokens > requestedReservation.maxInputTokens ||
          !Number.isSafeInteger(reservation.maxOutputTokens) ||
          reservation.maxOutputTokens < 1 ||
          reservation.maxOutputTokens > requestedReservation.maxOutputTokens
        ) {
          throw new ManifestAccountingError(new Error('MANIFEST_RESERVATION_INVALID'));
        }
        if (signal.aborted) {
          try {
            await accounting.releaseProviderCall(reservation);
          } catch (error) {
            throw new ManifestAccountingError(error);
          }
          throw new ManifestGenerationCancelledError();
        }
        totals.providerCalls += 1;
        const controller = new AbortController();
        let settled = false;
        let rejectBoundary: ((error: Error) => void) | undefined;
        const boundary = new Promise<never>((_resolve, reject) => {
          rejectBoundary = reject;
        });
        const propagateAbort = (): void => {
          controller.abort();
          rejectBoundary?.(new ManifestGenerationCancelledError());
        };
        signal.addEventListener('abort', propagateAbort, { once: true });
        const timeout = setTimeout(() => {
          controller.abort();
          rejectBoundary?.(
            new ManifestProviderError('PROVIDER_TIMEOUT', true, 'Provider timed out.'),
          );
        }, this.#policy.providerTimeoutMs);
        try {
          const boundedRequest: ManifestProviderRequest = {
            ...request,
            maxCostMicrounits: reservation.maxCostMicrounits,
            maxInputTokens: reservation.maxInputTokens,
            maxOutputTokens: reservation.maxOutputTokens,
          };
          const response = await Promise.race([
            provider.generate(boundedRequest, controller.signal),
            boundary,
          ]);
          if (signal.aborted) throw new ManifestGenerationCancelledError();
          if (
            !Number.isSafeInteger(response.costMicrounits) ||
            response.costMicrounits < 0 ||
            !Number.isSafeInteger(response.inputTokens) ||
            response.inputTokens < 0 ||
            !Number.isSafeInteger(response.outputTokens) ||
            response.outputTokens < 0
          ) {
            throw new ManifestProviderError(
              'PROVIDER_PERMANENT_FAILURE',
              false,
              'Provider returned invalid accounting metadata.',
            );
          }
          try {
            await accounting.settleProviderCall(reservation, {
              costMicrounits: response.costMicrounits,
              inputTokens: response.inputTokens,
              outputTokens: response.outputTokens,
            });
            settled = true;
          } catch (error) {
            throw new ManifestAccountingError(error);
          }
          totals.costMicrounits += response.costMicrounits;
          totals.inputTokens += response.inputTokens;
          totals.outputTokens += response.outputTokens;
          if (
            response.provider !== configuration.provider ||
            response.model !== configuration.model
          ) {
            throw new ManifestProviderError(
              'PROVIDER_PERMANENT_FAILURE',
              false,
              'Provider identity did not match its configured identity.',
            );
          }
          if (
            response.costMicrounits > reservation.maxCostMicrounits ||
            totals.costMicrounits > this.#policy.maxCostMicrounits
          ) {
            throw new ManifestProviderError(
              'PROVIDER_COST_LIMIT_EXCEEDED',
              false,
              'Provider cost budget exceeded.',
            );
          }
          if (
            response.inputTokens > reservation.maxInputTokens ||
            response.outputTokens > reservation.maxOutputTokens ||
            totals.inputTokens > this.#policy.maxInputTokens ||
            response.outputTokens > this.#policy.maxOutputTokens
          ) {
            throw new ManifestProviderError(
              'PROVIDER_TOKEN_LIMIT_EXCEEDED',
              false,
              'Provider token budget exceeded.',
            );
          }
          return response;
        } catch (error) {
          if (error instanceof ManifestAccountingError) throw error;
          if (!settled) {
            // A provider invocation without trustworthy returned accounting is
            // charged at its reservation ceiling. This is intentionally
            // conservative across timeouts, process death, and durable retry.
            totals.costMicrounits += reservation.maxCostMicrounits;
            totals.inputTokens += reservation.maxInputTokens;
            totals.outputTokens += reservation.maxOutputTokens;
          }
          if (signal.aborted) throw new ManifestGenerationCancelledError();
          const providerError =
            error instanceof ManifestProviderError
              ? error
              : controller.signal.aborted
                ? new ManifestProviderError('PROVIDER_TIMEOUT', true, 'Provider timed out.')
                : new ManifestProviderError(
                    'PROVIDER_TRANSIENT_FAILURE',
                    true,
                    'Provider call failed.',
                  );
          if (!providerError.transient || retry >= this.#policy.maxTransientRetries) {
            throw providerError;
          }
          const ceiling = Math.min(
            this.#policy.retryMaxDelayMs,
            this.#policy.retryBaseDelayMs * 2 ** retry,
          );
          const delay = Math.floor(this.#random() * (ceiling + 1));
          await this.#wait(delay, signal);
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener('abort', propagateAbort);
        }
      }
    };

    let request: ManifestProviderRequest = { ...requestBase, kind: 'generate' };
    let repairAttempts = accounting.initialUsage.repairAttempts;
    try {
      await emitStage('generation');
      for (;;) {
        const response = await callProvider(request);
        let parsed: ParsedProviderEnvelope;
        try {
          await emitStage('validation');
          parsed = parseProviderEnvelope(
            response.output,
            input.catalog,
            this.#policy.maxOutputBytes,
          );
        } catch (error) {
          if (!(error instanceof ProviderEnvelopeParseError)) throw error;
          if (error.candidate === null || repairAttempts >= this.#policy.maxRepairAttempts) {
            throw new ManifestProviderError(
              'PROVIDER_OUTPUT_INVALID',
              false,
              'Provider output was invalid after bounded repair.',
            );
          }
          repairAttempts += 1;
          await emitStage('repair');
          request = {
            ...requestBase,
            kind: 'repair',
            priorCandidate: error.candidate,
            validationErrors: error.diagnostics
              .filter((entry) => entry.severity === 'error')
              .slice(0, 32)
              .map((entry) => ({
                code: entry.code,
                message: entry.message,
                pointer: entry.pointer,
              })),
          };
          continue;
        }
        const normalizedEnvelope = normalizeProviderEnvelopeProvenance({
          catalog: input.catalog,
          configuration,
          envelope: parsed.envelope,
          inputHash: fallback.resolvedInputHash,
          normalizedPrompt: requestBase.normalizedPrompt,
        });
        const normalizedValidation = validateManifestGenerationEnvelope(
          normalizedEnvelope,
          input.catalog,
        );
        if (!normalizedValidation.valid || !normalizedValidation.contentHash) {
          throw new ManifestProviderError(
            'PROVIDER_OUTPUT_INVALID',
            false,
            'System-normalized provider output did not validate.',
          );
        }
        circuit.consecutiveFailures = 0;
        circuit.openUntilMs = 0;
        return {
          catalogSnapshotHash: normalizedValidation.catalogSnapshotHash,
          contentHash: normalizedValidation.contentHash,
          costMicrounits: totals.costMicrounits,
          envelope: normalizedEnvelope,
          failures,
          inputHash: fallback.requestHash,
          inputTokens: totals.inputTokens,
          latencyMs: Math.max(0, this.#now() - startedAtMs),
          mode: 'provider',
          model: configuration.model,
          outputTokens: totals.outputTokens,
          provider: configuration.provider,
          providerConfigurationId: configuration.configurationId,
          providerCalls: totals.providerCalls,
          repairAttempts,
          resolvedInputHash: fallback.resolvedInputHash,
          seed: fallback.seed,
        };
      }
    } catch (error) {
      if (error instanceof ManifestGenerationCancelledError) throw error;
      if (error instanceof ManifestStageCallbackError) throw error;
      if (error instanceof ManifestAccountingError) throw error;
      const failure =
        error instanceof ManifestProviderError ? error.code : 'PROVIDER_PERMANENT_FAILURE';
      failures.push(failure);
      circuit.consecutiveFailures += 1;
      if (circuit.consecutiveFailures >= this.#policy.circuitFailureThreshold) {
        circuit.openUntilMs = this.#now() + this.#policy.circuitCooldownMs;
      }
      await emitStage('fallback');
      return fallbackOutcome(repairAttempts);
    }
  }
}

export function fallbackGenerationOutcome(
  fallback: DeterministicFallbackResult,
): ManifestGenerationOutcome {
  return {
    catalogSnapshotHash: fallback.catalogSnapshotHash,
    contentHash: fallback.contentHash,
    costMicrounits: 0,
    envelope: fallback.envelope,
    failures: ['PROVIDER_DISABLED'],
    inputHash: fallback.requestHash,
    inputTokens: 0,
    latencyMs: 0,
    mode: 'fallback',
    model: 'city-state-template-v1',
    outputTokens: 0,
    provider: 'worldgraph-fallback',
    providerConfigurationId: 'deterministic-fallback-v1',
    providerCalls: 0,
    repairAttempts: 0,
    resolvedInputHash: fallback.resolvedInputHash,
    seed: fallback.seed,
  };
}

export function createManifestGenerationEngine(
  provider: ManifestGenerationProvider,
  options: ManifestGenerationOrchestratorOptions = {},
): ManifestGenerationEngine {
  const orchestrator = new ManifestGenerationOrchestrator(options);
  return {
    generate(input, signal, onStage, accounting) {
      return orchestrator.generate({ ...input, signal }, provider, onStage, accounting);
    },
  };
}
