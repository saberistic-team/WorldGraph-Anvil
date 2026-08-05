import { describe, expect, it } from 'vitest';

import {
  actionSummary,
  ballotDisclosureText,
  formatBasisPoints,
  governanceProjectionStatus,
  loadBoundedGovernancePages,
  maximumGovernanceEvaluatedAtTick,
  maximumGovernanceProjectionRevision,
  minimumGovernanceEvaluatedAtTick,
  minimumGovernanceProjectionRevision,
  tickWindowState,
} from './governance-model.js';

describe('governance presentation model', () => {
  it('uses exact basis-point and half-open tick semantics', () => {
    expect(formatBasisPoints(725)).toBe('7.25%');
    expect(tickWindowState('9', '10', '20')).toBe('not_open');
    expect(tickWindowState('10', '10', '20')).toBe('open');
    expect(tickWindowState('19', '10', '20')).toBe('open');
    expect(tickWindowState('20', '10', '20')).toBe('closed');
  });

  it('does not promise choice recovery for secret ballots', () => {
    expect(
      ballotDisclosureText({
        ballotMode: 'secret',
        disclosure: 'aggregate_only',
        replacementAllowed: false,
      }),
    ).not.toMatch(/selection is returned/iu);
  });

  it('renders typed actions without executable free-form content', () => {
    expect(
      actionSummary({
        actionSchemaVersion: 1,
        actionType: 'update_tax',
        effectiveFromTick: '40',
        expectedTaxPolicyVersion: '2',
        newRateBps: 650,
        taxPolicyId: '018f0000-0000-7000-8000-000000000001',
      }),
    ).toContain('6.50%');
  });

  it('ranges charter, capabilities, and pages by both revision and evaluation tick', () => {
    const reads = [
      {
        items: [],
        page: { evaluatedAtTick: '12', nextCursor: null, projectionRevision: '43' },
      },
      { evaluatedAtTick: '10', projectionRevision: '41' },
      { evaluatedAtTick: '11', projectionRevision: '42' },
    ];
    expect(minimumGovernanceProjectionRevision(reads)).toBe('41');
    expect(maximumGovernanceProjectionRevision(reads)).toBe('43');
    expect(minimumGovernanceEvaluatedAtTick(reads)).toBe('10');
    expect(maximumGovernanceEvaluatedAtTick(reads)).toBe('12');
    expect(governanceProjectionStatus('41', '43', '10', '12')).toEqual({
      catchingUp: true,
      lag: '2',
      newestEvaluatedAtTick: '12',
      newestProjectionRevision: '43',
      oldestEvaluatedAtTick: '10',
      oldestProjectionRevision: '41',
      revisionMismatch: true,
      tickLag: '2',
      tickMismatch: true,
    });
    const unrelatedRuntimeRevision = '99';
    expect(unrelatedRuntimeRevision).toBe('99');
    expect(governanceProjectionStatus('45', '45', '12', '12')).toMatchObject({
      catchingUp: false,
      lag: '0',
      tickLag: '0',
    });
  });

  it('pauses for a tick-only mismatch even when all revision labels are equal', () => {
    expect(governanceProjectionStatus('45', '45', '12', '13')).toMatchObject({
      catchingUp: true,
      lag: '0',
      revisionMismatch: false,
      tickLag: '1',
      tickMismatch: true,
    });
  });

  it('loads non-null governance cursors, including candidacy-shaped pages, to a finite bound', async () => {
    const cursors: Array<string | null> = [];
    const page = await loadBoundedGovernancePages(async (cursor) => {
      cursors.push(cursor);
      return cursor === null
        ? {
            items: [{ candidacyId: 'first' }],
            page: {
              evaluatedAtTick: '70',
              nextCursor: 'next-candidacy',
              projectionRevision: '50',
            },
          }
        : {
            items: [{ candidacyId: 'second' }],
            page: { evaluatedAtTick: '71', nextCursor: null, projectionRevision: '51' },
          };
    });

    expect(cursors).toEqual([null, 'next-candidacy']);
    expect(page.items).toEqual([{ candidacyId: 'first' }, { candidacyId: 'second' }]);
    expect(page.page).toEqual({
      evaluatedAtTick: '70',
      latestEvaluatedAtTick: '71',
      latestProjectionRevision: '51',
      nextCursor: null,
      projectionRevision: '50',
    });
  });
});
