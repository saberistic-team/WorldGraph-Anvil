import type { PrimitiveDraftInput, PrimitiveKind } from '@worldgraph/contracts';

export interface CompilerAdapter {
  behaviorRef: string | null;
  kind: PrimitiveKind;
  registryVersion: 1;
}

const behaviorByKind = {
  building: null,
  currency: 'economy.closed_loop_currency',
  district: null,
  election: 'governance.council_ballot',
  event_template: 'simulation.scheduled_event',
  government: 'governance.council',
  legal_right: null,
  office: null,
  organization: null,
  player_role: null,
  production_recipe: 'economy.production_recipe',
  resource: 'world.resource_stock',
  simulation_rule: 'simulation.discrete_clock',
  tax: 'economy.flat_transaction_tax',
  terrain: null,
  visual_style: null,
} as const satisfies Record<PrimitiveKind, string | null>;

export const COMPILER_ADAPTER_REGISTRY: ReadonlyMap<string, CompilerAdapter> = new Map(
  Object.entries(behaviorByKind).map(([kind, behaviorRef]) => [
    `${kind}:${behaviorRef ?? 'data'}`,
    { behaviorRef, kind: kind as PrimitiveKind, registryVersion: 1 },
  ]),
);

export function compilerAdapterKey(primitive: PrimitiveDraftInput): string {
  return `${primitive.kind}:${primitive.behaviorRef ?? 'data'}`;
}

export function compilerAdapterFor(primitive: PrimitiveDraftInput): CompilerAdapter | null {
  return COMPILER_ADAPTER_REGISTRY.get(compilerAdapterKey(primitive)) ?? null;
}
