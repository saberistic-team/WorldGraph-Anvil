import { canonicalJson, type CompiledArtifactV4 } from '@worldgraph/contracts';
import { describe, expect, it } from 'vitest';

import { compilerInputHash, sha256Utf8, verifyCompiledArtifact } from './hash.js';
import { compileWorld } from './pipeline.js';
import { validateCompilerPrivateContent } from './privacy.js';
import { createGoldenCompilerInput } from './test-fixture.js';

function compileWithDescription(description: string) {
  const input = createGoldenCompilerInput();
  input.manifest.metadata.description = description;
  refreshInputIdentity(input);
  return compileWorld(input);
}

function refreshInputIdentity(input: ReturnType<typeof createGoldenCompilerInput>): void {
  input.manifestCanonicalBytes = canonicalJson(input.manifest);
  input.manifestContentHash = sha256Utf8(input.manifestCanonicalBytes);
  input.inputHash = compilerInputHash(input);
}

function resign(artifact: CompiledArtifactV4): CompiledArtifactV4 {
  artifact.canonicalBytes = canonicalJson(artifact.world);
  artifact.contentHash = sha256Utf8(artifact.canonicalBytes);
  return artifact;
}

describe('compiler artifact privacy boundary', () => {
  it.each([
    ['PRIVATE_EMAIL_DETECTED', 'Contact private.person@example.test for access.'],
    ['PRIVATE_EMAIL_DETECTED', 'Contact 用户@example.com for access.'],
    ['PRIVATE_EMAIL_DETECTED', 'Contact private.person@例子.测试 for access.'],
    ['PRIVATE_NETWORK_ADDRESS_DETECTED', 'Connect to 203.0.113.42 for access.'],
    ['PRIVATE_NETWORK_ADDRESS_DETECTED', 'Connect to 2001:db8::42 for access.'],
    ['PRIVATE_CREDENTIAL_CONTENT_DETECTED', 'authorization=Bearer abcdefghijklmnop'],
    ['PRIVATE_CREDENTIAL_CONTENT_DETECTED', 'prompt: reproduce the private source request'],
    [
      'PRIVATE_CREDENTIAL_CONTENT_DETECTED',
      'https://example.test/invitations/accept#private-invitation-token',
    ],
  ])('rejects %s in otherwise schema-valid approved content', (code, description) => {
    const result = compileWithDescription(description);
    expect(result.artifact).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
    expect(JSON.stringify(result.diagnostics)).not.toContain('private.person@example.test');
    expect(JSON.stringify(result.diagnostics)).not.toContain('203.0.113.42');
  });

  it.each([
    'Contact private.person@example.test for access.',
    'Contact private.person@例子.测试 for access.',
  ])('rejects a rehashed artifact containing private string content', (description) => {
    const artifact = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    artifact.world.metadata.description = description;
    const verification = verifyCompiledArtifact(resign(artifact));
    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PRIVATE_EMAIL_DETECTED',
    );
    expect(JSON.stringify(verification.diagnostics)).not.toContain(description);
  });

  it('rejects a compound private field through the schema-valid compile boundary', () => {
    const input = createGoldenCompilerInput();
    input.manifest.simulation.settings.accessToken = 'opaque-value';
    refreshInputIdentity(input);

    const result = compileWorld(input);

    expect(result.artifact).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PRIVATE_FIELD_NAME_DETECTED',
    );
  });

  it('rejects private content used as a schema-valid object key', () => {
    const input = createGoldenCompilerInput();
    input.manifest.simulation.settings['用户@example.com'] = 'opaque-value';
    refreshInputIdentity(input);

    const result = compileWorld(input);

    expect(result.artifact).toBeNull();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PRIVATE_EMAIL_DETECTED',
    );
  });

  it('rejects a rehashed artifact containing private content in an object key', () => {
    const artifact = structuredClone(compileWorld(createGoldenCompilerInput()).artifact!);
    const simulation = artifact.world.entities.find(
      (entity) => entity.entityType === 'simulation_configuration',
    );
    expect(simulation?.entityType).toBe('simulation_configuration');
    if (!simulation || simulation.entityType !== 'simulation_configuration') return;
    simulation.state.settings['用户@example.com'] = 'opaque-value';

    const verification = verifyCompiledArtifact(resign(artifact));

    expect(verification.valid).toBe(false);
    expect(verification.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PRIVATE_EMAIL_DETECTED',
    );
    expect(JSON.stringify(verification.diagnostics)).not.toContain('用户@example.com');
  });

  it('scans a maximum-sized ordinary string without regex backtracking', () => {
    expect(
      validateCompilerPrivateContent({ description: 'x'.repeat(131_072) }, '/manifest', 'validate'),
    ).toEqual([]);
  });

  it.each([
    'accessToken',
    'serviceCredential',
    'apiKeyHint',
    'sessionIdentifier',
    'inviteReference',
    'promptStyle',
    'userIdAlias',
    'emailNotification',
    'privateEmail',
    'authorizationHeader',
    'cookieValue',
  ])('rejects compound private field name %s', (fieldName) => {
    const diagnostics = validateCompilerPrivateContent(
      { [fieldName]: 'opaque-value' },
      '/manifest/settings',
      'validate',
    );
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      'PRIVATE_FIELD_NAME_DETECTED',
    );
  });

  it('permits only the reviewed fixed-width prompt provenance hash', () => {
    expect(
      validateCompilerPrivateContent(
        { promptHash: 'a'.repeat(64) },
        '/manifest/extensions/worldgraph.fallback',
        'validate',
      ),
    ).toEqual([]);
    expect(
      validateCompilerPrivateContent(
        { promptHash: 'not-a-reviewed-hash' },
        '/manifest/extensions/worldgraph.fallback',
        'validate',
      ).map((diagnostic) => diagnostic.code),
    ).toContain('PRIVATE_FIELD_NAME_DETECTED');
  });
});
