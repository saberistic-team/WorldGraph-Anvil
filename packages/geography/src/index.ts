import { createHash } from 'node:crypto';

import {
  GeographySeedPlanV1Schema,
  VisualScenePlanV1Schema,
  canonicalJson,
  createValidator,
  type GeographyPointMilliV1,
  type GeographySeedPlanV1,
  type VisualScenePlanV1,
} from '@worldgraph/contracts';

export type GeographyDomainErrorCode =
  | 'BOUNDS_INVALID'
  | 'GEOMETRY_INVALID'
  | 'INTEGER_OVERFLOW'
  | 'REFERENCE_INVALID'
  | 'SCENE_PLAN_INVALID'
  | 'SEED_PLAN_INVALID'
  | 'SPAWN_INVALID'
  | 'TOPOLOGY_INVALID';

export class GeographyDomainError extends Error {
  readonly code: GeographyDomainErrorCode;

  constructor(code: GeographyDomainErrorCode, message: string) {
    super(message);
    this.name = 'GeographyDomainError';
    this.code = code;
  }
}

const seedPlanValidator = createValidator<GeographySeedPlanV1>(GeographySeedPlanV1Schema);
const scenePlanValidator = createValidator<VisualScenePlanV1>(VisualScenePlanV1Schema);

type Point = GeographyPointMilliV1;
type Ring = readonly Point[];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(domain: string, value: unknown): string {
  return createHash('sha256').update(canonicalJson({ domain, value }), 'utf8').digest('hex');
}

export function quantizeMilli(value: number): number {
  if (!Number.isFinite(value)) {
    throw new GeographyDomainError('GEOMETRY_INVALID', 'Coordinate is not finite.');
  }
  if (value >= 0) return Math.floor(value + 0.5);
  return -Math.floor(-value + 0.5);
}

export function canonicalRing(points: Ring): Point[] {
  if (points.length < 4) {
    throw new GeographyDomainError('GEOMETRY_INVALID', 'Ring requires at least four points.');
  }
  const quantized = points.map((point) => ({
    xMilli: quantizeMilli(point.xMilli),
    yMilli: quantizeMilli(point.yMilli),
  }));
  const first = quantized[0]!;
  const last = quantized[quantized.length - 1]!;
  if (first.xMilli !== last.xMilli || first.yMilli !== last.yMilli) {
    quantized.push({ ...first });
  }
  if (quantized.length < 4) {
    throw new GeographyDomainError('GEOMETRY_INVALID', 'Closed ring is too short.');
  }
  const area = Math.abs(ringArea(quantized));
  if (area < 1) {
    throw new GeographyDomainError('GEOMETRY_INVALID', 'Ring area is empty.');
  }
  return quantized;
}

export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index]!;
    const next = ring[index + 1]!;
    sum += current.xMilli * next.yMilli - next.xMilli * current.yMilli;
  }
  return sum / 2;
}

export function ringBounds(ring: Ring): {
  maxXMilli: number;
  maxYMilli: number;
  minXMilli: number;
  minYMilli: number;
} {
  let minXMilli = Number.POSITIVE_INFINITY;
  let minYMilli = Number.POSITIVE_INFINITY;
  let maxXMilli = Number.NEGATIVE_INFINITY;
  let maxYMilli = Number.NEGATIVE_INFINITY;
  for (const point of ring) {
    minXMilli = Math.min(minXMilli, point.xMilli);
    minYMilli = Math.min(minYMilli, point.yMilli);
    maxXMilli = Math.max(maxXMilli, point.xMilli);
    maxYMilli = Math.max(maxYMilli, point.yMilli);
  }
  return { maxXMilli, maxYMilli, minXMilli, minYMilli };
}

export function pointInRing(point: Point, ring: Ring): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const intersects =
      current.yMilli > point.yMilli !== prior.yMilli > point.yMilli &&
      point.xMilli <
        ((prior.xMilli - current.xMilli) * (point.yMilli - current.yMilli)) /
          (prior.yMilli - current.yMilli || Number.EPSILON) +
          current.xMilli;
    if (intersects) inside = !inside;
  }
  return inside;
}

function segmentsIntersect(a1: Point, a2: Point, b1: Point, b2: Point): boolean {
  const orientation = (p: Point, q: Point, r: Point) => {
    const value =
      (q.yMilli - p.yMilli) * (r.xMilli - q.xMilli) - (q.xMilli - p.xMilli) * (r.yMilli - q.yMilli);
    if (value === 0) return 0;
    return value > 0 ? 1 : 2;
  };
  const onSegment = (p: Point, q: Point, r: Point) =>
    q.xMilli <= Math.max(p.xMilli, r.xMilli) &&
    q.xMilli >= Math.min(p.xMilli, r.xMilli) &&
    q.yMilli <= Math.max(p.yMilli, r.yMilli) &&
    q.yMilli >= Math.min(p.yMilli, r.yMilli);
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a1, b1, a2)) return true;
  if (o2 === 0 && onSegment(a1, b2, a2)) return true;
  if (o3 === 0 && onSegment(b1, a1, b2)) return true;
  if (o4 === 0 && onSegment(b1, a2, b2)) return true;
  return false;
}

export function ringsOverlap(left: Ring, right: Ring): boolean {
  const leftBounds = ringBounds(left);
  const rightBounds = ringBounds(right);
  if (
    leftBounds.maxXMilli < rightBounds.minXMilli ||
    rightBounds.maxXMilli < leftBounds.minXMilli ||
    leftBounds.maxYMilli < rightBounds.minYMilli ||
    rightBounds.maxYMilli < leftBounds.minYMilli
  ) {
    return false;
  }
  for (const point of left) {
    if (pointInRing(point, right)) return true;
  }
  for (const point of right) {
    if (pointInRing(point, left)) return true;
  }
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      if (
        segmentsIntersect(
          left[leftIndex]!,
          left[leftIndex + 1]!,
          right[rightIndex]!,
          right[rightIndex + 1]!,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

export function ringContainedIn(inner: Ring, outer: Ring): boolean {
  for (const point of inner) {
    if (!pointInRing(point, outer)) return false;
  }
  return true;
}

function assertUniqueKeys(keys: string[], noun: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      throw new GeographyDomainError('REFERENCE_INVALID', `Duplicate ${noun} key ${key}.`);
    }
    seen.add(key);
  }
}

function canonicalizePlan(plan: GeographySeedPlanV1): GeographySeedPlanV1 {
  return {
    ...plan,
    buildings: [...plan.buildings]
      .map((building) => ({ ...building }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    districts: [...plan.districts]
      .map((district) => ({ ...district, ring: canonicalRing(district.ring) }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    parcels: [...plan.parcels]
      .map((parcel) => ({ ...parcel, ring: canonicalRing(parcel.ring) }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    pointsOfInterest: [...plan.pointsOfInterest]
      .map((poi) => ({ ...poi }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    roads: [...plan.roads]
      .map((road) => ({
        ...road,
        path: road.path.map((point) => ({
          xMilli: quantizeMilli(point.xMilli),
          yMilli: quantizeMilli(point.yMilli),
        })),
      }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    spawnPoints: [...plan.spawnPoints]
      .map((spawn) => ({ ...spawn }))
      .sort((left, right) => compareText(left.stableKey, right.stableKey)),
    territory: { ...plan.territory, ring: canonicalRing(plan.territory.ring) },
  };
}

export function assertGeographySeedPlanV1(plan: GeographySeedPlanV1): GeographySeedPlanV1 {
  if (!seedPlanValidator.is(plan)) {
    throw new GeographyDomainError(
      'SEED_PLAN_INVALID',
      'Geography seed plan failed schema validation.',
    );
  }
  const canonical = canonicalizePlan(plan);
  const { spatialReference } = canonical;
  if (
    spatialReference.boundsMinXMilli >= spatialReference.boundsMaxXMilli ||
    spatialReference.boundsMinYMilli >= spatialReference.boundsMaxYMilli
  ) {
    throw new GeographyDomainError('BOUNDS_INVALID', 'Spatial bounds are inverted.');
  }
  const territoryRing = canonical.territory.ring;
  const territoryBounds = ringBounds(territoryRing);
  if (
    territoryBounds.minXMilli < spatialReference.boundsMinXMilli ||
    territoryBounds.minYMilli < spatialReference.boundsMinYMilli ||
    territoryBounds.maxXMilli > spatialReference.boundsMaxXMilli ||
    territoryBounds.maxYMilli > spatialReference.boundsMaxYMilli
  ) {
    throw new GeographyDomainError('BOUNDS_INVALID', 'Territory exceeds spatial bounds.');
  }

  assertUniqueKeys(
    [
      canonical.territory.stableKey,
      ...canonical.districts.map((entry) => entry.stableKey),
      ...canonical.parcels.map((entry) => entry.stableKey),
      ...canonical.roads.map((entry) => entry.stableKey),
      ...canonical.buildings.map((entry) => entry.stableKey),
      ...canonical.pointsOfInterest.map((entry) => entry.stableKey),
      ...canonical.spawnPoints.map((entry) => entry.stableKey),
    ],
    'stable',
  );

  const districtByKey = new Map(
    canonical.districts.map((district) => [district.stableKey, district]),
  );
  const parcelByKey = new Map(canonical.parcels.map((parcel) => [parcel.stableKey, parcel]));

  for (const district of canonical.districts) {
    if (district.parentTerritoryKey !== canonical.territory.stableKey) {
      throw new GeographyDomainError(
        'REFERENCE_INVALID',
        `District ${district.stableKey} parent missing.`,
      );
    }
    if (!ringContainedIn(district.ring, territoryRing)) {
      throw new GeographyDomainError(
        'TOPOLOGY_INVALID',
        `District ${district.stableKey} escapes territory.`,
      );
    }
  }
  for (let left = 0; left < canonical.districts.length; left += 1) {
    for (let right = left + 1; right < canonical.districts.length; right += 1) {
      if (ringsOverlap(canonical.districts[left]!.ring, canonical.districts[right]!.ring)) {
        throw new GeographyDomainError('TOPOLOGY_INVALID', 'Districts overlap.');
      }
    }
  }

  for (const parcel of canonical.parcels) {
    const district = districtByKey.get(parcel.districtKey);
    if (!district) {
      throw new GeographyDomainError(
        'REFERENCE_INVALID',
        `Parcel ${parcel.stableKey} district missing.`,
      );
    }
    if (!ringContainedIn(parcel.ring, district.ring)) {
      throw new GeographyDomainError(
        'TOPOLOGY_INVALID',
        `Parcel ${parcel.stableKey} escapes district.`,
      );
    }
  }
  const parcelsByDistrict = new Map<string, typeof canonical.parcels>();
  for (const parcel of canonical.parcels) {
    const list = parcelsByDistrict.get(parcel.districtKey) ?? [];
    list.push(parcel);
    parcelsByDistrict.set(parcel.districtKey, list);
  }
  for (const parcels of parcelsByDistrict.values()) {
    for (let left = 0; left < parcels.length; left += 1) {
      for (let right = left + 1; right < parcels.length; right += 1) {
        if (ringsOverlap(parcels[left]!.ring, parcels[right]!.ring)) {
          throw new GeographyDomainError('TOPOLOGY_INVALID', 'Parcels overlap within a district.');
        }
      }
    }
  }

  for (const road of canonical.roads) {
    if (!districtByKey.has(road.fromDistrictKey) || !districtByKey.has(road.toDistrictKey)) {
      throw new GeographyDomainError(
        'REFERENCE_INVALID',
        `Road ${road.stableKey} district missing.`,
      );
    }
    if (road.widthMilli <= 0) {
      throw new GeographyDomainError('GEOMETRY_INVALID', `Road ${road.stableKey} width invalid.`);
    }
    const start = road.path[0]!;
    const end = road.path[road.path.length - 1]!;
    if (
      !pointInRing(start, districtByKey.get(road.fromDistrictKey)!.ring) ||
      !pointInRing(end, districtByKey.get(road.toDistrictKey)!.ring)
    ) {
      throw new GeographyDomainError(
        'TOPOLOGY_INVALID',
        `Road ${road.stableKey} endpoints leave districts.`,
      );
    }
  }

  for (const building of canonical.buildings) {
    const parcel = parcelByKey.get(building.parcelKey);
    if (!parcel) {
      throw new GeographyDomainError(
        'REFERENCE_INVALID',
        `Building ${building.stableKey} parcel missing.`,
      );
    }
    const centroid = { xMilli: building.centroidXMilli, yMilli: building.centroidYMilli };
    if (!pointInRing(centroid, parcel.ring)) {
      throw new GeographyDomainError(
        'TOPOLOGY_INVALID',
        `Building ${building.stableKey} leaves parcel.`,
      );
    }
  }

  for (const poi of canonical.pointsOfInterest) {
    if (!pointInRing({ xMilli: poi.xMilli, yMilli: poi.yMilli }, territoryRing)) {
      throw new GeographyDomainError('TOPOLOGY_INVALID', `POI ${poi.stableKey} leaves territory.`);
    }
  }

  const publicSpawns = canonical.spawnPoints.filter((spawn) => spawn.accessPolicy === 'public');
  if (publicSpawns.length < 1) {
    throw new GeographyDomainError('SPAWN_INVALID', 'At least one public spawn is required.');
  }
  for (const spawn of canonical.spawnPoints) {
    if (!pointInRing({ xMilli: spawn.xMilli, yMilli: spawn.yMilli }, territoryRing)) {
      throw new GeographyDomainError('SPAWN_INVALID', `Spawn ${spawn.stableKey} leaves territory.`);
    }
    for (const building of canonical.buildings) {
      const dx = spawn.xMilli - building.centroidXMilli;
      const dy = spawn.yMilli - building.centroidYMilli;
      const clearance = Math.max(
        building.footprintHalfWidthMilli,
        building.footprintHalfDepthMilli,
      );
      if (dx * dx + dy * dy <= clearance * clearance) {
        throw new GeographyDomainError(
          'SPAWN_INVALID',
          `Spawn ${spawn.stableKey} collides with a building.`,
        );
      }
    }
  }

  return canonical;
}

export function geographySeedPlanHashV1(plan: GeographySeedPlanV1): string {
  return sha256('worldgraph.geography-seed-plan.v1', assertGeographySeedPlanV1(plan));
}

export function visualScenePlanHashV1(plan: VisualScenePlanV1): string {
  if (!scenePlanValidator.is(plan)) {
    throw new GeographyDomainError(
      'SCENE_PLAN_INVALID',
      'Visual scene plan failed schema validation.',
    );
  }
  const canonical: VisualScenePlanV1 = {
    ...plan,
    nodes: [...plan.nodes].sort((left, right) =>
      compareText(left.entityLogicalKey, right.entityLogicalKey),
    ),
    warnings: [...plan.warnings].sort((left, right) => compareText(left.code, right.code)),
  };
  return sha256('worldgraph.visual-scene-plan.v1', canonical);
}

function materialForZoning(zoning: string): string {
  if (zoning.includes('harbor')) return 'material.harbor';
  if (zoning.includes('market')) return 'material.market';
  if (zoning.includes('civic') || zoning.includes('council')) return 'material.civic';
  return 'material.district';
}

export function buildVisualScenePlanV1(
  plan: GeographySeedPlanV1,
  options: { seed: string; styleKitVersion: 1 },
): { hash: string; plan: VisualScenePlanV1 } {
  const geography = assertGeographySeedPlanV1(plan);
  void options.seed;
  const nodes: VisualScenePlanV1['nodes'] = [];

  for (const district of geography.districts) {
    const bounds = ringBounds(district.ring);
    nodes.push({
      archetype: 'district.block',
      entityLogicalKey: district.stableKey,
      layer: 'district',
      lodHint: 'low',
      materialToken: materialForZoning(district.zoning),
      provenance: { sourceStableKey: district.stableKey },
      transform: {
        scaleMilli: 1000,
        xMilli: Math.trunc((bounds.minXMilli + bounds.maxXMilli) / 2),
        yMilli: Math.trunc((bounds.minYMilli + bounds.maxYMilli) / 2),
        yawMilliDegrees: 0,
        zMilli: 0,
      },
    });
  }
  for (const parcel of geography.parcels) {
    const bounds = ringBounds(parcel.ring);
    nodes.push({
      archetype: 'parcel.lot',
      entityLogicalKey: parcel.stableKey,
      layer: 'parcel',
      lodHint: 'medium',
      materialToken: 'material.parcel',
      provenance: { sourceStableKey: parcel.stableKey },
      transform: {
        scaleMilli: 1000,
        xMilli: Math.trunc((bounds.minXMilli + bounds.maxXMilli) / 2),
        yMilli: Math.trunc((bounds.minYMilli + bounds.maxYMilli) / 2),
        yawMilliDegrees: 0,
        zMilli: 0,
      },
    });
  }
  for (const road of geography.roads) {
    const mid = road.path[Math.floor(road.path.length / 2)]!;
    nodes.push({
      archetype: `road.${road.class}`,
      entityLogicalKey: road.stableKey,
      layer: 'road',
      lodHint: 'medium',
      materialToken: 'material.road',
      provenance: { sourceStableKey: road.stableKey },
      transform: {
        scaleMilli: road.widthMilli,
        xMilli: mid.xMilli,
        yMilli: mid.yMilli,
        yawMilliDegrees: 0,
        zMilli: 0,
      },
    });
  }
  for (const building of geography.buildings) {
    nodes.push({
      archetype: building.archetype,
      entityLogicalKey: building.entityLogicalKey,
      layer: 'building',
      lodHint: 'high',
      materialToken: 'material.building',
      provenance: { sourceStableKey: building.stableKey },
      transform: {
        scaleMilli: Math.max(building.footprintHalfWidthMilli, building.footprintHalfDepthMilli),
        xMilli: building.centroidXMilli,
        yMilli: building.centroidYMilli,
        yawMilliDegrees: building.yawMilliDegrees,
        zMilli: building.elevationMilli,
      },
    });
  }
  for (const poi of geography.pointsOfInterest) {
    nodes.push({
      archetype: poi.kind,
      entityLogicalKey: poi.entityLogicalKey,
      layer: 'poi',
      lodHint: 'high',
      materialToken: 'material.poi',
      provenance: { sourceStableKey: poi.stableKey },
      transform: {
        scaleMilli: poi.radiusMilli,
        xMilli: poi.xMilli,
        yMilli: poi.yMilli,
        yawMilliDegrees: 0,
        zMilli: 0,
      },
    });
  }
  for (const spawn of geography.spawnPoints) {
    nodes.push({
      archetype: 'spawn.point',
      entityLogicalKey: spawn.stableKey,
      layer: 'spawn',
      lodHint: 'high',
      materialToken: 'material.spawn',
      provenance: { sourceStableKey: spawn.stableKey },
      transform: {
        scaleMilli: spawn.radiusMilli,
        xMilli: spawn.xMilli,
        yMilli: spawn.yMilli,
        yawMilliDegrees: 0,
        zMilli: 0,
      },
    });
  }

  const scenePlan: VisualScenePlanV1 = {
    bounds: {
      maxXMilli: geography.spatialReference.boundsMaxXMilli,
      maxYMilli: geography.spatialReference.boundsMaxYMilli,
      minXMilli: geography.spatialReference.boundsMinXMilli,
      minYMilli: geography.spatialReference.boundsMinYMilli,
    },
    nodes: nodes.sort((left, right) => compareText(left.entityLogicalKey, right.entityLogicalKey)),
    styleKitVersion: options.styleKitVersion,
    visualScenePlanSchemaVersion: 1,
    warnings: [],
  };
  return { hash: visualScenePlanHashV1(scenePlan), plan: scenePlan };
}
