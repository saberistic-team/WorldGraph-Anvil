import { createHash } from 'node:crypto';

import type { PrimitiveKind } from '@worldgraph/contracts';

import { compareSemver } from './semver.js';

export const RRF_K = 60 as const;
export const RRF_WEIGHTS = { lexical: 1, tag: 0.6, vector: 0.35 } as const;

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to', 'with']);

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeRetrievalQuery(query: string): string {
  return query
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizedQueryHash(query: string): string {
  return createHash('sha256').update(normalizeRetrievalQuery(query)).digest('hex');
}

export function retrievalTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeRetrievalQuery(query)
        .split(' ')
        .filter((term) => term && !STOP_WORDS.has(term)),
    ),
  ];
}

export interface RetrievalCandidate {
  id: string;
  key: string;
  kind: PrimitiveKind;
  lexicalScore?: number;
  normalizedText: string;
  tags: string[];
  tagScore?: number;
  vectorSimilarity?: number;
  version: string;
}

export interface RankedCandidate extends RetrievalCandidate {
  lexicalRank: number | null;
  matchedTags: string[];
  matchedTerms: string[];
  score: number;
  tagRank: number | null;
  vectorRank: number | null;
}

function rankMap(
  entries: { id: string; key: string; value: number; version: string }[],
): Map<string, number> {
  return new Map(
    entries
      .sort(
        (left, right) =>
          right.value - left.value ||
          compareCodePoints(left.key, right.key) ||
          compareSemver(right.version, left.version),
      )
      .map((entry, index) => [entry.id, index + 1]),
  );
}

export function rankCandidates(
  query: string,
  candidates: readonly RetrievalCandidate[],
): RankedCandidate[] {
  const terms = retrievalTerms(query);
  const assessed = candidates.map((candidate) => {
    const textTokens = new Set(
      normalizeRetrievalQuery(candidate.normalizedText).split(' ').filter(Boolean),
    );
    const matchedTerms = terms.filter((term) => textTokens.has(term));
    const matchedTags = candidate.tags.filter((tag) => {
      const tagTerms = normalizeRetrievalQuery(tag).split(' ').filter(Boolean);
      return tagTerms.length > 0 && tagTerms.every((term) => terms.includes(term));
    });
    const lexical =
      candidate.lexicalScore ?? (terms.length === 0 ? 0 : matchedTerms.length / terms.length);
    const tag = candidate.tagScore ?? matchedTags.length;
    return { candidate, lexical, matchedTags, matchedTerms, tag };
  });
  const lexicalRanks = rankMap(
    assessed
      .filter((entry) => entry.lexical > 0)
      .map((entry) => ({
        id: entry.candidate.id,
        key: entry.candidate.key,
        value: entry.lexical,
        version: entry.candidate.version,
      })),
  );
  const tagRanks = rankMap(
    assessed
      .filter((entry) => entry.tag > 0)
      .map((entry) => ({
        id: entry.candidate.id,
        key: entry.candidate.key,
        value: entry.tag,
        version: entry.candidate.version,
      })),
  );
  const vectorRanks = rankMap(
    assessed
      .filter((entry) => Number.isFinite(entry.candidate.vectorSimilarity))
      .map((entry) => ({
        id: entry.candidate.id,
        key: entry.candidate.key,
        value: entry.candidate.vectorSimilarity!,
        version: entry.candidate.version,
      })),
  );
  return assessed
    .map(({ candidate, matchedTags, matchedTerms }) => {
      const lexicalRank = lexicalRanks.get(candidate.id) ?? null;
      const tagRank = tagRanks.get(candidate.id) ?? null;
      const vectorRank = vectorRanks.get(candidate.id) ?? null;
      const score =
        (lexicalRank ? RRF_WEIGHTS.lexical / (RRF_K + lexicalRank) : 0) +
        (tagRank ? RRF_WEIGHTS.tag / (RRF_K + tagRank) : 0) +
        (vectorRank ? RRF_WEIGHTS.vector / (RRF_K + vectorRank) : 0);
      return { ...candidate, lexicalRank, matchedTags, matchedTerms, score, tagRank, vectorRank };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareCodePoints(left.key, right.key) ||
        compareSemver(right.version, left.version),
    );
}
