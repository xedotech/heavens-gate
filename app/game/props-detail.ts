import { seeded } from './mechanics';

/**
 * Pure placement planning for the street-detail prop layer — facade clutter
 * (AC units, drainpipes, junction boxes, awnings), sidewalk furniture
 * (newsboxes, trash bags, pallets, cardboard), and overhead (sign brackets,
 * slack cables between lamp posts). No three.js import: every helper is
 * deterministic math over the same seeded() stream and road/block constants
 * engine.ts already uses, so the existing prop passes can call
 * planStreetDetail() and hand the result to buildStreetDetail() in props.ts.
 *
 * Salt discipline: this layer draws from salts 400–479 so its stream never
 * correlates with the 1–300 band used by the existing placements.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Anything with position + scale — engine buildingData entries qualify. */
export interface DetailBuilding {
  position: Vec3Like;
  scale: Vec3Like;
}

/**
 * One instanced placement. Orientation = yaw about +Y, then pitch about the
 * yawed local X axis (THREE.Euler 'YXZ') — pitch is what leaning pallets and
 * tilted signs use. `scale` maps onto the shared geometry's unit dimensions.
 */
export interface DetailSpot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch?: number;
  scale?: Vec3Like;
  /** Optional instanceColor (0xrrggbb) — only read by tinted sets. */
  color?: number;
  /**
   * Footprint that should block the player: emitted by the builder as a
   * yaw-conservative AABB, same math instancedProp() uses for GLB colliders.
   * Only free-standing items that would reasonably block (newsboxes) carry
   * one — step-over clutter stays non-collidable like bollards/planters.
   */
  solid?: { w: number; d: number; h: number };
}

/** A slack span between two fixed points (lamp heads, wall anchors). */
export interface CableSpan {
  from: Vec3Like;
  to: Vec3Like;
}

export interface StreetDetailPlan {
  /** Wall-mounted AC boxes (body + fan grille merged in the builder). */
  acUnits: DetailSpot[];
  /** Corner pipe runs — unit-height cylinders, scale.y = building height. */
  drainpipes: DetailSpot[];
  /** Small utility boxes + conduit stub at head height. */
  junctionBoxes: DetailSpot[];
  /** Sloped storefront shades; colored via instanceColor. */
  awnings: DetailSpot[];
  /** Perpendicular hanging signs (arm + panel merged in the builder). */
  signBrackets: DetailSpot[];
  /** Every unit-box sidewalk item: newsboxes, pallets, cardboard sheets. */
  clutterBoxes: DetailSpot[];
  /** Squashed dark spheres — trash clusters against walls. */
  trashBags: DetailSpot[];
  /** Lamp-to-lamp slack runs; the builder turns each into a scaled tube. */
  cables: CableSpan[];
}

export interface StreetDetailInput {
  buildings: ReadonlyArray<DetailBuilding>;
  /** Street lamp positions (engine streetLamps) — drives cable spans. */
  lamps?: ReadonlyArray<{ x: number; z: number }>;
  /**
   * Full blockage check for ground-level items — pass the engine's
   * collides() or createRouteProps' blocked() so clutter respects building
   * boxes, reserved landmark space, and already-taken prop spots.
   */
  blocked?: (x: number, z: number, radius: number) => boolean;
  /**
   * Spots-only check for wall-mounted items — pass createRouteProps'
   * blockedWall(). Building colliders must NOT be consulted here: a
   * wall-mounted spot is supposed to touch the wall.
   */
  blockedWall?: (x: number, z: number, radius: number) => boolean;
  /**
   * Optional claim callback (createRouteProps' take()) so later engine
   * placements learn where detail props landed.
   */
  claim?: (x: number, z: number, radius: number) => void;
  /** Density multiplier — engine maps quality to ~0.45 (low) … 1 (high+). */
  density?: number;
  /** Deterministic stream; defaults to the shared seeded() helper. */
  rand?: (index: number, salt?: number) => number;
}

// Road lattice — mirrors engine.ts: roads on every 30 m line, 8.4 m wide
// (asphalt edge ±4.2). Existing props dress ±5.4…±6.8; clutter stays inside
// the ±4.6…±7.4 band so nothing lands in a traffic lane.
const ROAD_STEP = 30;
const SIDEWALK_INNER = 4.55;
const SIDEWALK_OUTER = 7.4;
const ROAD_ASPHALT = 4.3;

/**
 * True when a ground point sits inside a traffic lane: the asphalt band runs
 * ±4.2 around every road line on BOTH axes, so a curb spot still lands in
 * the street when its free coordinate hits a cross street or a building
 * face stands closer than a sidewalk width to the lane.
 */
function onRoad(x: number, z: number) {
  return Math.abs(x - Math.round(x / ROAD_STEP) * ROAD_STEP) < ROAD_ASPHALT
    || Math.abs(z - Math.round(z / ROAD_STEP) * ROAD_STEP) < ROAD_ASPHALT;
}

// Matching createStreetProps' coverage: every other road line, stepped
// offsets — the detail layer fills between its bollards and planters.
const PROP_LINE_MIN = -120;
const PROP_LINE_MAX = 120;
const PROP_LINE_STEP = 60;
const PROP_TRACK_MIN = -132;
const PROP_TRACK_MAX = 132;

const LAMP_HEAD_Y = 4.55;
const CABLE_MAX = 28;

const AWNING_COLORS = [0x6e2f2a, 0x2a4d4f, 0x6e5a2a, 0x3a3f42, 0x4a3a56] as const;
const NEWSBOX_COLORS = [0x7a2020, 0x20507a, 0x8a7a20, 0x3a3f44] as const;
const CARDBOARD_COLORS = [0x8a765a, 0x7d6a50, 0x94805f] as const;
const PALLET_COLORS = [0x6b5a42, 0x5d5040, 0x74644a] as const;

/**
 * Which building face reads from the street — a pure port of the faceSpot()
 * helper inside createRouteProps. The nearest road line on each axis wins;
 * the smaller gap decides the axis, `side` points toward the road, and `yaw`
 * faces the road with the same convention window/decal instances use.
 */
export interface RoadFace {
  axis: 'x' | 'z';
  side: -1 | 1;
  yaw: number;
}

export function roadFace(building: DetailBuilding): RoadFace {
  const roadX = Math.round(building.position.x / ROAD_STEP) * ROAD_STEP;
  const roadZ = Math.round(building.position.z / ROAD_STEP) * ROAD_STEP;
  if (Math.abs(roadX - building.position.x) < Math.abs(roadZ - building.position.z)) {
    const side: -1 | 1 = roadX < building.position.x ? -1 : 1;
    return { axis: 'x', side, yaw: side > 0 ? Math.PI / 2 : -Math.PI / 2 };
  }
  const side: -1 | 1 = roadZ < building.position.z ? -1 : 1;
  return { axis: 'z', side, yaw: side > 0 ? 0 : Math.PI };
}

/**
 * A point `outset` metres proud of the chosen face, `lateral` metres along
 * it — the wall-mount primitive every facade layer shares.
 */
export function wallPoint(
  building: DetailBuilding,
  face: RoadFace,
  outset: number,
  lateral: number,
  y: number,
): { x: number; y: number; z: number; yaw: number } {
  if (face.axis === 'x') {
    return {
      x: building.position.x + face.side * (building.scale.x * 0.5 + outset),
      y,
      z: building.position.z + lateral,
      yaw: face.yaw,
    };
  }
  return {
    x: building.position.x + lateral,
    y,
    z: building.position.z + face.side * (building.scale.z * 0.5 + outset),
    yaw: face.yaw,
  };
}

interface WallClaim {
  x: number;
  z: number;
  r: number;
  y0: number;
  y1: number;
}

/**
 * Facade-mounted clutter: AC units, drainpipes, junction boxes, awnings,
 * sign brackets. Everything is derived from the building's road face so the
 * dressing lands where a street-level camera actually looks.
 */
function planFacadeClutter(
  buildings: ReadonlyArray<DetailBuilding>,
  rand: (index: number, salt?: number) => number,
  density: number,
  blockedWall: (x: number, z: number, radius: number) => boolean,
  plan: StreetDetailPlan,
) {
  const claims: WallClaim[] = [];
  const wallTaken = (x: number, z: number, r: number, y0: number, y1: number) =>
    claims.some((claim) => y1 > claim.y0 && y0 < claim.y1
      && Math.hypot(claim.x - x, claim.z - z) < claim.r + r);
  const claimWall = (x: number, z: number, r: number, y0: number, y1: number) => {
    claims.push({ x, z, r, y0, y1 });
  };

  buildings.forEach((building, index) => {
    if (building.scale.y < 6.5) return;
    const face = roadFace(building);
    const faceLength = face.axis === 'x' ? building.scale.z : building.scale.x;
    // Lateral range that keeps mounted props off the corner edges.
    const inset = Math.max(0, faceLength * 0.5 - 0.9);
    if (faceLength < 3.4) return;

    // AC units — upper floors of taller stock, fan grille facing the street.
    if (building.scale.y > 8.5 && rand(index, 401) < 0.5 * density) {
      const count = 1 + (rand(index, 402) < 0.45 ? 1 : 0);
      for (let k = 0; k < count; k += 1) {
        const slot = index * 5 + k;
        const lateral = (rand(slot, 403) - 0.5) * 2 * inset;
        const y = 2.3 + rand(slot, 404) * Math.max(1, Math.min(9.5, building.scale.y - 3.6));
        const spot = wallPoint(building, face, 0.3, lateral, y);
        if (wallTaken(spot.x, spot.z, 0.55, y - 0.4, y + 0.4) || blockedWall(spot.x, spot.z, 0.5)) continue;
        const s = 0.85 + rand(slot, 405) * 0.35;
        plan.acUnits.push({ x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, scale: { x: s, y: s, z: s } });
        claimWall(spot.x, spot.z, 0.55, y - 0.4, y + 0.4);
      }
    }

    // Drainpipes — full-height runs hugging a road-face corner.
    if (rand(index, 410) < 0.44 * density) {
      const first = rand(index, 411) < 0.5 ? -1 : 1;
      const corners = rand(index, 412) < 0.22 ? [first, -first] : [first];
      corners.forEach((corner) => {
        const lateral = corner * Math.max(0, faceLength * 0.5 - 0.34);
        const spot = wallPoint(building, face, 0.1, lateral, 0);
        if (wallTaken(spot.x, spot.z, 0.3, 0, building.scale.y) || blockedWall(spot.x, spot.z, 0.25)) return;
        plan.drainpipes.push({
          x: spot.x,
          y: 0,
          z: spot.z,
          yaw: spot.yaw,
          scale: { x: 1, y: building.scale.y, z: 1 },
        });
        claimWall(spot.x, spot.z, 0.3, 0, building.scale.y);
      });
    }

    // Junction/utility boxes — conduit drops toward the pavement.
    if (rand(index, 415) < 0.36 * density) {
      const lateral = (rand(index, 416) - 0.5) * 2 * inset;
      const y = 1.35 + rand(index, 417) * 0.35;
      const spot = wallPoint(building, face, 0.1, lateral, y);
      if (!wallTaken(spot.x, spot.z, 0.45, y - 0.35, y + 0.35) && !blockedWall(spot.x, spot.z, 0.4)) {
        const s = 0.8 + rand(index, 418) * 0.45;
        plan.junctionBoxes.push({ x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, scale: { x: s, y: s, z: s } });
        claimWall(spot.x, spot.z, 0.45, y - 0.35, y + 0.35);
      }
    }

    // Awnings — storefront-height shades on wide enough faces.
    if (faceLength > 4.4 && rand(index, 420) < 0.34 * density) {
      const lateral = (rand(index, 421) - 0.5) * 2 * Math.max(0, inset - 0.7);
      const y = 2.55 + rand(index, 422) * 0.45;
      const spot = wallPoint(building, face, 0.04, lateral, y);
      if (!wallTaken(spot.x, spot.z, 1.5, y - 0.9, y + 0.2) && !blockedWall(spot.x, spot.z, 1.4)) {
        plan.awnings.push({
          x: spot.x,
          y: spot.y,
          z: spot.z,
          yaw: spot.yaw,
          scale: { x: 0.85 + rand(index, 423) * 0.5, y: 1, z: 0.9 + rand(index, 424) * 0.25 },
          color: AWNING_COLORS[Math.floor(rand(index, 425) * AWNING_COLORS.length)],
        });
        claimWall(spot.x, spot.z, 1.5, y - 0.9, y + 0.2);
      }
    }

    // Hanging sign brackets — perpendicular panels over the pavement.
    if (rand(index, 426) < 0.3 * density) {
      const lateral = (rand(index, 427) - 0.5) * 2 * inset;
      const y = 2.85 + rand(index, 428) * 0.85;
      const spot = wallPoint(building, face, 0.06, lateral, y);
      if (!wallTaken(spot.x, spot.z, 0.9, y - 0.5, y + 0.6) && !blockedWall(spot.x, spot.z, 0.8)) {
        plan.signBrackets.push({ x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw });
        claimWall(spot.x, spot.z, 0.9, y - 0.5, y + 0.6);
      }
    }
  });
}

/**
 * Ground-level clutter. Two sources, matching how the city already dresses:
 * the road-line lattice (curb newsboxes, flat pallets) and building faces
 * (leaning pallets, cardboard, trash bags piled against walls).
 */
function planSidewalkClutter(
  buildings: ReadonlyArray<DetailBuilding>,
  rand: (index: number, salt?: number) => number,
  density: number,
  blocked: (x: number, z: number, radius: number) => boolean,
  blockedWall: (x: number, z: number, radius: number) => boolean,
  claim: (x: number, z: number, radius: number) => void,
  plan: StreetDetailPlan,
) {
  // Road lattice pass — same iteration shape createStreetProps uses.
  for (let line = PROP_LINE_MIN; line <= PROP_LINE_MAX; line += PROP_LINE_STEP) {
    for (let t = PROP_TRACK_MIN; t <= PROP_TRACK_MAX; t += 26) {
      const index = (line + 200) * 40 + (t + 200);
      const along = t + (rand(index, 432) - 0.5) * 9;

      // Newsboxes — curb-side, facing the road, occasionally paired.
      if (rand(index, 430) < 0.34 * density) {
        const sideSign = rand(index, 431) < 0.5 ? -1 : 1;
        const offset = SIDEWALK_INNER + 0.35 + rand(index, 433) * 0.55;
        const onX = rand(index, 434) < 0.5;
        const x = onX ? line + sideSign * offset : along;
        const z = onX ? along : line + sideSign * offset;
        // Benches/kiosks face the road with this same yaw convention.
        const yaw = onX
          ? (sideSign > 0 ? -Math.PI / 2 : Math.PI / 2)
          : (sideSign > 0 ? Math.PI : 0);
        const pair = rand(index, 435) < 0.3 ? 2 : 1;
        for (let k = 0; k < pair; k += 1) {
          const px = onX ? x : x + k * 0.62;
          const pz = onX ? z + k * 0.62 : z;
          if (onRoad(px, pz) || blocked(px, pz, 0.5)) continue;
          plan.clutterBoxes.push({
            x: px,
            y: 0.37,
            z: pz,
            yaw: yaw + (rand(index * 3 + k, 436) - 0.5) * 0.16,
            scale: { x: 0.46, y: 0.74, z: 0.4 },
            color: NEWSBOX_COLORS[Math.floor(rand(index * 3 + k, 437) * NEWSBOX_COLORS.length)],
            solid: { w: 0.5, d: 0.44, h: 0.76 },
          });
          claim(px, pz, 0.5);
        }
      }

      // Flat pallet stacks — service-lane debris by the curb.
      if (rand(index, 443) < 0.12 * density) {
        const sideSign = rand(index, 444) < 0.5 ? -1 : 1;
        const offset = SIDEWALK_INNER + 0.9 + rand(index, 445) * 1.4;
        const onX = rand(index, 446) < 0.5;
        const x = onX ? line + sideSign * offset : along;
        const z = onX ? along : line + sideSign * offset;
        if (!onRoad(x, z) && !blocked(x, z, 0.8)) {
          const stack = rand(index, 447) < 0.4 ? 2 : 1;
          for (let k = 0; k < stack; k += 1) {
            plan.clutterBoxes.push({
              x,
              y: 0.05 + k * 0.1,
              z,
              yaw: rand(index + k, 448) * Math.PI,
              scale: { x: 1.05, y: 0.09, z: 0.85 },
              color: PALLET_COLORS[Math.floor(rand(index + k, 449) * PALLET_COLORS.length)],
            });
          }
          claim(x, z, 0.9);
        }
      }
    }
  }

  // Building-face pass — items that read as "set against the wall".
  buildings.forEach((building, index) => {
    const face = roadFace(building);
    const faceLength = face.axis === 'x' ? building.scale.z : building.scale.x;
    if (faceLength < 3.2) return;
    const inset = Math.max(0, faceLength * 0.5 - 0.9);

    // Leaning pallet — pitched so the top edge rests on the wall.
    if (rand(index, 450) < 0.3 * density) {
      const lateral = (rand(index, 451) - 0.5) * 2 * inset;
      const spot = wallPoint(building, face, 0.42, lateral, 0.55);
      // Radius stays inside the wall outset so the host building never
      // vetoes its own dressing; it still catches neighbours intruding.
      if (!onRoad(spot.x, spot.z) && !blocked(spot.x, spot.z, 0.27) && !blockedWall(spot.x, spot.z, 0.5)) {
        plan.clutterBoxes.push({
          x: spot.x,
          y: spot.y,
          z: spot.z,
          yaw: spot.yaw,
          // Local +Z faces the road, so a negative pitch tips the top edge
          // back onto the wall.
          pitch: -0.3,
          scale: { x: 1.05, y: 1.15, z: 0.09 },
          color: PALLET_COLORS[Math.floor(rand(index, 452) * PALLET_COLORS.length)],
        });
        claim(spot.x, spot.z, 0.6);
      }
    }

    // Flattened cardboard — sleeping spots and damp sheets near walls.
    if (rand(index, 455) < 0.26 * density) {
      const lateral = (rand(index, 456) - 0.5) * 2 * inset;
      const spot = wallPoint(building, face, 0.55 + rand(index, 457) * 0.5, lateral, 0.03);
      if (!onRoad(spot.x, spot.z) && !blocked(spot.x, spot.z, 0.35) && !blockedWall(spot.x, spot.z, 0.5)) {
        plan.clutterBoxes.push({
          x: spot.x,
          y: spot.y,
          z: spot.z,
          yaw: rand(index, 458) * Math.PI * 2,
          scale: { x: 0.85 + rand(index, 459) * 0.35, y: 0.025, z: 0.6 + rand(index, 460) * 0.25 },
          color: CARDBOARD_COLORS[Math.floor(rand(index, 461) * CARDBOARD_COLORS.length)],
        });
        claim(spot.x, spot.z, 0.55);
      }
    }

    // Trash bags — clusters of 1–3 squashed spheres at the wall base.
    if (rand(index, 464) < 0.34 * density) {
      const bags = 1 + Math.floor(rand(index, 465) * 3);
      const lateral = (rand(index, 466) - 0.5) * 2 * inset;
      let placed = 0;
      for (let k = 0; k < bags; k += 1) {
        const spot = wallPoint(
          building,
          face,
          0.38 + rand(index * 7 + k, 467) * 0.4,
          lateral + (rand(index * 7 + k, 468) - 0.5) * 1.1,
          0.19,
        );
        if (onRoad(spot.x, spot.z) || blocked(spot.x, spot.z, 0.22) || blockedWall(spot.x, spot.z, 0.3)) continue;
        plan.trashBags.push({
          x: spot.x,
          y: spot.y,
          z: spot.z,
          yaw: rand(index * 7 + k, 469) * Math.PI * 2,
          scale: {
            x: 0.95 + rand(index * 7 + k, 470) * 0.4,
            y: 0.5 + rand(index * 7 + k, 471) * 0.18,
            z: 0.85 + rand(index * 7 + k, 472) * 0.35,
          },
        });
        placed += 1;
      }
      if (placed) {
        const anchor = wallPoint(building, face, 0.5, lateral, 0);
        claim(anchor.x, anchor.z, 0.7);
      }
    }
  });
}

/**
 * Slack cable runs between lamp posts. Each lamp belongs to the road line it
 * flanks (±5.6 offset — same constant createStreetlamps uses); consecutive
 * lamps on opposite sides give diagonal street crossings, same-side pairs
 * give long runs along the pavement. Spans keep both ends at head height.
 */
function planCables(
  lamps: ReadonlyArray<{ x: number; z: number }>,
  rand: (index: number, salt?: number) => number,
  plan: StreetDetailPlan,
) {
  interface LampPoint { along: number; side: number; x: number; z: number }
  const groups = new Map<string, LampPoint[]>();
  lamps.forEach((lamp) => {
    const roadX = Math.round(lamp.x / ROAD_STEP) * ROAD_STEP;
    const roadZ = Math.round(lamp.z / ROAD_STEP) * ROAD_STEP;
    const dx = Math.abs(lamp.x - roadX);
    const dz = Math.abs(lamp.z - roadZ);
    if (dx <= SIDEWALK_OUTER && dx < dz) {
      const key = `x${roadX}`;
      const group = groups.get(key) ?? [];
      group.push({ along: lamp.z, side: lamp.x - roadX, x: lamp.x, z: lamp.z });
      groups.set(key, group);
    } else if (dz <= SIDEWALK_OUTER) {
      const key = `z${roadZ}`;
      const group = groups.get(key) ?? [];
      group.push({ along: lamp.x, side: lamp.z - roadZ, x: lamp.x, z: lamp.z });
      groups.set(key, group);
    }
  });

  let pairIndex = 0;
  groups.forEach((group) => {
    if (plan.cables.length >= CABLE_MAX) return;
    group.sort((a, b) => a.along - b.along);
    for (let i = 0; i + 1 < group.length && plan.cables.length < CABLE_MAX; i += 1) {
      const a = group[i];
      const b = group[i + 1];
      const gap = b.along - a.along;
      const crossing = a.side * b.side < 0;
      // Opposite sides → a diagonal crossing; same side → the rare long run.
      // The roll indexes pairs, not placements — a failed roll must not
      // stall every later pair on the same value.
      const roll = rand(pairIndex, 474);
      pairIndex += 1;
      const wanted = crossing ? gap > 12 && gap < 46 : gap > 40 && gap < 78;
      if (!wanted) continue;
      if (roll >= (crossing ? 0.5 : 0.18)) continue;
      plan.cables.push({
        from: { x: a.x, y: LAMP_HEAD_Y, z: a.z },
        to: { x: b.x, y: LAMP_HEAD_Y, z: b.z },
      });
    }
  });
}

/**
 * Plans the whole street-detail layer in one deterministic pass. Pure — no
 * scene, no engine state; pass engine callbacks in `input` to make placement
 * respect colliders, reserved space, and the running spot registry.
 */
export function planStreetDetail(input: StreetDetailInput): StreetDetailPlan {
  const rand = input.rand ?? seeded;
  const density = input.density ?? 1;
  const blocked = input.blocked ?? (() => false);
  const blockedWall = input.blockedWall ?? (() => false);
  const claim = input.claim ?? (() => undefined);
  const plan: StreetDetailPlan = {
    acUnits: [],
    drainpipes: [],
    junctionBoxes: [],
    awnings: [],
    signBrackets: [],
    clutterBoxes: [],
    trashBags: [],
    cables: [],
  };
  planFacadeClutter(input.buildings, rand, density, blockedWall, plan);
  planSidewalkClutter(input.buildings, rand, density, blocked, blockedWall, claim, plan);
  if (input.lamps?.length) planCables(input.lamps, rand, plan);
  return plan;
}
