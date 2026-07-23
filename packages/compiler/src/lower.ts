import {
  canonicalizeJson,
  WorldEntityStatePairV1Validator,
  WorldRelationshipAttributesPairV1Validator,
  type CompilerDiagnosticV1,
  type JsonValue,
  type WorldEntityType,
  type WorldEntityV1,
  type WorldRelationshipType,
  type WorldRelationshipV1,
} from '@worldgraph/contracts';

import { compilerDiagnostic, hasCompilerErrors, sortCompilerDiagnostics } from './diagnostics.js';
import { stableLogicalKey, stableRelationshipKey } from './keys.js';
import { DeterministicPrng } from './prng.js';
import type { LoweredWorld, NormalizedCompilerInput, StageResult } from './types.js';

function jsonObject(value: unknown): Record<string, JsonValue> {
  const canonical = canonicalizeJson(value);
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    throw new TypeError('Entity and relationship state must be a JSON object.');
  }
  return canonical;
}

const relationshipType = {
  'cooperates-with': 'cooperates_with',
  governs: 'governs',
  'located-in': 'located_in',
  'member-of': 'member_of',
  rivals: 'rivals',
  supplies: 'supplies',
} as const satisfies Record<string, WorldRelationshipType>;

function endpointLogicalKey(kind: string, key: string): string {
  switch (kind) {
    case 'actor':
      return stableLogicalKey('actor-blueprint', key);
    case 'district':
      return stableLogicalKey('district', key);
    case 'institution':
      return stableLogicalKey('institution', key);
    case 'organization':
      return stableLogicalKey('organization', key);
    default:
      throw new TypeError(`Unsupported manifest endpoint kind: ${kind}`);
  }
}

export function lowerNormalizedInput(
  normalized: NormalizedCompilerInput,
): StageResult<LoweredWorld> {
  const diagnostics: CompilerDiagnosticV1[] = [];
  const entities: WorldEntityV1[] = [];
  const relationships: WorldRelationshipV1[] = [];
  const controllers: LoweredWorld['controllers'] = [];
  const entityKeys = new Set<string>();
  const relationshipKeys = new Set<string>();
  const relationshipTuples = new Set<string>();
  const addEntity = (
    logicalKey: string,
    entityType: WorldEntityType,
    state: Record<string, JsonValue>,
  ): void => {
    if (entityKeys.has(logicalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'lower',
          'DUPLICATE_ENTITY_LOGICAL_KEY',
          '/entities',
          'Lowering produced a duplicate stable entity key.',
          { relatedKeys: [logicalKey] },
        ),
      );
      return;
    }
    entityKeys.add(logicalKey);
    const pair: unknown = { entityType, state: jsonObject(state) };
    if (!WorldEntityStatePairV1Validator.is(pair)) {
      diagnostics.push(
        compilerDiagnostic(
          'lower',
          'LOWERED_ENTITY_STATE_INVALID',
          '/entities',
          'Lowering produced state that does not match its entity type.',
          { relatedKeys: [logicalKey] },
        ),
      );
      return;
    }
    entities.push({ ...pair, entitySchemaVersion: 1, logicalKey });
  };
  const addRelationship = (
    type: WorldRelationshipType,
    semanticKey: string,
    sourceLogicalKey: string,
    targetLogicalKey: string,
    attributes: Record<string, JsonValue> = {},
    deduplicateTuple = false,
  ): void => {
    const tuple = `${type}\0${sourceLogicalKey}\0${targetLogicalKey}`;
    if (deduplicateTuple && relationshipTuples.has(tuple)) return;
    const logicalKey = stableRelationshipKey(type, semanticKey);
    if (relationshipKeys.has(logicalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'lower',
          'DUPLICATE_RELATIONSHIP_LOGICAL_KEY',
          '/relationships',
          'Lowering produced a duplicate stable relationship key.',
          { relatedKeys: [logicalKey] },
        ),
      );
      return;
    }
    relationshipKeys.add(logicalKey);
    relationshipTuples.add(tuple);
    const pair: unknown = {
      attributes: jsonObject(attributes),
      relationshipType: type,
    };
    if (!WorldRelationshipAttributesPairV1Validator.is(pair)) {
      diagnostics.push(
        compilerDiagnostic(
          'lower',
          'LOWERED_RELATIONSHIP_ATTRIBUTES_INVALID',
          '/relationships',
          'Lowering produced attributes that do not match their relationship type.',
          { relatedKeys: [logicalKey] },
        ),
      );
      return;
    }
    relationships.push({
      ...pair,
      logicalKey,
      relationshipSchemaVersion: 1,
      sourceLogicalKey,
      targetLogicalKey,
    });
  };

  const manifest = normalized.manifest;
  const primitiveByRef = new Map(
    manifest.primitiveRefs.map((primitive) => [primitive.ref, primitive]),
  );
  const primitiveEntityKey = (ref: string): string => stableLogicalKey('primitive', ref);

  for (const primitive of manifest.primitiveRefs) {
    const exact = normalized.orderedPrimitives.find(
      (candidate) => candidate.primitiveVersionId === primitive.primitiveVersionId,
    );
    addEntity(primitiveEntityKey(primitive.ref), 'primitive_instance', {
      behaviorRef: exact?.definition.behaviorRef ?? null,
      contentHash: primitive.contentHash,
      key: primitive.key,
      kind: primitive.kind,
      parameters: primitive.parameters,
      ref: primitive.ref,
      version: primitive.version,
    });
  }

  // Declared manifest edges win their semantic tuple. Derived edges below use
  // tuple de-duplication so an implied relationship never shadows provenance.
  for (const relation of manifest.relationships) {
    addRelationship(
      relationshipType[relation.type],
      `manifest-${relation.key}`,
      endpointLogicalKey(relation.source.kind, relation.source.key),
      endpointLogicalKey(relation.target.kind, relation.target.key),
      { manifestRelationshipKey: relation.key },
    );
  }

  for (const district of manifest.districts) {
    const key = stableLogicalKey('district', district.key);
    addEntity(key, 'district', {
      name: district.name,
      parameters: district.parameters,
      primitiveRef: district.primitiveRef,
    });
    addRelationship(
      'uses_primitive',
      `district-${district.key}`,
      key,
      primitiveEntityKey(district.primitiveRef),
      {},
      true,
    );
  }
  for (const organization of manifest.organizations) {
    const key = stableLogicalKey('organization', organization.key);
    addEntity(key, 'organization', {
      homeDistrictLogicalKey: stableLogicalKey('district', organization.homeDistrictKey),
      name: organization.name,
      parameters: organization.parameters,
      primitiveRef: organization.primitiveRef,
    });
    addRelationship(
      'located_in',
      `organization-${organization.key}`,
      key,
      stableLogicalKey('district', organization.homeDistrictKey),
      {},
      true,
    );
    addRelationship(
      'uses_primitive',
      `organization-${organization.key}`,
      key,
      primitiveEntityKey(organization.primitiveRef),
      {},
      true,
    );
  }
  for (const institution of manifest.institutions) {
    const key = stableLogicalKey('institution', institution.key);
    addEntity(key, 'institution', {
      districtLogicalKey:
        institution.districtKey === null
          ? null
          : stableLogicalKey('district', institution.districtKey),
      name: institution.name,
      organizationLogicalKeys: institution.organizationKeys.map((organizationKey) =>
        stableLogicalKey('organization', organizationKey),
      ),
      parameters: institution.parameters,
      primitiveRef: institution.primitiveRef,
    });
    if (institution.districtKey !== null) {
      addRelationship(
        'located_in',
        `institution-${institution.key}`,
        key,
        stableLogicalKey('district', institution.districtKey),
        {},
        true,
      );
    }
    for (const organizationKey of institution.organizationKeys) {
      addRelationship(
        'participates_in',
        `organization-${organizationKey}-institution-${institution.key}`,
        stableLogicalKey('organization', organizationKey),
        key,
        { basis: 'institution-participation' },
        true,
      );
    }
    addRelationship(
      'uses_primitive',
      `institution-${institution.key}`,
      key,
      primitiveEntityKey(institution.primitiveRef),
      {},
      true,
    );
  }
  for (const actor of manifest.actors) {
    const key = stableLogicalKey('actor-blueprint', actor.key);
    addEntity(key, 'actor_blueprint', {
      controller: actor.controller,
      homeDistrictLogicalKey: stableLogicalKey('district', actor.homeDistrictKey),
      name: actor.name,
      organizationLogicalKey:
        actor.organizationKey === null
          ? null
          : stableLogicalKey('organization', actor.organizationKey),
      parameters: actor.parameters,
      rolePrimitiveRef: actor.rolePrimitiveRef,
    });
    addRelationship(
      'located_in',
      `actor-${actor.key}`,
      key,
      stableLogicalKey('district', actor.homeDistrictKey),
      {},
      true,
    );
    if (actor.organizationKey !== null) {
      addRelationship(
        'member_of',
        `actor-${actor.key}`,
        key,
        stableLogicalKey('organization', actor.organizationKey),
        {},
        true,
      );
    }
    addRelationship(
      'uses_primitive',
      `actor-${actor.key}`,
      key,
      primitiveEntityKey(actor.rolePrimitiveRef),
      {},
      true,
    );
  }

  for (const connection of manifest.connections) {
    addRelationship(
      'connected_to',
      `connection-${connection.key}`,
      stableLogicalKey('district', connection.fromDistrictKey),
      stableLogicalKey('district', connection.toDistrictKey),
      { bidirectional: true, connectionKind: connection.kind },
    );
  }

  const currencyRef = primitiveByRef.get(manifest.economy.currencyPrimitiveRef)!;
  const currencyKey = stableLogicalKey('economy', 'currency');
  addEntity(currencyKey, 'currency_definition_intent', {
    parameters: currencyRef.parameters,
    primitiveRef: currencyRef.ref,
  });
  addRelationship(
    'uses_primitive',
    'economy-currency',
    currencyKey,
    primitiveEntityKey(currencyRef.ref),
  );
  const resourceKeys = manifest.economy.resourcePrimitiveRefs.map((ref) => {
    const primitive = primitiveByRef.get(ref)!;
    const key = stableLogicalKey('economy', 'resource', ref);
    addEntity(key, 'resource_definition_intent', {
      parameters: primitive.parameters,
      primitiveRef: ref,
    });
    addRelationship('uses_primitive', `economy-resource-${ref}`, key, primitiveEntityKey(ref));
    return key;
  });
  const productionKeys = manifest.economy.productionPrimitiveRefs.map((ref) => {
    const primitive = primitiveByRef.get(ref)!;
    const key = stableLogicalKey('economy', 'production', ref);
    addEntity(key, 'production_definition_intent', {
      parameters: primitive.parameters,
      primitiveRef: ref,
    });
    addRelationship('uses_primitive', `economy-production-${ref}`, key, primitiveEntityKey(ref));
    return key;
  });
  const taxKeys = manifest.economy.taxPrimitiveRefs.map((ref) => {
    const primitive = primitiveByRef.get(ref)!;
    const key = stableLogicalKey('economy', 'tax', ref);
    addEntity(key, 'tax_definition_intent', {
      parameters: primitive.parameters,
      primitiveRef: ref,
    });
    addRelationship('uses_primitive', `economy-tax-${ref}`, key, primitiveEntityKey(ref));
    return key;
  });
  addEntity(stableLogicalKey('economy', 'configuration'), 'economy_configuration', {
    currencyLogicalKey: currencyKey,
    productionLogicalKeys: productionKeys,
    resourceLogicalKeys: resourceKeys,
    taxLogicalKeys: taxKeys,
  });

  const simulationKey = stableLogicalKey('simulation', 'configuration');
  addEntity(simulationKey, 'simulation_configuration', {
    eventPrimitiveRefs: manifest.simulation.eventPrimitiveRefs,
    rulePrimitiveRefs: manifest.simulation.rulePrimitiveRefs,
    settings: manifest.simulation.settings,
  });
  for (const ref of [
    ...manifest.simulation.eventPrimitiveRefs,
    ...manifest.simulation.rulePrimitiveRefs,
  ]) {
    addRelationship('uses_primitive', `simulation-${ref}`, simulationKey, primitiveEntityKey(ref));
  }

  const visualPrng = new DeterministicPrng(`${normalized.bundle.seed}\0visual-plan`);
  const visualPlan: LoweredWorld['visualPlan'] = {
    direction: manifest.visual.direction,
    districts: manifest.districts.map((district) => ({
      districtLogicalKey: stableLogicalKey('district', district.key),
      rotationMilliDegrees: visualPrng.nextInt(360_000),
      xMilliunits: visualPrng.nextInt(200_001) - 100_000,
      yMilliunits: visualPrng.nextInt(200_001) - 100_000,
    })),
    schemaVersion: 1,
    stylePrimitiveLogicalKey: primitiveEntityKey(manifest.visual.stylePrimitiveRef),
    terrainPrimitiveLogicalKey: primitiveEntityKey(manifest.visual.terrainPrimitiveRef),
  };
  const visualKey = stableLogicalKey('visual', 'plan');
  addEntity(visualKey, 'visual_plan', jsonObject(visualPlan));
  addRelationship('uses_primitive', 'visual-style', visualKey, visualPlan.stylePrimitiveLogicalKey);
  addRelationship(
    'uses_primitive',
    'visual-terrain',
    visualKey,
    visualPlan.terrainPrimitiveLogicalKey,
  );

  const playerActors = manifest.actors.filter((actor) => actor.controller === 'player');
  const memberPrng = new DeterministicPrng(`${normalized.bundle.seed}\0member-assignment`);
  normalized.activeMembers
    .filter((member) => member.role !== 'observer')
    .forEach((member) => {
      const blueprint = playerActors[memberPrng.nextInt(playerActors.length)]!;
      const accountKey = stableLogicalKey('account', member.principalKey);
      const characterKey = stableLogicalKey('character', member.principalKey);
      const blueprintKey = stableLogicalKey('actor-blueprint', blueprint.key);
      addEntity(accountKey, 'account_principal', {
        membershipRole: member.role,
        principalKey: member.principalKey,
      });
      addEntity(characterKey, 'player_character', {
        blueprintLogicalKey: blueprintKey,
        homeDistrictLogicalKey: stableLogicalKey('district', blueprint.homeDistrictKey),
        membershipRole: member.role,
        name: member.role === 'creator' ? 'Creator Character' : `${member.role} character`,
        organizationLogicalKey:
          blueprint.organizationKey === null
            ? null
            : stableLogicalKey('organization', blueprint.organizationKey),
      });
      addRelationship(
        'account_controls',
        `member-${member.principalKey}`,
        accountKey,
        characterKey,
      );
      addRelationship('instantiates', `member-${member.principalKey}`, characterKey, blueprintKey);
      addRelationship(
        'located_in',
        `member-${member.principalKey}`,
        characterKey,
        stableLogicalKey('district', blueprint.homeDistrictKey),
      );
      if (blueprint.organizationKey !== null) {
        addRelationship(
          'member_of',
          `member-${member.principalKey}`,
          characterKey,
          stableLogicalKey('organization', blueprint.organizationKey),
        );
      }
      controllers.push({
        controlScope: 'primary',
        entityLogicalKey: characterKey,
        principalKey: member.principalKey,
      });
    });

  const sorted = sortCompilerDiagnostics(diagnostics);
  return {
    diagnostics: sorted,
    value: hasCompilerErrors(sorted)
      ? null
      : { controllers, entities, normalized, relationships, visualPlan },
  };
}
