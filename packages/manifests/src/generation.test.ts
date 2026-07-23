import { describe, expect, it, vi } from 'vitest';

import type { ManifestGenerationEnvelopeV1 } from '@worldgraph/contracts';

import {
  ManifestGenerationCancelledError,
  ManifestGenerationOrchestrator,
  ManifestProviderError,
  createDeterministicHarborCityFallback,
  createDeterministicFallback,
  createManifestGenerationEngine,
  harborCityManifestCatalog,
  manifestGenerationInputHash,
  manifestGenerationRequestHash,
  resolveManifestGenerationSeed,
  starterManifestCatalog,
  type ManifestGenerationProvider,
  type ManifestProviderRequest,
  type ManifestProviderResponse,
} from './index.js';

const prompt =
  'An energy-scarce floating city-state governed by competing guilds using closed-loop credits.';
const configuration = {
  configurationId: 'provider-config-v1',
  enabled: true,
  model: 'schema-model-v1',
  modelCapabilities: { network: false, tools: false } as const,
  provider: 'schema-provider',
};

function providerEnvelope(): ManifestGenerationEnvelopeV1 {
  const fallback = createDeterministicFallback({
    catalog: starterManifestCatalog(),
    prompt,
    providerConfigurationId: configuration.configurationId,
    seed: 'provider-seed',
  });
  return {
    ...fallback.envelope,
    provenance: [
      {
        pointer: '',
        sourceHash: 'b'.repeat(64),
        sourceRef: 'do-not-persist-this-provider-string',
        sourceType: 'model',
      },
    ],
    warnings: [],
  };
}

function response(
  envelope: unknown,
  overrides: Partial<ManifestProviderResponse> = {},
): ManifestProviderResponse {
  return {
    costMicrounits: 100,
    inputTokens: 200,
    model: configuration.model,
    output: JSON.stringify(envelope),
    outputTokens: 300,
    provider: configuration.provider,
    ...overrides,
  };
}

class SequenceProvider implements ManifestGenerationProvider {
  public readonly requests: ManifestProviderRequest[] = [];

  public constructor(
    public readonly configuration: ManifestGenerationProvider['configuration'],
    private readonly steps: Array<
      (request: ManifestProviderRequest, signal: AbortSignal) => Promise<ManifestProviderResponse>
    >,
  ) {}

  public generate(
    request: ManifestProviderRequest,
    signal: AbortSignal,
  ): Promise<ManifestProviderResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error('Unexpected provider call.');
    return step(request, signal);
  }
}

const resolves = (value: ManifestProviderResponse) => async (): Promise<ManifestProviderResponse> =>
  value;

describe('bounded manifest provider orchestration', () => {
  it('uses deterministic fallback when disabled and preserves base/resolved hash semantics', async () => {
    const catalog = starterManifestCatalog();
    const disabled = new SequenceProvider({ ...configuration, enabled: false }, []);
    const orchestrator = new ManifestGenerationOrchestrator();
    const outcome = await orchestrator.generate({ catalog, prompt }, disabled);
    const seed = resolveManifestGenerationSeed({
      prompt,
      providerConfigurationId: configuration.configurationId,
    });
    expect(outcome).toMatchObject({
      failures: ['PROVIDER_DISABLED'],
      mode: 'fallback',
      model: configuration.model,
      provider: configuration.provider,
      providerCalls: 0,
      providerConfigurationId: configuration.configurationId,
      seed,
    });
    expect(outcome.inputHash).toBe(
      manifestGenerationRequestHash({
        prompt,
        providerConfigurationId: configuration.configurationId,
        seed,
      }),
    );
    expect(outcome.resolvedInputHash).toBe(
      manifestGenerationInputHash({
        catalog,
        prompt,
        providerConfigurationId: configuration.configurationId,
        seed,
      }),
    );
  });

  it('constructs and runs provider-disabled generation with a zero cost budget', async () => {
    const disabled = new SequenceProvider({ ...configuration, enabled: false }, []);
    const orchestrator = new ManifestGenerationOrchestrator({
      policy: { maxCostMicrounits: 0 },
    });
    await expect(
      orchestrator.generate(
        { catalog: starterManifestCatalog(), prompt, seed: 'zero-budget-seed' },
        disabled,
      ),
    ).resolves.toMatchObject({
      costMicrounits: 0,
      failures: ['PROVIDER_DISABLED'],
      mode: 'fallback',
      providerCalls: 0,
    });
  });

  it('allows the production engine to select the reviewed commerce fallback explicitly', async () => {
    const disabled = new SequenceProvider({ ...configuration, enabled: false }, []);
    const engine = createManifestGenerationEngine(disabled, {
      fallbackFactory: createDeterministicHarborCityFallback,
    });
    const outcome = await engine.generate(
      { catalog: harborCityManifestCatalog(), prompt, seed: 'harbor-production-seed' },
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ failures: ['PROVIDER_DISABLED'], mode: 'fallback' });
    expect(outcome.envelope.manifest.extensions['worldgraph.economy']).toMatchObject({
      schemaVersion: 2,
    });
  });

  it('returns locally validated output with system-authored provenance and accounting', async () => {
    const envelope = providerEnvelope();
    const provider = new SequenceProvider(configuration, [resolves(response(envelope))]);
    const stages: string[] = [];
    const outcome = await new ManifestGenerationOrchestrator().generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'provider-seed' },
      provider,
      (stage) => {
        stages.push(stage);
      },
    );
    expect(outcome).toMatchObject({
      costMicrounits: 100,
      inputTokens: 200,
      mode: 'provider',
      outputTokens: 300,
      providerCalls: 1,
      repairAttempts: 0,
    });
    expect(stages).toEqual(['generation', 'validation']);
    expect(JSON.stringify(outcome.envelope.provenance)).not.toContain(
      'do-not-persist-this-provider-string',
    );
    expect(
      outcome.envelope.provenance.some((entry) => /^prompt:[a-f0-9]{32}$/u.test(entry.sourceRef)),
    ).toBe(true);
    expect(
      outcome.envelope.provenance.some((entry) => /^model:[a-f0-9]{32}$/u.test(entry.sourceRef)),
    ).toBe(true);
    expect(outcome.envelope.provenance.some((entry) => entry.sourceType === 'primitive')).toBe(
      true,
    );
  });

  it('performs at most two schema repairs with only structured prior candidate/errors', async () => {
    const valid = providerEnvelope();
    const invalid = { ...valid, tool: { name: 'fetch', url: 'https://evil.test' } };
    const provider = new SequenceProvider(configuration, [
      resolves(response(invalid)),
      resolves(response(valid)),
    ]);
    const outcome = await new ManifestGenerationOrchestrator().generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'provider-seed' },
      provider,
    );
    expect(outcome).toMatchObject({ mode: 'provider', providerCalls: 2, repairAttempts: 1 });
    const repairRequest = provider.requests[1];
    expect(repairRequest?.kind).toBe('repair');
    if (!repairRequest || repairRequest.kind !== 'repair') return;
    expect(repairRequest.priorCandidate).toHaveProperty('tool');
    expect(
      repairRequest.validationErrors.some(
        (entry) => entry.code === 'MANIFEST_GENERATION_ENVELOPE_INVALID',
      ),
    ).toBe(true);
    expect(JSON.stringify(repairRequest)).not.toContain('stack');
  });

  it('rejects forged primitive provenance and falls back without persisting it', async () => {
    const envelope = providerEnvelope();
    const primitive = envelope.manifest.primitiveRefs[0]!;
    envelope.provenance = [
      {
        pointer: '/metadata',
        sourceHash: 'f'.repeat(64),
        sourceRef: `${primitive.key}@${primitive.version}`,
        sourceType: 'primitive',
      },
    ];
    const provider = new SequenceProvider(configuration, [resolves(response(envelope))]);
    const outcome = await new ManifestGenerationOrchestrator().generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'provider-seed' },
      provider,
    );
    expect(outcome.mode).toBe('fallback');
    expect(outcome.failures).toContain('PROVIDER_OUTPUT_INVALID');
    expect(JSON.stringify(outcome.envelope.provenance)).not.toContain('f'.repeat(64));
  });

  it('enforces a real timeout even when the provider ignores AbortSignal', async () => {
    const catalog = starterManifestCatalog();
    const fallback = createDeterministicFallback({
      catalog,
      prompt,
      providerConfigurationId: configuration.configurationId,
      seed: 'timeout-seed',
    });
    const provider = new SequenceProvider(configuration, [
      async () => new Promise<ManifestProviderResponse>(() => undefined),
    ]);
    const orchestrator = new ManifestGenerationOrchestrator({
      fallbackFactory: () => fallback,
      policy: { maxTransientRetries: 0, providerTimeoutMs: 100 },
    });
    const started = Date.now();
    const outcome = await orchestrator.generate(
      { catalog, prompt, seed: 'timeout-seed' },
      provider,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome).toMatchObject({
      failures: ['PROVIDER_TIMEOUT'],
      mode: 'fallback',
      providerCalls: 1,
    });
  });

  it('retries one typed transient failure within per-call and durable run allowances', async () => {
    const wait = vi.fn(async () => undefined);
    const provider = new SequenceProvider(configuration, [
      async () => {
        throw new ManifestProviderError(
          'PROVIDER_TRANSIENT_FAILURE',
          true,
          'private upstream detail must not escape',
        );
      },
      resolves(response(providerEnvelope())),
    ]);
    const outcome = await new ManifestGenerationOrchestrator({
      random: () => 0,
      wait,
    }).generate({ catalog: starterManifestCatalog(), prompt, seed: 'retry-seed' }, provider);

    expect(outcome).toMatchObject({
      costMicrounits: 1_000_100,
      inputTokens: 4_200,
      mode: 'provider',
      outputTokens: 16_300,
      providerCalls: 2,
    });
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]).toMatchObject({
      maxCostMicrounits: 1_000_000,
      maxInputTokens: 4_000,
      maxOutputTokens: 16_000,
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(JSON.stringify(outcome)).not.toContain('private upstream detail');
  }, 15_000);

  it('accepts the full configured daily-budget numeric boundary', () => {
    expect(
      () =>
        new ManifestGenerationOrchestrator({
          policy: {
            maxCostMicrounits: 2_147_483_647,
            maxCostMicrounitsPerCall: 2_147_483_647,
          },
        }),
    ).not.toThrow();
  });

  it('bounds cost and opens the circuit after configured failures', async () => {
    const costProvider = new SequenceProvider(configuration, [
      resolves(response(providerEnvelope(), { costMicrounits: 501 })),
    ]);
    const costOutcome = await new ManifestGenerationOrchestrator({
      policy: { maxCostMicrounits: 500, maxTransientRetries: 0 },
    }).generate({ catalog: starterManifestCatalog(), prompt, seed: 'cost-seed' }, costProvider);
    expect(costOutcome).toMatchObject({
      failures: ['PROVIDER_COST_LIMIT_EXCEEDED'],
      mode: 'fallback',
    });

    let calls = 0;
    const failing = new SequenceProvider(configuration, [
      async () => {
        calls += 1;
        throw new ManifestProviderError('PROVIDER_PERMANENT_FAILURE', false, 'redacted');
      },
      async () => {
        calls += 1;
        throw new ManifestProviderError('PROVIDER_PERMANENT_FAILURE', false, 'redacted');
      },
    ]);
    const orchestrator = new ManifestGenerationOrchestrator({
      policy: { circuitFailureThreshold: 2, maxTransientRetries: 0 },
    });
    await orchestrator.generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'circuit-seed-1' },
      failing,
    );
    await orchestrator.generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'circuit-seed-2' },
      failing,
    );
    const open = await orchestrator.generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'circuit-seed-3' },
      failing,
    );
    expect(calls).toBe(2);
    expect(open.failures).toEqual(['PROVIDER_CIRCUIT_OPEN']);
    expect(orchestrator.circuitSnapshot(configuration.configurationId).open).toBe(true);
  });

  it('cancels a provider that ignores AbortSignal without publishing fallback', async () => {
    const provider = new SequenceProvider(configuration, [
      async () => new Promise<ManifestProviderResponse>(() => undefined),
    ]);
    const controller = new AbortController();
    const promise = new ManifestGenerationOrchestrator({
      policy: { maxTransientRetries: 0, providerTimeoutMs: 5_000 },
    }).generate(
      { catalog: starterManifestCatalog(), prompt, seed: 'cancel-seed', signal: controller.signal },
      provider,
    );
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toBeInstanceOf(ManifestGenerationCancelledError);
  });
});
