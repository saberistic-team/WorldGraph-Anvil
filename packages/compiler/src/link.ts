import type {
  CompilerDiagnosticV1,
  WorldEntityType,
  WorldRelationshipV1,
} from '@worldgraph/contracts';

import { compilerDiagnostic, hasCompilerErrors, sortCompilerDiagnostics } from './diagnostics.js';
import { stableLogicalKey } from './keys.js';
import type { LoweredWorld, StageResult } from './types.js';

type EndpointRule = {
  sources?: readonly WorldEntityType[];
  targets?: readonly WorldEntityType[];
};

export const relationshipEndpointRules: Readonly<
  Record<WorldRelationshipV1['relationshipType'], EndpointRule>
> = {
  account_controls: { sources: ['account_principal'], targets: ['player_character'] },
  connected_to: { sources: ['district'], targets: ['district'] },
  cooperates_with: { sources: ['organization'], targets: ['organization'] },
  governs: { sources: ['institution'], targets: ['district', 'organization'] },
  instantiates: { sources: ['player_character'], targets: ['actor_blueprint'] },
  located_in: {
    sources: ['actor_blueprint', 'institution', 'organization', 'player_character'],
    targets: ['district'],
  },
  member_of: {
    sources: ['actor_blueprint', 'player_character'],
    targets: ['organization'],
  },
  participates_in: { sources: ['organization'], targets: ['institution'] },
  rivals: { sources: ['organization'], targets: ['organization'] },
  supplies: {
    sources: ['organization'],
    targets: ['district', 'institution', 'organization'],
  },
  uses_primitive: { targets: ['primitive_instance'] },
};

export function relationshipEndpointTypesAreValid(
  relationshipType: WorldRelationshipV1['relationshipType'],
  sourceType: WorldEntityType,
  targetType: WorldEntityType,
): boolean {
  const rule = relationshipEndpointRules[relationshipType];
  return (
    (!rule.sources || rule.sources.includes(sourceType)) &&
    (!rule.targets || rule.targets.includes(targetType))
  );
}

export function linkLoweredWorld(lowered: LoweredWorld): StageResult<LoweredWorld> {
  const diagnostics: CompilerDiagnosticV1[] = [];
  const entities = new Map(lowered.entities.map((entity) => [entity.logicalKey, entity]));
  const entityKeyCount = new Set(lowered.entities.map((entity) => entity.logicalKey)).size;
  if (entityKeyCount !== lowered.entities.length) {
    diagnostics.push(
      compilerDiagnostic(
        'link',
        'DUPLICATE_ENTITY_LOGICAL_KEY',
        '/entities',
        'Compiled entity logical keys must be globally unique.',
      ),
    );
  }
  const relationshipKeys = new Set<string>();
  for (const [index, relationship] of lowered.relationships.entries()) {
    if (relationshipKeys.has(relationship.logicalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'link',
          'DUPLICATE_RELATIONSHIP_LOGICAL_KEY',
          `/relationships/${index}/logicalKey`,
          'Compiled relationship logical keys must be globally unique.',
          { relatedKeys: [relationship.logicalKey] },
        ),
      );
    }
    relationshipKeys.add(relationship.logicalKey);
    const source = entities.get(relationship.sourceLogicalKey);
    const target = entities.get(relationship.targetLogicalKey);
    if (!source || !target) {
      diagnostics.push(
        compilerDiagnostic(
          'link',
          'DANGLING_RELATIONSHIP_ENDPOINT',
          `/relationships/${index}`,
          'Every relationship endpoint must resolve to a compiled entity.',
          {
            relatedKeys: [relationship.sourceLogicalKey, relationship.targetLogicalKey],
          },
        ),
      );
      continue;
    }
    if (
      !relationshipEndpointTypesAreValid(
        relationship.relationshipType,
        source.entityType,
        target.entityType,
      )
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'link',
          'RELATIONSHIP_ENDPOINT_TYPE_INVALID',
          `/relationships/${index}`,
          'Relationship endpoint entity types do not satisfy the compiler adapter contract.',
          { relatedKeys: [source.logicalKey, target.logicalKey] },
        ),
      );
    }
  }
  for (const [index, controller] of lowered.controllers.entries()) {
    const entity = entities.get(controller.entityLogicalKey);
    const accountKey = stableLogicalKey('account', controller.principalKey);
    if (!entity || entity.entityType !== 'player_character') {
      diagnostics.push(
        compilerDiagnostic(
          'link',
          'CONTROLLER_TARGET_INVALID',
          `/controllers/${index}/entityLogicalKey`,
          'Controller intents must target an existing player character.',
          { relatedKeys: [controller.entityLogicalKey] },
        ),
      );
    }
    const hasControlEdge = lowered.relationships.some(
      (relationship) =>
        relationship.relationshipType === 'account_controls' &&
        relationship.sourceLogicalKey === accountKey &&
        relationship.targetLogicalKey === controller.entityLogicalKey,
    );
    if (!hasControlEdge) {
      diagnostics.push(
        compilerDiagnostic(
          'link',
          'CONTROLLER_EDGE_MISSING',
          `/controllers/${index}`,
          'Every controller binding requires a matching account_controls graph edge.',
          { relatedKeys: [accountKey, controller.entityLogicalKey] },
        ),
      );
    }
  }
  if (lowered.entities.length > lowered.normalized.bundle.compilerConfig.maxEntities) {
    diagnostics.push(
      compilerDiagnostic(
        'link',
        'ENTITY_LIMIT_EXCEEDED',
        '/entities',
        'Compiled world exceeds the configured entity limit.',
      ),
    );
  }
  if (lowered.relationships.length > lowered.normalized.bundle.compilerConfig.maxRelationships) {
    diagnostics.push(
      compilerDiagnostic(
        'link',
        'RELATIONSHIP_LIMIT_EXCEEDED',
        '/relationships',
        'Compiled world exceeds the configured relationship limit.',
      ),
    );
  }
  const sorted = sortCompilerDiagnostics(diagnostics);
  return { diagnostics: sorted, value: hasCompilerErrors(sorted) ? null : lowered };
}
