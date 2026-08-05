import { createElement } from 'react';

import { governanceCoherenceMessage, type GovernanceProjectionStatus } from './governance-model';

export function GovernanceCoherenceBanner({ status }: { status: GovernanceProjectionStatus }) {
  if (!status.catchingUp) return null;
  return createElement(
    'div',
    {
      'aria-atomic': 'true',
      'aria-live': 'polite',
      className: 'govern-projection-lag',
      role: 'status',
    },
    createElement('strong', null, 'Governance views are not coherent'),
    createElement('p', null, governanceCoherenceMessage(status)),
  );
}
