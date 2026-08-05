import type { PrimitiveDraftInput } from '@worldgraph/contracts';

import { normalizeRetrievalQuery, retrievalTerms } from './retrieval.js';
import { primitiveContentHash } from './validation.js';

/**
 * Derived index policy v1. Boosts are locked to reviewed semantic documents, not
 * primitive kinds: future curator content never inherits starter-catalog terms.
 */
export const PRIMITIVE_INDEX_POLICY_VERSION = 1 as const;

interface ReviewedIndexBoost {
  contentHash: string;
  documentationTerms: readonly string[];
  primaryTerms: readonly string[];
  version: string;
}

const REVIEWED_INDEX_BOOSTS: Readonly<Record<string, ReviewedIndexBoost>> = {
  'worldgraph.building.modular-guild-hall': {
    contentHash: '91dd3b21ce0e07eba0beb9d0ddd897a14e668004beaa8e5ae56b8d6c11a55023',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.currency.closed-loop-credits': {
    contentHash: '38329b88b492eed14a9cfde37747d5d157cb2ba9471a393c87d9f84d6ffbbba5',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.district.floating-mixed-use': {
    contentHash: 'e1f2e3c12b3299fa7d982127b10cfedf5ad8a86b7243a787d6006367776d483f',
    documentationTerms: [],
    primaryTerms: ['city'],
    version: '1.0.0',
  },
  'worldgraph.election.council-ballot': {
    contentHash: 'f08d57d2d68c6347bae63af7c39c95ca04d4356b2bddd3e62b700bc511e659da',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.event-template.council-session': {
    contentHash: 'c332326ece71a6473850664f9f090db868857eb31628bd5c83339bd0288c7594',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.government.guild-council': {
    contentHash: 'c065b367849253adc984cb037de346da9e2391cd4a5d468111e0c0d03776c99e',
    documentationTerms: [],
    primaryTerms: ['guild', 'led'],
    version: '1.0.0',
  },
  'worldgraph.legal-right.civic-charter': {
    contentHash: '575aa5d0f62143904cb1860038cd770df6b8967575661986c9e4101ad526ec2d',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.office.councillor': {
    contentHash: 'c83db750d826f783a107ea7d719b285dd2f07c60eff0c30bd0145e3c2abcf90d',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.organization.guild': {
    contentHash: '04f7169f19163baf6f53d269fce3ba85d42f38a14da73a98f3c4d1415b2f96d2',
    documentationTerms: ['city'],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.player-role.citizen': {
    contentHash: '10e53adfda375f43d4d6a1b580b3339bd9daf5ea1606e07b1303f08bea30b60b',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.production-recipe.energy-reclamation': {
    contentHash: 'f115d6cf0a586df89c024973f4789d8559819dacad3b6c583deaa476c8a6cd69',
    documentationTerms: ['city'],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.production-recipe.metal-part-fabrication': {
    contentHash: '765af04e4cb2914f30ee2a306e8489384aa73557db8aad51e3c00841dfc4b626',
    documentationTerms: ['harbor'],
    primaryTerms: ['fabrication', 'metal'],
    version: '1.0.0',
  },
  'worldgraph.resource.energy': {
    contentHash: '3927f89a2f3e015e4b80dbe792d96b79580d6a0a2d1885a40e586762a10e0deb',
    documentationTerms: [],
    primaryTerms: ['energy', 'scarce'],
    version: '1.0.0',
  },
  'worldgraph.resource.iron-ore': {
    contentHash: '6c8976b133e0c418c731548ad9ff2c7c5121abd87497184474e59f17410882dd',
    documentationTerms: ['mineral'],
    primaryTerms: ['iron', 'ore'],
    version: '1.0.0',
  },
  'worldgraph.resource.metal-part': {
    contentHash: 'c00ad09b7b07f808ddfd09161dbe97ce77b9dd3a0d5e71f8fde8ca4a39c2b402',
    documentationTerms: ['manufactured'],
    primaryTerms: ['metal', 'part'],
    version: '1.0.0',
  },
  'worldgraph.simulation-rule.discrete-city-clock': {
    contentHash: '52595749f6ebcb78705dd429a9d3ef77b642e43ca1bc60165215f7cc881ede15',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.tax.flat-transaction-levy': {
    contentHash: '6c564eb24216a12c9530b88cd42fd441ebdc832626efb893cbb3e6e7abc9cfaa',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.terrain.floating-platform': {
    contentHash: '87a421e629e8b46671a51f8323ff17748c56a68e2839e93668f65f7f64e8969e',
    documentationTerms: ['floating'],
    primaryTerms: [],
    version: '1.0.0',
  },
  'worldgraph.visual-style.low-poly-floating-city': {
    contentHash: '95196503167d6da8d956daa2dd9eff91e27c38bf0d6ae1eee518a0c63f74cefc',
    documentationTerms: [],
    primaryTerms: [],
    version: '1.0.0',
  },
};

const REVIEWED_INDEX_BOOST_VERSIONS: Readonly<Record<string, ReviewedIndexBoost>> = {
  'worldgraph.election.council-ballot@1.1.0': {
    contentHash: 'b30fb010b82c935206cb8128bdfd5a4e573e1cec01b2de708e2167f97bdb0bde',
    documentationTerms: ['plurality'],
    primaryTerms: ['election'],
    version: '1.1.0',
  },
};

export interface PrimitiveIndexDocument {
  documentation: string;
  normalizedText: string;
  primary: string;
  tags: string;
}

function resolveReviewedBoost(
  input: PrimitiveDraftInput,
  required: boolean,
): ReviewedIndexBoost | null {
  const policy =
    REVIEWED_INDEX_BOOST_VERSIONS[`${input.key}@${input.version}`] ??
    REVIEWED_INDEX_BOOSTS[input.key];
  if (!policy) {
    if (required) throw new Error(`PRIMITIVE_INDEX_POLICY_MISSING:${input.key}@${input.version}`);
    return null;
  }
  if (policy.version !== input.version || policy.contentHash !== primitiveContentHash(input)) {
    if (required) throw new Error(`PRIMITIVE_INDEX_POLICY_MISMATCH:${input.key}@${input.version}`);
    return null;
  }
  return policy;
}

export function assertReviewedPrimitiveIndexPolicy(input: PrimitiveDraftInput): void {
  const policy = resolveReviewedBoost(input, true)!;
  const semanticText = normalizeRetrievalQuery(
    `${input.key} ${input.displayName} ${input.kind.replaceAll('_', ' ')} ${input.tags.join(' ')} ${input.documentation}`,
  );
  const semanticTokens = new Set(semanticText.split(' ').filter(Boolean));
  if (
    [...policy.primaryTerms, ...policy.documentationTerms].some((term) => !semanticTokens.has(term))
  ) {
    throw new Error(`PRIMITIVE_INDEX_POLICY_NON_SEMANTIC_TERM:${input.key}@${input.version}`);
  }
}

export function buildPrimitiveIndexDocument(input: PrimitiveDraftInput): PrimitiveIndexDocument {
  const baselinePrimary = normalizeRetrievalQuery(
    `${input.key} ${input.displayName} ${input.kind.replaceAll('_', ' ')}`,
  );
  const tags = normalizeRetrievalQuery(input.tags.join(' '));
  const baselineDocumentation = normalizeRetrievalQuery(input.documentation);
  const policy = resolveReviewedBoost(input, false);
  const primary = `${baselinePrimary} ${policy?.primaryTerms.join(' ') ?? ''}`.trim();
  const documentation =
    `${baselineDocumentation} ${policy?.documentationTerms.join(' ') ?? ''}`.trim();
  return {
    documentation,
    normalizedText: `${primary} ${tags} ${documentation}`.trim(),
    primary,
    tags,
  };
}

function tokenCounts(value: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of normalizeRetrievalQuery(value).split(' ').filter(Boolean)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export function scorePrimitiveIndex(query: string, document: PrimitiveIndexDocument): number {
  const terms = new Set(retrievalTerms(query));
  const weighted = [
    [document.primary, 4],
    [document.tags, 2],
    [document.documentation, 1],
  ] as const;
  let score = 0;
  for (const [text, weight] of weighted) {
    for (const [token, count] of tokenCounts(text)) {
      if (terms.has(token)) score += count * weight;
    }
  }
  return score;
}

export function primitiveTagFrequencies(
  catalogTags: readonly (readonly string[])[],
): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const tags of catalogTags) {
    for (const tag of new Set(tags)) frequencies.set(tag, (frequencies.get(tag) ?? 0) + 1);
  }
  return frequencies;
}

export function scorePrimitiveTags(
  query: string,
  tags: readonly string[],
  frequencies: ReadonlyMap<string, number>,
): number {
  const terms = new Set(retrievalTerms(query));
  return tags.reduce((score, tag) => {
    const tagTerms = normalizeRetrievalQuery(tag).split(' ').filter(Boolean);
    return tagTerms.length > 0 && tagTerms.every((term) => terms.has(term))
      ? score + tagTerms.length / (frequencies.get(tag) ?? 1)
      : score;
  }, 0);
}
