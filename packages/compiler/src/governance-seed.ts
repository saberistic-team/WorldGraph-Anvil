import {
  GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
  WorldgraphGovernanceExtensionV1Schema,
  createValidator,
  type GovernanceSeedPlanV1,
  type WorldgraphGovernanceExtensionV1,
} from '@worldgraph/contracts';
import {
  GovernanceDomainError,
  assertGovernanceSeedPlanV1,
  governanceSeedPlanHashV1,
} from '@worldgraph/governance';

import { compilerDiagnostic } from './diagnostics.js';
import type { LoweredWorld, StageResult } from './types.js';

export const COMPILED_GOVERNANCE_SEED_ADAPTER_ID = 'CompiledGovernanceSeedAdapterV1' as const;
export const GOVERNANCE_SEED_ADAPTER_VERSION = '1.0.0' as const;

const extensionValidator = createValidator<WorldgraphGovernanceExtensionV1>(
  WorldgraphGovernanceExtensionV1Schema,
);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: string, pointer: string, message: string, keys: string[] = []) {
  return compilerDiagnostic('emit', code, pointer, message, { relatedKeys: keys });
}

function sortedPowers<T extends { action: string; resourceType: string }>(
  values: readonly T[],
): T[] {
  return [...structuredClone(values)].sort((left, right) => {
    const action = compareText(left.action, right.action);
    return action || compareText(left.resourceType, right.resourceType);
  });
}

function sortedOfficePowers<
  T extends {
    action: string;
    delegatedOrganizationEntityKeys: readonly string[];
    resourceType: string;
  },
>(values: readonly T[]): T[] {
  return sortedPowers(values).map((power) => ({
    ...power,
    delegatedOrganizationEntityKeys: [...power.delegatedOrganizationEntityKeys].sort(compareText),
  }));
}

/**
 * Native compiler 1.3 adapter. Governance exists only when the strict typed
 * extension is present; generic institutions and authority placeholders are
 * deliberately not interpreted as legal state.
 */
export function deriveLoweredGovernanceSeedPlanV1(
  lowered: LoweredWorld,
): StageResult<{ hash: string; plan: GovernanceSeedPlanV1 }> {
  const rawExtension = lowered.normalized.manifest.extensions['worldgraph.governance'];
  if (rawExtension === undefined) {
    return {
      diagnostics: [
        diagnostic(
          'GOVERNANCE_V1_EXTENSION_INVALID',
          '/manifest/extensions/worldgraph.governance',
          'Native compiler 1.3 requires the strict worldgraph.governance extension.',
        ),
      ],
      value: null,
    };
  }
  if (!extensionValidator.is(rawExtension)) {
    return {
      diagnostics: extensionValidator
        .issues(rawExtension)
        .slice(0, 32)
        .map((issue) =>
          diagnostic(
            'GOVERNANCE_V1_EXTENSION_INVALID',
            `/manifest/extensions/worldgraph.governance${issue.path === '/' ? '' : issue.path}`,
            `The M10 governance extension is invalid: ${issue.message}`,
          ),
        ),
      value: null,
    };
  }
  const extension = rawExtension;
  const graphEntities = new Map(lowered.entities.map((entity) => [entity.logicalKey, entity]));
  const references = new Map(
    lowered.normalized.manifest.primitiveRefs.map((reference) => [reference.ref, reference]),
  );
  const electionReference = references.get(extension.electionPrimitiveRef);
  const exactElection = lowered.normalized.orderedPrimitives.find(
    (primitive) => primitive.primitiveVersionId === electionReference?.primitiveVersionId,
  );
  if (
    electionReference?.kind !== 'election' ||
    electionReference.key !== 'worldgraph.election.council-ballot' ||
    electionReference.version !== '1.1.0' ||
    electionReference.parameters.method !== 'plurality' ||
    exactElection?.definition.kind !== 'election' ||
    exactElection.definition.key !== electionReference.key ||
    exactElection.definition.version !== electionReference.version
  ) {
    return {
      diagnostics: [
        diagnostic(
          'GOVERNANCE_ELECTION_PRIMITIVE_INVALID',
          '/manifest/extensions/worldgraph.governance/electionPrimitiveRef',
          'Native governance requires the exact reviewed plurality council-ballot primitive 1.1.0.',
        ),
      ],
      value: null,
    };
  }
  for (const [index, institution] of extension.institutions.entries()) {
    if (graphEntities.get(institution.worldEntityKey)?.entityType !== 'institution') {
      return {
        diagnostics: [
          diagnostic(
            'GOVERNANCE_INSTITUTION_ENTITY_INVALID',
            `/manifest/extensions/worldgraph.governance/institutions/${index}/worldEntityKey`,
            'A compiled governance institution must resolve to one institution graph entity.',
            [institution.worldEntityKey],
          ),
        ],
        value: null,
      };
    }
    if (!graphEntities.has(institution.jurisdictionEntityKey)) {
      return {
        diagnostics: [
          diagnostic(
            'GOVERNANCE_JURISDICTION_ENTITY_INVALID',
            `/manifest/extensions/worldgraph.governance/institutions/${index}/jurisdictionEntityKey`,
            'A compiled governance jurisdiction must resolve to one graph entity.',
            [institution.jurisdictionEntityKey],
          ),
        ],
        value: null,
      };
    }
  }
  for (const [index, law] of extension.initialLaws.entries()) {
    if (!graphEntities.has(law.jurisdictionEntityKey)) {
      return {
        diagnostics: [
          diagnostic(
            'GOVERNANCE_LAW_JURISDICTION_INVALID',
            `/manifest/extensions/worldgraph.governance/initialLaws/${index}/jurisdictionEntityKey`,
            'A founding law jurisdiction must resolve to one graph entity.',
            [law.jurisdictionEntityKey],
          ),
        ],
        value: null,
      };
    }
  }
  for (const [officeIndex, office] of extension.offices.entries()) {
    for (const [powerIndex, power] of office.powers.entries()) {
      for (const [
        delegationIndex,
        organizationKey,
      ] of power.delegatedOrganizationEntityKeys.entries()) {
        if (graphEntities.get(organizationKey)?.entityType !== 'organization') {
          return {
            diagnostics: [
              diagnostic(
                'GOVERNANCE_DELEGATION_ORGANIZATION_INVALID',
                `/manifest/extensions/worldgraph.governance/offices/${officeIndex}/powers/${powerIndex}/delegatedOrganizationEntityKeys/${delegationIndex}`,
                'A compiled office-power delegation must resolve to one organization graph entity.',
                [organizationKey],
              ),
            ],
            value: null,
          };
        }
      }
    }
  }

  const plan: GovernanceSeedPlanV1 = {
    charter: structuredClone(extension.charter),
    governanceSeedPlanSchemaVersion: GOVERNANCE_SEED_PLAN_SCHEMA_VERSION,
    initialLaws: structuredClone(extension.initialLaws).sort((left, right) =>
      compareText(left.stableKey, right.stableKey),
    ),
    institutions: structuredClone(extension.institutions)
      .map((institution) => ({ ...institution, powers: sortedPowers(institution.powers) }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    offices: structuredClone(extension.offices)
      .map((office) => ({ ...office, powers: sortedOfficePowers(office.powers) }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
  };
  try {
    assertGovernanceSeedPlanV1(plan);
    return {
      diagnostics: [],
      value: { hash: governanceSeedPlanHashV1(plan), plan },
    };
  } catch (error) {
    return {
      diagnostics: [
        diagnostic(
          'GOVERNANCE_SEED_PLAN_INVALID',
          '/governanceSeedPlan',
          error instanceof GovernanceDomainError
            ? error.message
            : 'Governance seed plan could not be derived.',
        ),
      ],
      value: null,
    };
  }
}
