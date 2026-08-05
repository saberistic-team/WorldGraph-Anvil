import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { GovernanceCoherenceBanner } from './governance-coherence-banner';
import { governanceProjectionStatus } from './governance-model';

describe('governance coherence banner', () => {
  it('pauses actions and identifies a tick-only mismatch', () => {
    const markup = renderToStaticMarkup(
      createElement(GovernanceCoherenceBanner, {
        status: governanceProjectionStatus('52', '52', '8', '9'),
      }),
    );

    expect(markup).toContain('Governance views are not coherent');
    expect(markup).toContain('from tick 8 through 9');
    expect(markup).toContain('Civic actions are paused');
    expect(markup).toContain('charter, capabilities, and all loaded governance pages');
  });

  it('renders nothing when revision and evaluation tick are coherent', () => {
    expect(
      renderToStaticMarkup(
        createElement(GovernanceCoherenceBanner, {
          status: governanceProjectionStatus('52', '52', '9', '9'),
        }),
      ),
    ).toBe('');
  });
});
