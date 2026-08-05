import type { GeographySeedPlanV1 } from '@worldgraph/contracts';
import {
  GeographyDomainError,
  assertGeographySeedPlanV1,
  geographySeedPlanHashV1,
} from '@worldgraph/geography';

import { compilerDiagnostic } from './diagnostics.js';
import type { LoweredWorld, StageResult } from './types.js';

export const COMPILED_GEOGRAPHY_SEED_ADAPTER_ID = 'CompiledGeographySeedAdapterV1' as const;
export const GEOGRAPHY_SEED_ADAPTER_VERSION = '1.0.0' as const;

function diagnostic(code: string, pointer: string, message: string, keys: string[] = []) {
  return compilerDiagnostic('emit', code, pointer, message, { relatedKeys: keys });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function square(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): GeographySeedPlanV1['territory']['ring'] {
  return [
    { xMilli: minX, yMilli: minY },
    { xMilli: maxX, yMilli: minY },
    { xMilli: maxX, yMilli: maxY },
    { xMilli: minX, yMilli: maxY },
    { xMilli: minX, yMilli: minY },
  ];
}

/**
 * Native compiler 1.4 adapter. Builds a deterministic city footprint from
 * compiled districts, organizations, and institutions. Cosmetic gaps use
 * explicit placeholder archetypes; critical topology failures block emit.
 */
export function deriveLoweredGeographySeedPlanV1(
  lowered: LoweredWorld,
): StageResult<{ hash: string; plan: GeographySeedPlanV1 }> {
  const districts = lowered.entities
    .filter((entity) => entity.entityType === 'district')
    .sort((left, right) => compareText(left.logicalKey, right.logicalKey));
  if (districts.length < 1) {
    return {
      diagnostics: [
        diagnostic(
          'GEOGRAPHY_DISTRICTS_REQUIRED',
          '/entities',
          'Geography compilation requires at least one district entity.',
        ),
      ],
      value: null,
    };
  }

  const organizations = lowered.entities
    .filter((entity) => entity.entityType === 'organization')
    .sort((left, right) => compareText(left.logicalKey, right.logicalKey));
  const institutions = lowered.entities
    .filter((entity) => entity.entityType === 'institution')
    .sort((left, right) => compareText(left.logicalKey, right.logicalKey));

  const cell = 40_000;
  const half = Math.ceil(Math.sqrt(districts.length));
  const territoryPad = cell * half + 10_000;
  const seedDistricts: GeographySeedPlanV1['districts'] = districts.map((district, index) => {
    const col = index % half;
    const row = Math.floor(index / half);
    const minX = col * cell - (half * cell) / 2;
    const minY = row * cell - (half * cell) / 2;
    return {
      parentTerritoryKey: 'territory:city',
      ring: square(minX + 1_000, minY + 1_000, minX + cell - 1_000, minY + cell - 1_000),
      stableKey: district.logicalKey,
      zoning: index === 0 ? 'harbor.industrial' : index === 1 ? 'civic.council' : 'market.general',
    };
  });

  const parcels: GeographySeedPlanV1['parcels'] = [];
  const buildings: GeographySeedPlanV1['buildings'] = [];
  const pointsOfInterest: GeographySeedPlanV1['pointsOfInterest'] = [];

  for (const [index, district] of seedDistricts.entries()) {
    const bounds = district.ring;
    const minX = Math.min(...bounds.map((point) => point.xMilli));
    const maxX = Math.max(...bounds.map((point) => point.xMilli));
    const minY = Math.min(...bounds.map((point) => point.yMilli));
    const maxY = Math.max(...bounds.map((point) => point.yMilli));
    const centerX = Math.trunc((minX + maxX) / 2);
    const centerY = Math.trunc((minY + maxY) / 2);
    const parcelKey = `parcel:${district.stableKey}`;
    parcels.push({
      districtKey: district.stableKey,
      parcelType: index === 0 ? 'workshop' : index === 1 ? 'civic' : 'market',
      ring: square(centerX - 8_000, centerY - 8_000, centerX + 8_000, centerY + 8_000),
      stableKey: parcelKey,
    });

    const organization = organizations[index];
    const institution = institutions[index];
    const entityLogicalKey =
      organization?.logicalKey ?? institution?.logicalKey ?? district.stableKey;
    const archetype =
      index === 0 ? 'building.workshop' : index === 1 ? 'building.council' : 'building.market';
    buildings.push({
      archetype,
      centroidXMilli: centerX,
      centroidYMilli: centerY,
      elevationMilli: 0,
      entityLogicalKey,
      footprintHalfDepthMilli: 3_000,
      footprintHalfWidthMilli: 3_000,
      parcelKey,
      stableKey: `building:${district.stableKey}`,
      yawMilliDegrees: (index * 45_000) % 360_000,
    });
    pointsOfInterest.push({
      entityLogicalKey: district.stableKey,
      kind: index === 0 ? 'poi.harbor' : index === 1 ? 'poi.council' : 'poi.market',
      radiusMilli: 1_500,
      stableKey: `poi:${district.stableKey}`,
      xMilli: centerX,
      yMilli: Math.min(centerY + 12_000, maxY - 2_000),
    });
  }

  const roads: GeographySeedPlanV1['roads'] = [];
  for (let index = 0; index < seedDistricts.length - 1; index += 1) {
    const from = seedDistricts[index]!;
    const to = seedDistricts[index + 1]!;
    const fromCenterX =
      (Math.min(...from.ring.map((point) => point.xMilli)) +
        Math.max(...from.ring.map((point) => point.xMilli))) /
      2;
    const fromCenterY =
      (Math.min(...from.ring.map((point) => point.yMilli)) +
        Math.max(...from.ring.map((point) => point.yMilli))) /
      2;
    const toCenterX =
      (Math.min(...to.ring.map((point) => point.xMilli)) +
        Math.max(...to.ring.map((point) => point.xMilli))) /
      2;
    const toCenterY =
      (Math.min(...to.ring.map((point) => point.yMilli)) +
        Math.max(...to.ring.map((point) => point.yMilli))) /
      2;
    roads.push({
      class: index === 0 ? 'primary' : 'secondary',
      fromDistrictKey: from.stableKey,
      path: [
        { xMilli: Math.trunc(fromCenterX), yMilli: Math.trunc(fromCenterY) },
        { xMilli: Math.trunc(toCenterX), yMilli: Math.trunc(toCenterY) },
      ],
      stableKey: `road:${from.stableKey}:${to.stableKey}`,
      toDistrictKey: to.stableKey,
      widthMilli: 4_000,
    });
  }
  if (roads.length < 1 && seedDistricts.length === 1) {
    const only = seedDistricts[0]!;
    const centerX =
      (Math.min(...only.ring.map((point) => point.xMilli)) +
        Math.max(...only.ring.map((point) => point.xMilli))) /
      2;
    const minY = Math.min(...only.ring.map((point) => point.yMilli));
    const maxY = Math.max(...only.ring.map((point) => point.yMilli));
    roads.push({
      class: 'path',
      fromDistrictKey: only.stableKey,
      path: [
        { xMilli: Math.trunc(centerX), yMilli: minY + 2_000 },
        { xMilli: Math.trunc(centerX), yMilli: maxY - 2_000 },
      ],
      stableKey: `road:${only.stableKey}:loop`,
      toDistrictKey: only.stableKey,
      widthMilli: 3_000,
    });
  }

  const firstDistrict = seedDistricts[0]!;
  const spawnX =
    (Math.min(...firstDistrict.ring.map((point) => point.xMilli)) +
      Math.max(...firstDistrict.ring.map((point) => point.xMilli))) /
    2;
  const spawnY = Math.min(...firstDistrict.ring.map((point) => point.yMilli)) + 4_000;

  const plan: GeographySeedPlanV1 = {
    buildings,
    districts: seedDistricts,
    geographySeedPlanSchemaVersion: 1,
    parcels,
    pointsOfInterest,
    roads,
    spatialReference: {
      boundsMaxXMilli: territoryPad,
      boundsMaxYMilli: territoryPad,
      boundsMinXMilli: -territoryPad,
      boundsMinYMilli: -territoryPad,
      originXMilli: 0,
      originYMilli: 0,
      srid: 3857,
      units: 'meters',
    },
    spawnPoints: [
      {
        accessPolicy: 'public',
        priority: 1,
        radiusMilli: 2_000,
        stableKey: 'spawn:arrival',
        xMilli: Math.trunc(spawnX),
        yMilli: Math.trunc(spawnY),
      },
    ],
    territory: {
      ring: square(
        -territoryPad + 1_000,
        -territoryPad + 1_000,
        territoryPad - 1_000,
        territoryPad - 1_000,
      ),
      stableKey: 'territory:city',
    },
  };

  try {
    const canonical = assertGeographySeedPlanV1(plan);
    return {
      diagnostics: [],
      value: { hash: geographySeedPlanHashV1(canonical), plan: canonical },
    };
  } catch (error) {
    const message =
      error instanceof GeographyDomainError ? error.message : 'Geography seed plan invalid.';
    return {
      diagnostics: [diagnostic('GEOGRAPHY_SEED_INVALID', '/geographySeedPlan', message)],
      value: null,
    };
  }
}
