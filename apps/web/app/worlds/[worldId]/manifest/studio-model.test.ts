import { describe, expect, it } from 'vitest';

import type {
  GetManifestRevisionResponse,
  ManifestDiagnostic,
  ManifestGenerationRunView,
  PrimitiveListItem,
  World,
  WorldManifestV1,
} from '@worldgraph/contracts';

import {
  approvalReady,
  canonicalManifestJson,
  diagnosticFieldId,
  generationRunForRevision,
  manifestEditAllowed,
  nextStage,
  pollDelay,
  replacePrimitivePin,
  sourceOffset,
  warningCodes,
} from './studio-model';

const warning = (code: string): ManifestDiagnostic => ({
  code,
  fixes: [],
  location: null,
  message: code,
  pointer: '',
  relatedPointers: [],
  severity: 'warning',
});

describe('Manifest Studio interaction model', () => {
  it('downloads the exact normalized canonical JSON representation', () => {
    expect(canonicalManifestJson({ z: -0, a: 'e\u0301', list: [2, 1] })).toBe(
      '{"a":"é","list":[2,1],"z":0}',
    );
  });

  it('requires exact warnings, valid draft, creator role, and typed world name', () => {
    const diagnostics = [warning('B_WARNING'), warning('A_WARNING'), warning('A_WARNING')];
    const detail = {
      report: { diagnostics, valid: true },
      revision: { approvalStatus: 'draft' },
    } as GetManifestRevisionResponse;
    const world = { name: 'Floating Guild City', role: 'creator' } as World;
    expect(warningCodes(diagnostics)).toEqual(['A_WARNING', 'B_WARNING']);
    expect(
      approvalReady({
        acknowledgedCodes: new Set(['A_WARNING', 'B_WARNING']),
        confirmationName: world.name,
        detail,
        world,
      }),
    ).toBe(true);
    expect(
      approvalReady({
        acknowledgedCodes: new Set(['A_WARNING']),
        confirmationName: world.name,
        detail,
        world,
      }),
    ).toBe(false);
  });

  it('allows edits only for active creator or administrator world membership', () => {
    expect(manifestEditAllowed({ role: 'creator' } as World)).toBe(true);
    expect(manifestEditAllowed({ role: 'administrator' } as World)).toBe(true);
    expect(manifestEditAllowed({ role: 'player' } as World)).toBe(false);
    expect(manifestEditAllowed({ role: 'observer' } as World)).toBe(false);
    expect(
      manifestEditAllowed({
        role: null,
      } as World),
    ).toBe(false);
    expect(manifestEditAllowed(null)).toBe(false);
  });

  it("shows generation review data only for the selected revision's exact run", () => {
    const run = { id: '018f8652-3cb6-7d52-904b-cce7901d7e71' } as ManifestGenerationRunView;
    const matching = {
      revision: { generationRunId: run.id },
    } as GetManifestRevisionResponse;
    const manual = {
      revision: { generationRunId: null },
    } as GetManifestRevisionResponse;
    const other = {
      revision: { generationRunId: '018f8652-3cb6-7d52-904b-cce7901d7e72' },
    } as GetManifestRevisionResponse;

    expect(generationRunForRevision(run, matching)).toBe(run);
    expect(generationRunForRevision(run, manual)).toBeNull();
    expect(generationRunForRevision(run, other)).toBeNull();
    expect(generationRunForRevision(null, matching)).toBeNull();
  });

  it('maps diagnostics to structured fields or the YAML source location', () => {
    expect(diagnosticFieldId('/metadata/name')).toBe('manifest-name');
    expect(diagnosticFieldId('/districts/1/key')).toBe('manifest-yaml-editor');
    expect(sourceOffset('one\ntwo\nthree', { column: 2, line: 2 })).toBe(5);
  });

  it('caps visible polling, slows hidden polling, and keyboard-wraps available stages', () => {
    expect(pollDelay(99, 'visible')).toBe(5_000);
    expect(pollDelay(0, 'hidden')).toBe(10_000);
    expect(nextStage('describe', 'next', null)).toBe('describe');
    expect(nextStage('approve', 'next', {} as GetManifestRevisionResponse)).toBe('describe');
    expect(nextStage('describe', 'previous', {} as GetManifestRevisionResponse)).toBe('approve');
  });

  it('replaces only a published same-kind exact pin while preserving its parameters', () => {
    const manifest = {
      primitiveRefs: [
        {
          contentHash: 'a'.repeat(64),
          id: 'unused',
          key: 'worldgraph.resource.energy',
          kind: 'resource',
          parameters: { scarcity: 0.8 },
          primitiveVersionId: '018f8652-3cb6-7d52-904b-cce7901d7e61',
          ref: 'energy',
          version: '1.0.0',
        },
      ],
    } as unknown as WorldManifestV1;
    const candidate = {
      contentHash: 'b'.repeat(64),
      id: '018f8652-3cb6-7d52-904b-cce7901d7e62',
      key: 'worldgraph.resource.energy-efficient',
      kind: 'resource',
      lifecycle: 'published',
      version: '2.0.0',
    } as PrimitiveListItem;

    const replaced = replacePrimitivePin(manifest, 'energy', candidate);
    expect(replaced).not.toBe(manifest);
    expect(replaced.primitiveRefs[0]).toMatchObject({
      contentHash: 'b'.repeat(64),
      key: candidate.key,
      parameters: { scarcity: 0.8 },
      primitiveVersionId: candidate.id,
      version: '2.0.0',
    });
    expect(manifest.primitiveRefs[0]?.key).toBe('worldgraph.resource.energy');

    expect(() =>
      replacePrimitivePin(manifest, 'energy', {
        ...candidate,
        kind: 'currency',
      }),
    ).toThrow(/same kind/u);
  });
});
