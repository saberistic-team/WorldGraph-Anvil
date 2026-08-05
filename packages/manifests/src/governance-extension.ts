import {
  WorldgraphGovernanceExtensionV1Schema,
  createValidator,
  type ValidationIssue,
  type WorldManifestV1,
  type WorldgraphGovernanceExtensionV1,
} from '@worldgraph/contracts';

export { WorldgraphGovernanceExtensionV1Schema } from '@worldgraph/contracts';
export type { WorldgraphGovernanceExtensionV1 } from '@worldgraph/contracts';

export const WORLDGRAPH_GOVERNANCE_EXTENSION_KEY = 'worldgraph.governance' as const;
export const WORLDGRAPH_GOVERNANCE_EXTENSION_SCHEMA_VERSION = 1 as const;

export interface WorldgraphGovernanceExtensionIssue {
  code: string;
  message: string;
  pointer: string;
  relatedPointers: string[];
}

export interface WorldgraphGovernanceExtensionValidationResult {
  issues: readonly WorldgraphGovernanceExtensionIssue[];
  valid: boolean;
  value: WorldgraphGovernanceExtensionV1 | null;
}

const validateStructure = createValidator<WorldgraphGovernanceExtensionV1>(
  WorldgraphGovernanceExtensionV1Schema,
);

function issue(
  code: string,
  pointer: string,
  message: string,
  relatedPointers: string[] = [],
): WorldgraphGovernanceExtensionIssue {
  return { code, message, pointer, relatedPointers };
}

function structuralIssues(
  errors: readonly ValidationIssue[],
): WorldgraphGovernanceExtensionIssue[] {
  return errors.map((error) =>
    issue(
      'MANIFEST_GOVERNANCE_EXTENSION_SCHEMA_INVALID',
      `/extensions/${WORLDGRAPH_GOVERNANCE_EXTENSION_KEY}${error.path === '/' ? '' : error.path}`,
      `Governance extension schema violation (${error.keyword}): ${error.message ?? 'invalid value'}.`,
    ),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableIssues<T extends { stableKey: string }>(
  values: readonly T[],
  pointer: string,
): WorldgraphGovernanceExtensionIssue[] {
  const issues: WorldgraphGovernanceExtensionIssue[] = [];
  const seen = new Map<string, number>();
  values.forEach((value, index) => {
    const prior = seen.get(value.stableKey);
    if (prior !== undefined) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_DUPLICATE_KEY',
          `${pointer}/${index}/stableKey`,
          `Governance stable key ${value.stableKey} is duplicated.`,
          [`${pointer}/${prior}/stableKey`],
        ),
      );
    } else {
      seen.set(value.stableKey, index);
    }
    if (index > 0 && compareText(values[index - 1]!.stableKey, value.stableKey) > 0) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_NOT_SORTED',
          `${pointer}/${index}/stableKey`,
          'Governance intent arrays must be sorted by stable key.',
        ),
      );
    }
  });
  return issues;
}

function intervalIssue(
  fromTick: string,
  untilTick: string | null,
  pointer: string,
): WorldgraphGovernanceExtensionIssue | null {
  if (untilTick === null || BigInt(fromTick) < BigInt(untilTick)) return null;
  return issue(
    'MANIFEST_GOVERNANCE_EXTENSION_WINDOW_INVALID',
    pointer,
    'Governance effective intervals must be non-empty and half-open.',
  );
}

function semanticIssues(
  extension: WorldgraphGovernanceExtensionV1,
  manifest: WorldManifestV1,
): WorldgraphGovernanceExtensionIssue[] {
  const base = `/extensions/${WORLDGRAPH_GOVERNANCE_EXTENSION_KEY}`;
  const issues: WorldgraphGovernanceExtensionIssue[] = [];
  issues.push(...stableIssues(extension.institutions, `${base}/institutions`));
  issues.push(...stableIssues(extension.offices, `${base}/offices`));
  issues.push(...stableIssues(extension.initialLaws, `${base}/initialLaws`));

  const electionRef = manifest.primitiveRefs.find(
    (entry) => entry.ref === extension.electionPrimitiveRef,
  );
  if (
    electionRef?.kind !== 'election' ||
    electionRef.key !== 'worldgraph.election.council-ballot' ||
    electionRef.version !== '1.1.0' ||
    electionRef.parameters.method !== 'plurality'
  ) {
    issues.push(
      issue(
        'MANIFEST_GOVERNANCE_EXTENSION_ELECTION_PRIMITIVE_INVALID',
        `${base}/electionPrimitiveRef`,
        'Governance must pin the reviewed plurality council-ballot primitive version 1.1.0.',
      ),
    );
  }

  const graphKeys = new Set<string>([
    ...manifest.districts.map((entry) => `district:${entry.key}`),
    ...manifest.institutions.map((entry) => `institution:${entry.key}`),
    ...manifest.organizations.map((entry) => `organization:${entry.key}`),
    ...manifest.actors.map((entry) => `actor:${entry.key}`),
  ]);
  const institutionKeys = new Set(extension.institutions.map((entry) => entry.stableKey));
  const organizationKeys = new Set(
    manifest.organizations.map((entry) => `organization:${entry.key}`),
  );
  extension.institutions.forEach((institution, index) => {
    const pointer = `${base}/institutions/${index}`;
    if (!graphKeys.has(institution.worldEntityKey)) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_WORLD_ENTITY_UNKNOWN',
          `${pointer}/worldEntityKey`,
          `Institution entity ${institution.worldEntityKey} does not resolve in the manifest graph.`,
        ),
      );
    }
    if (!graphKeys.has(institution.jurisdictionEntityKey)) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_JURISDICTION_UNKNOWN',
          `${pointer}/jurisdictionEntityKey`,
          `Jurisdiction ${institution.jurisdictionEntityKey} does not resolve in the manifest graph.`,
        ),
      );
    }
  });
  extension.offices.forEach((office, index) => {
    if (!institutionKeys.has(office.institutionKey)) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_INSTITUTION_UNKNOWN',
          `${base}/offices/${index}/institutionKey`,
          `Office institution ${office.institutionKey} does not resolve in the governance extension.`,
        ),
      );
    }
    office.powers.forEach((power, powerIndex) => {
      power.delegatedOrganizationEntityKeys.forEach((organizationKey, delegationIndex) => {
        if (!organizationKeys.has(organizationKey)) {
          issues.push(
            issue(
              'MANIFEST_GOVERNANCE_EXTENSION_DELEGATION_ORGANIZATION_UNKNOWN',
              `${base}/offices/${index}/powers/${powerIndex}/delegatedOrganizationEntityKeys/${delegationIndex}`,
              `Delegated organization ${organizationKey} does not resolve to a manifest organization.`,
            ),
          );
        }
      });
    });
  });
  extension.initialLaws.forEach((law, index) => {
    if (!graphKeys.has(law.jurisdictionEntityKey)) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_JURISDICTION_UNKNOWN',
          `${base}/initialLaws/${index}/jurisdictionEntityKey`,
          `Law jurisdiction ${law.jurisdictionEntityKey} does not resolve in the manifest graph.`,
        ),
      );
    }
    const invalid = intervalIssue(
      law.effectiveFromTick,
      law.effectiveUntilTick,
      `${base}/initialLaws/${index}/effectiveUntilTick`,
    );
    if (invalid) issues.push(invalid);
  });
  const invalidCharter = intervalIssue(
    extension.charter.effectiveFromTick,
    extension.charter.effectiveUntilTick,
    `${base}/charter/effectiveUntilTick`,
  );
  if (invalidCharter) issues.push(invalidCharter);

  const unsafeText =
    /(?:<[^>]*>|(?:https?|javascript|data|file):|\{\{|\{%|<%|\$\{|^(?:select|insert|update|delete|drop|alter|create)\b)/iu;
  const civicText: Array<[string, string]> = [
    [`${base}/charter/title`, extension.charter.title],
    [`${base}/charter/summary`, extension.charter.summary],
    ...extension.institutions.map(
      (entry, index) =>
        [`${base}/institutions/${index}/displayName`, entry.displayName] as [string, string],
    ),
    ...extension.offices.map(
      (entry, index) =>
        [`${base}/offices/${index}/displayName`, entry.displayName] as [string, string],
    ),
    ...extension.initialLaws.flatMap((entry, index) => [
      [`${base}/initialLaws/${index}/title`, entry.title] as [string, string],
      [`${base}/initialLaws/${index}/summary`, entry.summary] as [string, string],
    ]),
  ];
  for (const [pointer, value] of civicText) {
    if (unsafeText.test(value.trim())) {
      issues.push(
        issue(
          'MANIFEST_GOVERNANCE_EXTENSION_CONTENT_UNSAFE',
          pointer,
          'Governance display text cannot contain remote, executable, template, or markup content.',
        ),
      );
    }
  }
  return issues;
}

export function validateWorldgraphGovernanceExtensionV1(
  input: unknown,
  manifest?: WorldManifestV1,
): WorldgraphGovernanceExtensionValidationResult {
  if (!validateStructure.is(input)) {
    return { issues: structuralIssues(validateStructure.issues(input)), valid: false, value: null };
  }
  const value = structuredClone(input);
  const issues = manifest ? semanticIssues(value, manifest) : [];
  return { issues, valid: issues.length === 0, value };
}

export function worldgraphGovernanceExtensionIssues(
  manifest: WorldManifestV1,
): readonly WorldgraphGovernanceExtensionIssue[] {
  if (
    !Object.prototype.hasOwnProperty.call(manifest.extensions, WORLDGRAPH_GOVERNANCE_EXTENSION_KEY)
  ) {
    return [];
  }
  return validateWorldgraphGovernanceExtensionV1(
    manifest.extensions[WORLDGRAPH_GOVERNANCE_EXTENSION_KEY],
    manifest,
  ).issues;
}

export class WorldgraphGovernanceExtensionError extends Error {
  public readonly code = 'WORLDGRAPH_GOVERNANCE_EXTENSION_INVALID' as const;

  public constructor(public readonly issues: readonly WorldgraphGovernanceExtensionIssue[]) {
    super(issues.map((entry) => `${entry.code}:${entry.pointer}`).join(','));
    this.name = 'WorldgraphGovernanceExtensionError';
  }
}

export function parseWorldgraphGovernanceExtensionV1(
  input: unknown,
): WorldgraphGovernanceExtensionV1 {
  const result = validateWorldgraphGovernanceExtensionV1(input);
  if (!result.valid || !result.value) throw new WorldgraphGovernanceExtensionError(result.issues);
  return result.value;
}

export function assertWorldgraphGovernanceExtensionV1(
  manifest: WorldManifestV1,
): WorldgraphGovernanceExtensionV1 {
  const input = manifest.extensions[WORLDGRAPH_GOVERNANCE_EXTENSION_KEY];
  const result = validateWorldgraphGovernanceExtensionV1(input, manifest);
  if (!result.valid || !result.value) throw new WorldgraphGovernanceExtensionError(result.issues);
  return result.value;
}
