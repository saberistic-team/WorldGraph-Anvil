import type { CompiledWorld, CompilerDiagnosticV1, WorldEntityV1 } from '@worldgraph/contracts';

import { compilerDiagnostic, sortCompilerDiagnostics } from './diagnostics.js';
import { relationshipEndpointTypesAreValid } from './link.js';
import { validateCompilerPrivateContent } from './privacy.js';

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicateAndOrderDiagnostics(
  values: readonly string[],
  pointer: string,
  duplicateCode: string,
  orderCode: string,
  noun: string,
): CompilerDiagnosticV1[] {
  const diagnostics: CompilerDiagnosticV1[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          duplicateCode,
          `${pointer}/${index}`,
          `Compiled ${noun} keys must be unique.`,
          { relatedKeys: [value] },
        ),
      );
    }
    seen.add(value);
    const previous = values[index - 1];
    if (previous !== undefined && compareText(previous, value) > 0) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          orderCode,
          `${pointer}/${index}`,
          `Compiled ${noun} keys must be in canonical code-point order.`,
          { relatedKeys: [previous, value] },
        ),
      );
    }
  }
  return diagnostics;
}

function playableAccountMatchesCharacter(
  account: WorldEntityV1 | undefined,
  character: WorldEntityV1,
  principalKey: string,
): boolean {
  return (
    account?.entityType === 'account_principal' &&
    character.entityType === 'player_character' &&
    account.state.principalKey === principalKey &&
    account.state.membershipRole === character.state.membershipRole
  );
}

/**
 * Verifies graph invariants that JSON Schema cannot express. The function is
 * deterministic and side-effect free so the emitter, offline CLI, worker, and
 * any future artifact consumer can share exactly the same trust boundary.
 */
export function validateCompiledWorldSemantics(world: CompiledWorld): CompilerDiagnosticV1[] {
  const diagnostics: CompilerDiagnosticV1[] = validateCompilerPrivateContent(world, '', 'emit');
  const counts = {
    controllers: world.controllers.length,
    entities: world.entities.length,
    relationships: world.relationships.length,
  };
  if (
    counts.controllers !== world.counts.controllers ||
    counts.entities !== world.counts.entities ||
    counts.relationships !== world.counts.relationships
  ) {
    diagnostics.push(
      compilerDiagnostic(
        'emit',
        'COMPILED_COUNTS_MISMATCH',
        '/counts',
        'Compiled graph counts must exactly match their corresponding arrays.',
      ),
    );
  }

  diagnostics.push(
    ...duplicateAndOrderDiagnostics(
      world.entities.map((entity) => entity.logicalKey),
      '/entities',
      'DUPLICATE_ENTITY_LOGICAL_KEY',
      'ENTITY_KEYS_NOT_SORTED',
      'entity',
    ),
    ...duplicateAndOrderDiagnostics(
      world.relationships.map((relationship) => relationship.logicalKey),
      '/relationships',
      'DUPLICATE_RELATIONSHIP_LOGICAL_KEY',
      'RELATIONSHIP_KEYS_NOT_SORTED',
      'relationship',
    ),
  );

  const entities = new Map(world.entities.map((entity) => [entity.logicalKey, entity]));
  for (const [index, relationship] of world.relationships.entries()) {
    const source = entities.get(relationship.sourceLogicalKey);
    const target = entities.get(relationship.targetLogicalKey);
    if (!source || !target) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'DANGLING_RELATIONSHIP_ENDPOINT',
          `/relationships/${index}`,
          'Every compiled relationship endpoint must resolve to an entity.',
          { relatedKeys: [relationship.sourceLogicalKey, relationship.targetLogicalKey] },
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
          'emit',
          'RELATIONSHIP_ENDPOINT_TYPE_INVALID',
          `/relationships/${index}`,
          'Compiled relationship endpoints do not match the declared relationship type.',
          { relatedKeys: [source.logicalKey, target.logicalKey] },
        ),
      );
    }
  }

  const principalKeys = world.controllers.map((controller) => controller.principalKey);
  diagnostics.push(
    ...duplicateAndOrderDiagnostics(
      principalKeys,
      '/controllers',
      'DUPLICATE_CONTROLLER_PRINCIPAL',
      'CONTROLLER_KEYS_NOT_SORTED',
      'controller principal',
    ),
  );
  const controlledEntityKeys = new Set<string>();
  for (const [index, controller] of world.controllers.entries()) {
    const expectedCharacterKey = `character:${controller.principalKey}`;
    if (controlledEntityKeys.has(controller.entityLogicalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'DUPLICATE_CONTROLLER_ENTITY',
          `/controllers/${index}/entityLogicalKey`,
          'A compiled entity may have at most one primary controller.',
          { relatedKeys: [controller.entityLogicalKey] },
        ),
      );
    }
    controlledEntityKeys.add(controller.entityLogicalKey);
    if (controller.entityLogicalKey !== expectedCharacterKey) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'CONTROLLER_CHARACTER_IDENTITY_MISMATCH',
          `/controllers/${index}/entityLogicalKey`,
          'A controller must target the character derived from the same world-local principal.',
          { relatedKeys: [controller.entityLogicalKey, expectedCharacterKey] },
        ),
      );
    }
    const character = entities.get(controller.entityLogicalKey);
    if (!character || character.entityType !== 'player_character') {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'CONTROLLER_TARGET_INVALID',
          `/controllers/${index}/entityLogicalKey`,
          'A compiled controller must target an existing player character.',
          { relatedKeys: [controller.entityLogicalKey] },
        ),
      );
      continue;
    }
    const accountKey = `account:${controller.principalKey}`;
    const account = entities.get(accountKey);
    if (!playableAccountMatchesCharacter(account, character, controller.principalKey)) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'CONTROLLER_ACCOUNT_INVALID',
          `/controllers/${index}/principalKey`,
          'A controller must have a matching playable account principal and membership role.',
          { relatedKeys: [accountKey, character.logicalKey] },
        ),
      );
    }
    const hasControlEdge = world.relationships.some(
      (relationship) =>
        relationship.relationshipType === 'account_controls' &&
        relationship.sourceLogicalKey === accountKey &&
        relationship.targetLogicalKey === character.logicalKey,
    );
    if (!hasControlEdge) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'CONTROLLER_EDGE_MISSING',
          `/controllers/${index}`,
          'A controller requires an exact account_controls relationship.',
          { relatedKeys: [accountKey, character.logicalKey] },
        ),
      );
    }
  }

  for (const [index, relationship] of world.relationships.entries()) {
    if (relationship.relationshipType !== 'account_controls') continue;
    const account = entities.get(relationship.sourceLogicalKey);
    const principalKey =
      account?.entityType === 'account_principal' ? account.state.principalKey : null;
    const hasController =
      principalKey !== null &&
      world.controllers.some(
        (controller) =>
          controller.principalKey === principalKey &&
          controller.entityLogicalKey === relationship.targetLogicalKey,
      );
    if (!hasController) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'ACCOUNT_CONTROL_CONTROLLER_MISSING',
          `/relationships/${index}`,
          'Every account_controls relationship requires an exact controller intent.',
          { relatedKeys: [relationship.sourceLogicalKey, relationship.targetLogicalKey] },
        ),
      );
    }
  }

  const controlRelationships = world.relationships.filter(
    (relationship) => relationship.relationshipType === 'account_controls',
  );
  for (const [index, entity] of world.entities.entries()) {
    if (entity.entityType === 'account_principal') {
      const principalKey = entity.state.principalKey;
      const expectedAccountKey = `account:${principalKey}`;
      const expectedCharacterKey = `character:${principalKey}`;
      if (entity.logicalKey !== expectedAccountKey) {
        diagnostics.push(
          compilerDiagnostic(
            'emit',
            'ACCOUNT_PRINCIPAL_IDENTITY_MISMATCH',
            `/entities/${index}/logicalKey`,
            'An account principal logical key must be derived from its world-local principal.',
            { relatedKeys: [entity.logicalKey, expectedAccountKey] },
          ),
        );
      }
      const character = entities.get(expectedCharacterKey);
      if (
        !character ||
        character.entityType !== 'player_character' ||
        character.state.membershipRole !== entity.state.membershipRole
      ) {
        diagnostics.push(
          compilerDiagnostic(
            'emit',
            'ACCOUNT_CHARACTER_BINDING_INVALID',
            `/entities/${index}`,
            'Every account principal requires its exact same-role player character.',
            { relatedKeys: [entity.logicalKey, expectedCharacterKey] },
          ),
        );
      }
      const controllerCount = world.controllers.filter(
        (controller) =>
          controller.principalKey === principalKey &&
          controller.entityLogicalKey === expectedCharacterKey,
      ).length;
      const edgeCount = controlRelationships.filter(
        (relationship) =>
          relationship.sourceLogicalKey === expectedAccountKey &&
          relationship.targetLogicalKey === expectedCharacterKey,
      ).length;
      if (controllerCount !== 1 || edgeCount !== 1) {
        diagnostics.push(
          compilerDiagnostic(
            'emit',
            'ACCOUNT_CONTROL_BINDING_INCOMPLETE',
            `/entities/${index}`,
            'Every account principal requires exactly one matching controller and account-controls edge.',
            { relatedKeys: [expectedAccountKey, expectedCharacterKey] },
          ),
        );
      }
      continue;
    }
    if (entity.entityType !== 'player_character') continue;
    const match = /^character:(member-[a-f0-9]{32})$/u.exec(entity.logicalKey);
    const principalKey = match?.[1];
    if (!principalKey) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'PLAYER_CHARACTER_IDENTITY_INVALID',
          `/entities/${index}/logicalKey`,
          'A player character logical key must identify its world-local member principal.',
          { relatedKeys: [entity.logicalKey] },
        ),
      );
      continue;
    }
    const accountKey = `account:${principalKey}`;
    const account = entities.get(accountKey);
    if (
      !account ||
      account.entityType !== 'account_principal' ||
      account.state.principalKey !== principalKey ||
      account.state.membershipRole !== entity.state.membershipRole
    ) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'PLAYER_CHARACTER_ACCOUNT_BINDING_INVALID',
          `/entities/${index}`,
          'Every player character requires its exact same-role account principal.',
          { relatedKeys: [accountKey, entity.logicalKey] },
        ),
      );
    }
    const controllerCount = world.controllers.filter(
      (controller) =>
        controller.principalKey === principalKey &&
        controller.entityLogicalKey === entity.logicalKey,
    ).length;
    const edgeCount = controlRelationships.filter(
      (relationship) =>
        relationship.sourceLogicalKey === accountKey &&
        relationship.targetLogicalKey === entity.logicalKey,
    ).length;
    if (controllerCount !== 1 || edgeCount !== 1) {
      diagnostics.push(
        compilerDiagnostic(
          'emit',
          'PLAYER_CHARACTER_CONTROL_BINDING_INCOMPLETE',
          `/entities/${index}`,
          'Every player character requires exactly one matching controller and account-controls edge.',
          { relatedKeys: [accountKey, entity.logicalKey] },
        ),
      );
    }
  }

  return sortCompilerDiagnostics(diagnostics).slice(0, 128);
}
