import { ManifestProviderError, type ManifestGenerationProvider } from '@worldgraph/manifests';

export const DISABLED_MANIFEST_PROVIDER_CONFIGURATION_ID = 'disabled-v1' as const;

/**
 * Production M04 deliberately ships with remote generation disabled. The
 * provider port still exists and is exercised by contract tests; orchestration
 * selects the reviewed deterministic fallback without invoking this method.
 */
export function createDisabledManifestGenerationProvider(): ManifestGenerationProvider {
  return {
    configuration: {
      configurationId: DISABLED_MANIFEST_PROVIDER_CONFIGURATION_ID,
      enabled: false,
      model: 'city-state-template-v1',
      modelCapabilities: { network: false, tools: false },
      provider: 'worldgraph-fallback',
    },
    async generate() {
      throw new ManifestProviderError(
        'PROVIDER_DISABLED',
        false,
        'The remote manifest provider is disabled.',
      );
    },
  };
}
