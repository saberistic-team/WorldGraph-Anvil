import { describe, expect, it } from 'vitest';

import { mapPostgresGovernanceRejection } from './errors.js';

describe('governance Postgres invariant mapping', () => {
  it.each([
    'proposal_results_root_proposal_unique',
    'proposal_results_root_contest_unique',
    'election_results_root_election_unique',
    'election_results_root_contest_unique',
  ])('maps finalized-result root uniqueness %s', (constraint) => {
    expect(mapPostgresGovernanceRejection({ code: '23505', constraint })).toMatchObject({
      code: 'RESULT_FINALIZED',
    });
  });

  it.each(['proposal_results_repair_parent_unique', 'election_results_repair_parent_unique'])(
    'maps linked-repair uniqueness %s',
    (constraint) => {
      expect(mapPostgresGovernanceRejection({ code: '23505', constraint })).toMatchObject({
        code: 'GOVERNANCE_REPAIR_CONFLICT',
      });
    },
  );
});
