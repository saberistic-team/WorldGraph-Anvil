import type {
  ActiveMemberPrincipalV1,
  CompiledArtifactV3,
  CompilerDiagnosticV1,
  CompilerInputBundleV1,
  ExactPrimitiveInputV1,
  WorldEntityV1,
  WorldManifestV1,
  WorldRelationshipV1,
} from '@worldgraph/contracts';

export interface StageResult<T> {
  diagnostics: CompilerDiagnosticV1[];
  value: T | null;
}

export interface ResolvedCompilerInput {
  bundle: CompilerInputBundleV1;
  orderedPrimitives: ExactPrimitiveInputV1[];
}

export interface NormalizedCompilerInput {
  activeMembers: ActiveMemberPrincipalV1[];
  bundle: CompilerInputBundleV1;
  manifest: WorldManifestV1;
  orderedPrimitives: ExactPrimitiveInputV1[];
}

export interface LoweredWorld {
  controllers: {
    controlScope: 'primary';
    entityLogicalKey: string;
    principalKey: string;
  }[];
  entities: WorldEntityV1[];
  normalized: NormalizedCompilerInput;
  relationships: WorldRelationshipV1[];
  visualPlan: {
    direction: string;
    districts: {
      districtLogicalKey: string;
      rotationMilliDegrees: number;
      xMilliunits: number;
      yMilliunits: number;
    }[];
    schemaVersion: 1;
    stylePrimitiveLogicalKey: string;
    terrainPrimitiveLogicalKey: string;
  };
}

export interface CompileWorldResult {
  artifact: CompiledArtifactV3 | null;
  diagnostics: CompilerDiagnosticV1[];
  inputHash: string;
  successfulStage: 'none' | 'resolve' | 'validate' | 'normalize' | 'lower' | 'link' | 'emit';
}
