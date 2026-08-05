import { describe, expect, it } from 'vitest';

import type { GeographySeedPlanV1 } from '@worldgraph/contracts';

import {
  assertGeographySeedPlanV1,
  buildVisualScenePlanV1,
  geographySeedPlanHashV1,
  pointInRing,
  ringsOverlap,
} from './index.js';

function square(minX: number, minY: number, maxX: number, maxY: number) {
  return [
    { xMilli: minX, yMilli: minY },
    { xMilli: maxX, yMilli: minY },
    { xMilli: maxX, yMilli: maxY },
    { xMilli: minX, yMilli: maxY },
    { xMilli: minX, yMilli: minY },
  ];
}

function samplePlan(): GeographySeedPlanV1 {
  return {
    buildings: [
      {
        archetype: 'building.workshop',
        centroidXMilli: -20_000,
        centroidYMilli: 0,
        elevationMilli: 0,
        entityLogicalKey: 'organization:harbor-workshop',
        footprintHalfDepthMilli: 2_000,
        footprintHalfWidthMilli: 2_000,
        parcelKey: 'parcel:west-lot',
        stableKey: 'building:workshop',
        yawMilliDegrees: 0,
      },
      {
        archetype: 'building.council',
        centroidXMilli: 20_000,
        centroidYMilli: 0,
        elevationMilli: 0,
        entityLogicalKey: 'institution:harbor-council',
        footprintHalfDepthMilli: 2_500,
        footprintHalfWidthMilli: 2_500,
        parcelKey: 'parcel:east-lot',
        stableKey: 'building:council',
        yawMilliDegrees: 45_000,
      },
    ],
    districts: [
      {
        parentTerritoryKey: 'territory:harbor',
        ring: square(-40_000, -40_000, -1_000, 40_000),
        stableKey: 'district:west',
        zoning: 'industrial.harbor',
      },
      {
        parentTerritoryKey: 'territory:harbor',
        ring: square(1_000, -40_000, 40_000, 40_000),
        stableKey: 'district:east',
        zoning: 'civic.council',
      },
    ],
    geographySeedPlanSchemaVersion: 1,
    parcels: [
      {
        districtKey: 'district:west',
        parcelType: 'workshop',
        ring: square(-30_000, -10_000, -10_000, 10_000),
        stableKey: 'parcel:west-lot',
      },
      {
        districtKey: 'district:east',
        parcelType: 'civic',
        ring: square(10_000, -10_000, 30_000, 10_000),
        stableKey: 'parcel:east-lot',
      },
    ],
    pointsOfInterest: [
      {
        entityLogicalKey: 'district:west',
        kind: 'poi.harbor',
        radiusMilli: 1_000,
        stableKey: 'poi:harbor-mouth',
        xMilli: -35_000,
        yMilli: 0,
      },
    ],
    roads: [
      {
        class: 'primary',
        fromDistrictKey: 'district:west',
        path: [
          { xMilli: -20_000, yMilli: 0 },
          { xMilli: 20_000, yMilli: 0 },
        ],
        stableKey: 'road:main',
        toDistrictKey: 'district:east',
        widthMilli: 4_000,
      },
    ],
    // road endpoints remain inside each district; the gap between districts is intentional
    spatialReference: {
      boundsMaxXMilli: 50_000,
      boundsMaxYMilli: 50_000,
      boundsMinXMilli: -50_000,
      boundsMinYMilli: -50_000,
      originXMilli: 0,
      originYMilli: 0,
      srid: 3857,
      units: 'meters',
    },
    spawnPoints: [
      {
        accessPolicy: 'public',
        priority: 1,
        radiusMilli: 1_500,
        stableKey: 'spawn:plaza',
        xMilli: 0,
        yMilli: 20_000,
      },
    ],
    territory: {
      ring: square(-45_000, -45_000, 45_000, 45_000),
      stableKey: 'territory:harbor',
    },
  };
}

describe('geography domain', () => {
  it('hashes identical plans identically and builds a deterministic scene plan', () => {
    const plan = samplePlan();
    const left = geographySeedPlanHashV1(plan);
    const right = geographySeedPlanHashV1(structuredClone(plan));
    expect(left).toBe(right);
    const sceneA = buildVisualScenePlanV1(plan, { seed: 'harbor-1', styleKitVersion: 1 });
    const sceneB = buildVisualScenePlanV1(plan, { seed: 'harbor-1', styleKitVersion: 1 });
    expect(sceneA.hash).toBe(sceneB.hash);
    expect(sceneA.plan.nodes.length).toBeGreaterThan(5);
  });

  it('detects containment and overlap', () => {
    const outer = square(-10, -10, 10, 10);
    const inner = square(-5, -5, 5, 5);
    const other = square(20, 20, 30, 30);
    expect(pointInRing({ xMilli: 0, yMilli: 0 }, outer)).toBe(true);
    expect(ringsOverlap(outer, inner)).toBe(true);
    expect(ringsOverlap(outer, other)).toBe(false);
  });

  it('rejects overlapping districts and missing public spawns', () => {
    const overlapping = samplePlan();
    overlapping.districts[1]!.ring = square(-30_000, -40_000, 40_000, 40_000);
    expect(() => assertGeographySeedPlanV1(overlapping)).toThrow(/overlap/i);

    const noSpawn = samplePlan();
    noSpawn.spawnPoints = [
      {
        accessPolicy: 'member',
        priority: 1,
        radiusMilli: 1_000,
        stableKey: 'spawn:private',
        xMilli: 0,
        yMilli: 20_000,
      },
    ];
    expect(() => assertGeographySeedPlanV1(noSpawn)).toThrow(/public spawn/i);
  });
});
