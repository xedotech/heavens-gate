export interface AiVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type AwarenessPhase =
  | 'calm'
  | 'suspicious'
  | 'alerted'
  | 'combat'
  | 'searching'
  | 'returning'
  | 'incapacitated';

export type NpcAction =
  | 'patrol'
  | 'investigate'
  | 'take-cover'
  | 'engage'
  | 'search'
  | 'return'
  | 'react-to-damage'
  | 'incapacitated';

export type NpcDecisionReason =
  | 'routine'
  | 'visual-contact'
  | 'auditory-contact'
  | 'squad-report'
  | 'under-fire'
  | 'low-health'
  | 'reload'
  | 'lost-contact'
  | 'search-exhausted'
  | 'damage'
  | 'health-depleted';

export interface TargetPerception {
  readonly position: AiVector3;
  readonly distanceMeters: number;
  /** Dot product against the NPC's forward vector: -1 behind, 1 straight ahead. */
  readonly viewAlignment: number;
  readonly inLineOfSight: boolean;
  /** Combined lighting and occlusion visibility in the inclusive range 0..1. */
  readonly visibility: number;
  /** Target movement intensity in the inclusive range 0..1. */
  readonly movement: number;
}

export interface SoundStimulus {
  readonly position: AiVector3;
  readonly distanceMeters: number;
  readonly loudness: number;
}

export interface DamageStimulus {
  readonly amount: number;
  readonly sourcePosition?: AiVector3;
}

export interface CoverCandidate {
  readonly id: string;
  readonly position: AiVector3;
  readonly distanceMeters: number;
  /** Estimated exposure to the threat in the inclusive range 0..1. */
  readonly exposure: number;
  /** Navigation cost in the inclusive range 0..1. */
  readonly routeCost: number;
  /** Tactical angle quality in the inclusive range 0..1. */
  readonly flankQuality: number;
}

export interface SquadRadioSignal {
  readonly squadId: string;
  readonly senderId: string;
  /** Monotonically increasing per sender. */
  readonly sequence: number;
  readonly targetPosition: AiVector3;
  readonly confidence: number;
  readonly threat: 'target' | 'damage';
}

export interface NpcAiInput {
  readonly deltaSeconds: number;
  readonly position: AiVector3;
  readonly health: number;
  readonly maxHealth: number;
  readonly target?: TargetPerception;
  readonly sound?: SoundStimulus;
  readonly damage?: DamageStimulus;
  readonly underFire?: boolean;
  readonly needsReload?: boolean;
  readonly coverCandidates?: readonly CoverCandidate[];
  readonly radioSignals?: readonly SquadRadioSignal[];
}

export interface NpcAiConfig {
  readonly maxStepSeconds: number;
  readonly visionRangeMeters: number;
  readonly minimumViewAlignment: number;
  readonly minimumVisualSignal: number;
  readonly visualSuspicionPerSecond: number;
  readonly hearingRangeMeters: number;
  readonly minimumAuditorySignal: number;
  readonly auditorySuspicionPerSecond: number;
  readonly suspicionDecayPerSecond: number;
  readonly searchSuspicionDecayScale: number;
  readonly suspiciousThreshold: number;
  readonly alertThreshold: number;
  readonly combatThreshold: number;
  readonly lostSightGraceSeconds: number;
  readonly searchDurationSeconds: number;
  readonly radioSearchDurationSeconds: number;
  readonly returnArrivalMeters: number;
  readonly damageReactionSeconds: number;
  readonly heavyDamageFraction: number;
  readonly heavyDamageReactionMultiplier: number;
  readonly radioAlertLevel: number;
  readonly radioCooldownSeconds: number;
  readonly lowHealthCoverFraction: number;
  readonly coverMaxDistanceMeters: number;
  readonly coverExposureWeight: number;
  readonly coverDistanceWeight: number;
  readonly coverRouteWeight: number;
  readonly coverFlankWeight: number;
  /**
   * Estimated seconds between an engaging NPC's shots. The AI never sees the
   * trigger pull (the engine owns the cooldown), so burst bloom counts
   * "virtual shots": one per this many seconds of stationary engagement.
   */
  readonly burstShotIntervalSeconds: number;
  /** Aim-cone growth per shot in a burst: 0.15 widens the cone 15% per shot. */
  readonly burstBloomPerShot: number;
  /** Upper bound on burst-driven aim bloom. */
  readonly burstBloomMax: number;
  /** Aim-cone multiplier at full suppression: 2 doubles the cone. */
  readonly suppressionBloomMax: number;
  /** Seconds for suppression to decay from full back to zero. */
  readonly suppressionRecoverySeconds: number;
  /**
   * Hit-chance multiplier applied to the first shot after acquiring the
   * target: 1.15 makes the ambush opener 15% more likely to connect.
   */
  readonly ambushAccuracyBonus: number;
  /**
   * Own-movement speed (m/s) above which the NPC counts as repositioning,
   * which resets the burst bloom back to its base cone.
   */
  readonly burstResetMoveSpeed: number;
}

export const DEFAULT_NPC_AI_CONFIG: Readonly<NpcAiConfig> = Object.freeze({
  maxStepSeconds: 1,
  visionRangeMeters: 82,
  minimumViewAlignment: 0.32,
  minimumVisualSignal: 0.025,
  visualSuspicionPerSecond: 0.82,
  hearingRangeMeters: 46,
  minimumAuditorySignal: 0.035,
  auditorySuspicionPerSecond: 0.56,
  suspicionDecayPerSecond: 0.12,
  searchSuspicionDecayScale: 0.25,
  suspiciousThreshold: 0.24,
  alertThreshold: 0.58,
  combatThreshold: 0.9,
  lostSightGraceSeconds: 1.2,
  searchDurationSeconds: 8,
  radioSearchDurationSeconds: 6,
  returnArrivalMeters: 1.25,
  damageReactionSeconds: 0.28,
  heavyDamageFraction: 0.2,
  heavyDamageReactionMultiplier: 1.65,
  radioAlertLevel: 0.78,
  radioCooldownSeconds: 4,
  lowHealthCoverFraction: 0.35,
  coverMaxDistanceMeters: 24,
  coverExposureWeight: 0.56,
  coverDistanceWeight: 0.16,
  coverRouteWeight: 0.14,
  coverFlankWeight: 0.14,
  burstShotIntervalSeconds: 1.5,
  burstBloomPerShot: 0.15,
  burstBloomMax: 1.9,
  suppressionBloomMax: 2,
  suppressionRecoverySeconds: 1.5,
  ambushAccuracyBonus: 1.15,
  burstResetMoveSpeed: 1.4,
});

export interface NpcAiState {
  readonly npcId: string;
  readonly squadId?: string;
  readonly homePosition: AiVector3;
  readonly phase: AwarenessPhase;
  readonly suspicion: number;
  readonly secondsSinceTargetSeen: number | null;
  readonly searchRemainingSeconds: number;
  readonly damageReactionRemainingSeconds: number;
  readonly radioCooldownRemainingSeconds: number;
  readonly lastKnownTarget?: AiVector3;
  readonly investigatePoint?: AiVector3;
  readonly outboundRadioSequence: number;
  readonly radioCursor: Readonly<Record<string, number>>;
  /**
   * Seconds spent in the current stationary firing burst. Resets when the
   * NPC stops engaging or repositions; drives burst aim bloom.
   */
  readonly burstFireSeconds?: number;
  /** Virtual shots fired in the current burst (derived from burstFireSeconds). */
  readonly shotsInBurst?: number;
  /** Suppression intensity in the inclusive range 0..1; 1 is fully suppressed. */
  readonly suppressionLevel?: number;
  /** True while the first-shot ambush bonus is still armed and unfired. */
  readonly ambushShotAvailable?: boolean;
  /**
   * Output for the engine: combined aim-cone multiplier (>= 1). Multiply
   * miss spread by this so suppressed/long bursts read as wider tracers.
   */
  readonly aimBloom?: number;
  /**
   * Output for the engine: multiplier on the base hit-chance roll
   * (< 1 while bloomed/suppressed, > 1 for an armed ambush opener).
   */
  readonly accuracyScale?: number;
  /** Position observed on the previous step; used to detect repositioning. */
  readonly previousPosition?: AiVector3;
}

export interface NpcDecision {
  readonly action: NpcAction;
  readonly reason: NpcDecisionReason;
  readonly destination?: AiVector3;
  readonly aimTarget?: AiVector3;
  readonly coverId?: string;
}

export interface PerceptionEvaluation {
  readonly visualSignal: number;
  readonly auditorySignal: number;
  readonly suspicionGain: number;
  readonly targetSeen: boolean;
  readonly soundHeard: boolean;
}

export interface CoverSelection {
  readonly id: string;
  readonly position: AiVector3;
  readonly score: number;
}

export interface NpcAiStep {
  readonly state: NpcAiState;
  readonly decision: NpcDecision;
  readonly perception: PerceptionEvaluation;
  readonly emittedRadio?: SquadRadioSignal;
}

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function nonNegative(value: number) {
  return Math.max(0, finite(value));
}

function copyVector(position: AiVector3): AiVector3 {
  return {
    x: finite(position.x),
    y: finite(position.y),
    z: finite(position.z),
  };
}

function planarDistance(a: AiVector3, b: AiVector3) {
  return Math.hypot(finite(a.x) - finite(b.x), finite(a.z) - finite(b.z));
}

function lexicalCompare(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function resolveNpcAiConfig(overrides: Partial<NpcAiConfig> = {}): NpcAiConfig {
  const merged = { ...DEFAULT_NPC_AI_CONFIG, ...overrides };
  const suspiciousThreshold = clamp(merged.suspiciousThreshold, 0, 1);
  const alertThreshold = clamp(merged.alertThreshold, suspiciousThreshold, 1);
  const combatThreshold = clamp(merged.combatThreshold, alertThreshold, 1);

  return {
    maxStepSeconds: nonNegative(merged.maxStepSeconds),
    visionRangeMeters: nonNegative(merged.visionRangeMeters),
    minimumViewAlignment: clamp(merged.minimumViewAlignment, -1, 1),
    minimumVisualSignal: clamp(merged.minimumVisualSignal, 0, 1),
    visualSuspicionPerSecond: nonNegative(merged.visualSuspicionPerSecond),
    hearingRangeMeters: nonNegative(merged.hearingRangeMeters),
    minimumAuditorySignal: clamp(merged.minimumAuditorySignal, 0, 1),
    auditorySuspicionPerSecond: nonNegative(merged.auditorySuspicionPerSecond),
    suspicionDecayPerSecond: nonNegative(merged.suspicionDecayPerSecond),
    searchSuspicionDecayScale: clamp(merged.searchSuspicionDecayScale, 0, 1),
    suspiciousThreshold,
    alertThreshold,
    combatThreshold,
    lostSightGraceSeconds: nonNegative(merged.lostSightGraceSeconds),
    searchDurationSeconds: nonNegative(merged.searchDurationSeconds),
    radioSearchDurationSeconds: nonNegative(merged.radioSearchDurationSeconds),
    returnArrivalMeters: nonNegative(merged.returnArrivalMeters),
    damageReactionSeconds: nonNegative(merged.damageReactionSeconds),
    heavyDamageFraction: clamp(merged.heavyDamageFraction, 0, 1),
    heavyDamageReactionMultiplier: nonNegative(merged.heavyDamageReactionMultiplier),
    radioAlertLevel: clamp(merged.radioAlertLevel, 0, 1),
    radioCooldownSeconds: nonNegative(merged.radioCooldownSeconds),
    lowHealthCoverFraction: clamp(merged.lowHealthCoverFraction, 0, 1),
    coverMaxDistanceMeters: nonNegative(merged.coverMaxDistanceMeters),
    coverExposureWeight: nonNegative(merged.coverExposureWeight),
    coverDistanceWeight: nonNegative(merged.coverDistanceWeight),
    coverRouteWeight: nonNegative(merged.coverRouteWeight),
    coverFlankWeight: nonNegative(merged.coverFlankWeight),
    burstShotIntervalSeconds: nonNegative(merged.burstShotIntervalSeconds),
    burstBloomPerShot: nonNegative(merged.burstBloomPerShot),
    burstBloomMax: Math.max(1, finite(merged.burstBloomMax, 1)),
    suppressionBloomMax: Math.max(1, finite(merged.suppressionBloomMax, 1)),
    suppressionRecoverySeconds: nonNegative(merged.suppressionRecoverySeconds),
    ambushAccuracyBonus: nonNegative(merged.ambushAccuracyBonus),
    burstResetMoveSpeed: nonNegative(merged.burstResetMoveSpeed),
  };
}

export function createNpcAiState(options: {
  npcId: string;
  squadId?: string;
  homePosition: AiVector3;
}): NpcAiState {
  return {
    npcId: options.npcId,
    squadId: options.squadId,
    homePosition: copyVector(options.homePosition),
    phase: 'calm',
    suspicion: 0,
    secondsSinceTargetSeen: null,
    searchRemainingSeconds: 0,
    damageReactionRemainingSeconds: 0,
    radioCooldownRemainingSeconds: 0,
    outboundRadioSequence: 0,
    radioCursor: {},
    burstFireSeconds: 0,
    shotsInBurst: 0,
    suppressionLevel: 0,
    ambushShotAvailable: false,
    aimBloom: 1,
    accuracyScale: 1,
  };
}

interface AimBloomEvaluation {
  readonly shotsInBurst: number;
  readonly aimBloom: number;
}

/**
 * Combines burst bloom (cone growth per virtual shot, capped) with
 * suppression bloom (up to suppressionBloomMax at full suppression).
 * Pure and deterministic — no RNG; the engine layers its seeded roll on top.
 */
function resolveAimBloom(
  burstFireSeconds: number,
  suppressionLevel: number,
  config: NpcAiConfig,
): AimBloomEvaluation {
  const interval = Math.max(0.000001, config.burstShotIntervalSeconds);
  const shotsInBurst = Math.floor(nonNegative(burstFireSeconds) / interval);
  const burstBloom = Math.min(
    1 + config.burstBloomPerShot * shotsInBurst,
    Math.max(1, config.burstBloomMax),
  );
  const suppressionBloom = 1 + Math.max(0, config.suppressionBloomMax - 1) * clamp(suppressionLevel, 0, 1);
  return {
    shotsInBurst,
    aimBloom: clamp(burstBloom * suppressionBloom, 1, 8),
  };
}

/** Combined aim-cone multiplier for this NPC (>= 1; 1 means base accuracy). */
export function npcAimBloom(state: NpcAiState | undefined) {
  return Math.max(1, finite(state?.aimBloom ?? 1, 1));
}

/**
 * Multiplier the engine should apply to its base hit-chance roll in
 * `enemyFire`: `accuracy = clamp(base * npcAccuracyScale(actor.aiState), 0.02, 0.97)`.
 */
export function npcAccuracyScale(state: NpcAiState | undefined) {
  return clamp(finite(state?.accuracyScale ?? 1, 1), 0, 4);
}

/**
 * Optional precise-shot hook for the engine: call it inside `enemyFire`
 * (`actor.aiState = recordNpcShotFired(actor.aiState)`) so a real trigger
 * pull counts as one burst shot even when the actual cadence beats the
 * burstShotIntervalSeconds estimate. Step-based accumulation continues
 * from the recorded count without double counting. Safe to omit — bloom
 * still grows on the estimated cadence alone.
 */
export function recordNpcShotFired(
  state: NpcAiState,
  overrides: Partial<NpcAiConfig> = {},
): NpcAiState {
  const config = resolveNpcAiConfig(overrides);
  const interval = Math.max(0.000001, config.burstShotIntervalSeconds);
  const shotsInBurst = Math.max(
    Math.floor(nonNegative(state.shotsInBurst ?? 0)),
    Math.floor(nonNegative(state.burstFireSeconds ?? 0) / interval),
  ) + 1;
  const bloom = resolveAimBloom(
    Math.max(nonNegative(state.burstFireSeconds ?? 0), shotsInBurst * interval),
    state.suppressionLevel ?? 0,
    config,
  );
  return {
    ...state,
    shotsInBurst,
    burstFireSeconds: shotsInBurst * interval,
    ambushShotAvailable: false,
    aimBloom: bloom.aimBloom,
    accuracyScale: clamp(1 / bloom.aimBloom, 0, 4),
  };
}

export function evaluatePerception(
  input: Pick<NpcAiInput, 'deltaSeconds' | 'target' | 'sound'>,
  overrides: Partial<NpcAiConfig> = {},
): PerceptionEvaluation {
  const config = resolveNpcAiConfig(overrides);
  const deltaSeconds = clamp(input.deltaSeconds, 0, config.maxStepSeconds);
  let visualSignal = 0;
  let auditorySignal = 0;

  if (input.target?.inLineOfSight && config.visionRangeMeters > 0) {
    const distance = nonNegative(input.target.distanceMeters);
    const alignment = clamp(input.target.viewAlignment, -1, 1);
    if (distance <= config.visionRangeMeters && alignment >= config.minimumViewAlignment) {
      const proximity = 1 - distance / config.visionRangeMeters;
      const alignmentRange = Math.max(0.000001, 1 - config.minimumViewAlignment);
      const alignmentQuality = clamp((alignment - config.minimumViewAlignment) / alignmentRange, 0, 1);
      const visibility = clamp(input.target.visibility, 0, 1);
      const movement = clamp(input.target.movement, 0, 1);
      visualSignal = visibility
        * (0.25 + proximity * 0.75)
        * (0.35 + alignmentQuality * 0.65)
        * (0.45 + movement * 0.55);
    }
  }

  if (input.sound && config.hearingRangeMeters > 0) {
    const distance = nonNegative(input.sound.distanceMeters);
    if (distance <= config.hearingRangeMeters) {
      auditorySignal = clamp(input.sound.loudness, 0, 1)
        * (1 - distance / config.hearingRangeMeters);
    }
  }

  const targetSeen = visualSignal >= config.minimumVisualSignal;
  const soundHeard = auditorySignal >= config.minimumAuditorySignal;
  return {
    visualSignal,
    auditorySignal,
    suspicionGain: deltaSeconds * (
      (targetSeen ? visualSignal * config.visualSuspicionPerSecond : 0)
      + (soundHeard ? auditorySignal * config.auditorySuspicionPerSecond : 0)
    ),
    targetSeen,
    soundHeard,
  };
}

export function chooseBestCover(
  candidates: readonly CoverCandidate[],
  overrides: Partial<NpcAiConfig> = {},
): CoverSelection | undefined {
  const config = resolveNpcAiConfig(overrides);
  let best: CoverSelection | undefined;

  for (const candidate of candidates) {
    const distance = nonNegative(candidate.distanceMeters);
    if (!candidate.id || distance > config.coverMaxDistanceMeters) continue;
    const distanceCost = config.coverMaxDistanceMeters > 0
      ? clamp(distance / config.coverMaxDistanceMeters, 0, 1)
      : 1;
    const score = (1 - clamp(candidate.exposure, 0, 1)) * config.coverExposureWeight
      - distanceCost * config.coverDistanceWeight
      - clamp(candidate.routeCost, 0, 1) * config.coverRouteWeight
      + clamp(candidate.flankQuality, 0, 1) * config.coverFlankWeight;
    const selection: CoverSelection = {
      id: candidate.id,
      position: copyVector(candidate.position),
      score,
    };
    if (
      !best
      || selection.score > best.score
      || (selection.score === best.score && lexicalCompare(selection.id, best.id) < 0)
    ) {
      best = selection;
    }
  }

  return best;
}

function phaseForSuspicion(suspicion: number, config: NpcAiConfig): AwarenessPhase {
  if (suspicion >= config.combatThreshold) return 'combat';
  if (suspicion >= config.alertThreshold) return 'alerted';
  if (suspicion >= config.suspiciousThreshold) return 'suspicious';
  return 'calm';
}

function consumeRadio(
  state: NpcAiState,
  signals: readonly SquadRadioSignal[],
): { signal?: SquadRadioSignal; cursor: Readonly<Record<string, number>> } {
  const cursor: Record<string, number> = { ...state.radioCursor };
  let strongest: SquadRadioSignal | undefined;
  const ordered = [...signals].sort((a, b) => (
    a.sequence - b.sequence || lexicalCompare(a.senderId, b.senderId)
  ));

  for (const signal of ordered) {
    if (!state.squadId || signal.squadId !== state.squadId || signal.senderId === state.npcId) continue;
    const sequence = Math.max(0, Math.floor(finite(signal.sequence)));
    if (sequence <= (cursor[signal.senderId] ?? 0)) continue;
    cursor[signal.senderId] = sequence;
    const confidence = clamp(signal.confidence, 0, 1);
    if (confidence <= 0) continue;
    if (
      !strongest
      || confidence > clamp(strongest.confidence, 0, 1)
      || (confidence === clamp(strongest.confidence, 0, 1) && sequence > strongest.sequence)
      || (
        confidence === clamp(strongest.confidence, 0, 1)
        && sequence === strongest.sequence
        && lexicalCompare(signal.senderId, strongest.senderId) < 0
      )
    ) {
      strongest = { ...signal, sequence, confidence, targetPosition: copyVector(signal.targetPosition) };
    }
  }

  return { signal: strongest, cursor };
}

function makeDecision(
  state: NpcAiState,
  input: NpcAiInput,
  perception: PerceptionEvaluation,
  radioReceived: boolean,
  config: NpcAiConfig,
): NpcDecision {
  if (state.phase === 'incapacitated') {
    return { action: 'incapacitated', reason: 'health-depleted' };
  }
  if (state.damageReactionRemainingSeconds > 0) {
    return {
      action: 'react-to-damage',
      reason: 'damage',
      aimTarget: state.lastKnownTarget,
    };
  }

  if (state.phase === 'combat' && perception.targetSeen && input.target) {
    const healthFraction = nonNegative(input.maxHealth) > 0
      ? clamp(input.health / input.maxHealth, 0, 1)
      : 0;
    const coverReason: NpcDecisionReason | undefined = input.underFire
      ? 'under-fire'
      : healthFraction <= config.lowHealthCoverFraction
        ? 'low-health'
        : input.needsReload
          ? 'reload'
          : undefined;
    if (coverReason) {
      const cover = chooseBestCover(input.coverCandidates ?? [], config);
      if (cover) {
        return {
          action: 'take-cover',
          reason: coverReason,
          destination: cover.position,
          aimTarget: copyVector(input.target.position),
          coverId: cover.id,
        };
      }
    }
    return {
      action: 'engage',
      reason: 'visual-contact',
      aimTarget: copyVector(input.target.position),
    };
  }

  if (state.phase === 'searching' || state.phase === 'combat') {
    return {
      action: 'search',
      reason: 'lost-contact',
      destination: state.lastKnownTarget,
    };
  }
  if (state.phase === 'alerted') {
    return {
      action: perception.targetSeen ? 'investigate' : 'search',
      reason: radioReceived ? 'squad-report' : perception.targetSeen ? 'visual-contact' : 'lost-contact',
      destination: state.lastKnownTarget ?? state.investigatePoint,
    };
  }
  if (state.phase === 'suspicious') {
    return {
      action: 'investigate',
      reason: perception.soundHeard ? 'auditory-contact' : 'visual-contact',
      destination: state.investigatePoint ?? state.lastKnownTarget,
    };
  }
  if (state.phase === 'returning') {
    return {
      action: 'return',
      reason: 'search-exhausted',
      destination: state.homePosition,
    };
  }
  return { action: 'patrol', reason: 'routine' };
}

export function stepNpcAi(
  state: NpcAiState,
  input: NpcAiInput,
  overrides: Partial<NpcAiConfig> = {},
): NpcAiStep {
  const config = resolveNpcAiConfig(overrides);
  const deltaSeconds = clamp(input.deltaSeconds, 0, config.maxStepSeconds);
  const perception = evaluatePerception(input, config);
  const consumedRadio = consumeRadio(state, input.radioSignals ?? []);
  const directDamage = Boolean(input.damage && nonNegative(input.damage.amount) > 0);
  const maxHealth = nonNegative(input.maxHealth);
  const health = clamp(input.health, 0, maxHealth || 0);
  const alive = maxHealth > 0 && health > 0;
  const priorSearchRemaining = nonNegative(state.searchRemainingSeconds);
  const wasSearching = state.phase === 'searching';

  let suspicion = clamp(state.suspicion, 0, 1);
  let lastKnownTarget = state.lastKnownTarget && copyVector(state.lastKnownTarget);
  let investigatePoint = state.investigatePoint && copyVector(state.investigatePoint);
  let secondsSinceTargetSeen = state.secondsSinceTargetSeen;
  let searchRemainingSeconds = priorSearchRemaining;
  let damageReactionRemainingSeconds = Math.max(
    0,
    nonNegative(state.damageReactionRemainingSeconds) - deltaSeconds,
  );
  let radioCooldownRemainingSeconds = Math.max(
    0,
    nonNegative(state.radioCooldownRemainingSeconds) - deltaSeconds,
  );

  const hasFreshStimulus = perception.targetSeen || perception.soundHeard || directDamage || Boolean(consumedRadio.signal);
  if (hasFreshStimulus) {
    suspicion = clamp(suspicion + perception.suspicionGain, 0, 1);
  } else {
    const decayScale = wasSearching ? config.searchSuspicionDecayScale : 1;
    suspicion = clamp(suspicion - config.suspicionDecayPerSecond * decayScale * deltaSeconds, 0, 1);
  }

  if (perception.targetSeen && input.target) {
    lastKnownTarget = copyVector(input.target.position);
    investigatePoint = copyVector(input.target.position);
    secondsSinceTargetSeen = 0;
    searchRemainingSeconds = config.searchDurationSeconds;
  } else if (secondsSinceTargetSeen !== null) {
    secondsSinceTargetSeen = nonNegative(secondsSinceTargetSeen) + deltaSeconds;
  }

  if (perception.soundHeard && input.sound) {
    investigatePoint = copyVector(input.sound.position);
  }

  if (consumedRadio.signal) {
    suspicion = Math.max(
      suspicion,
      config.radioAlertLevel * clamp(consumedRadio.signal.confidence, 0, 1),
    );
    lastKnownTarget = copyVector(consumedRadio.signal.targetPosition);
    investigatePoint = copyVector(consumedRadio.signal.targetPosition);
    secondsSinceTargetSeen = 0;
    searchRemainingSeconds = Math.max(searchRemainingSeconds, config.radioSearchDurationSeconds);
  }

  if (directDamage && input.damage) {
    suspicion = 1;
    lastKnownTarget = copyVector(input.damage.sourcePosition ?? input.target?.position ?? input.position);
    investigatePoint = copyVector(lastKnownTarget);
    secondsSinceTargetSeen = 0;
    searchRemainingSeconds = config.searchDurationSeconds;
    const damageFraction = maxHealth > 0 ? nonNegative(input.damage.amount) / maxHealth : 1;
    const reactionScale = damageFraction >= config.heavyDamageFraction
      ? config.heavyDamageReactionMultiplier
      : 1;
    damageReactionRemainingSeconds = Math.max(
      damageReactionRemainingSeconds,
      config.damageReactionSeconds * reactionScale,
    );
  }

  let phase: AwarenessPhase;
  if (!alive) {
    phase = 'incapacitated';
    damageReactionRemainingSeconds = 0;
  } else if (directDamage) {
    phase = 'combat';
  } else if (perception.targetSeen) {
    phase = phaseForSuspicion(suspicion, config);
  } else if (consumedRadio.signal) {
    phase = state.phase === 'combat' ? 'combat' : phaseForSuspicion(suspicion, config);
  } else if (perception.soundHeard) {
    phase = phaseForSuspicion(suspicion, config);
  } else if (wasSearching) {
    searchRemainingSeconds = Math.max(0, searchRemainingSeconds - deltaSeconds);
    phase = searchRemainingSeconds > 0 ? 'searching' : 'returning';
  } else if (state.phase === 'combat' || state.phase === 'alerted') {
    const withinGrace = secondsSinceTargetSeen !== null
      && secondsSinceTargetSeen <= config.lostSightGraceSeconds;
    if (withinGrace) {
      phase = state.phase;
    } else if (lastKnownTarget && searchRemainingSeconds > 0) {
      phase = 'searching';
    } else {
      phase = 'returning';
    }
  } else if (state.phase === 'returning') {
    const arrivedHome = planarDistance(input.position, state.homePosition) <= config.returnArrivalMeters;
    if (arrivedHome) {
      phase = 'calm';
      suspicion = 0;
      lastKnownTarget = undefined;
      investigatePoint = undefined;
      secondsSinceTargetSeen = null;
    } else {
      phase = 'returning';
    }
  } else {
    phase = phaseForSuspicion(suspicion, config);
  }

  let outboundRadioSequence = Math.max(0, Math.floor(finite(state.outboundRadioSequence)));
  let emittedRadio: SquadRadioSignal | undefined;
  const acquiredCombatTarget = perception.targetSeen && phase === 'combat' && state.phase !== 'combat';
  if (
    alive
    && state.squadId
    && radioCooldownRemainingSeconds <= 0
    && (directDamage || acquiredCombatTarget)
    && lastKnownTarget
  ) {
    outboundRadioSequence += 1;
    emittedRadio = {
      squadId: state.squadId,
      senderId: state.npcId,
      sequence: outboundRadioSequence,
      targetPosition: copyVector(lastKnownTarget),
      confidence: 1,
      threat: directDamage ? 'damage' : 'target',
    };
    radioCooldownRemainingSeconds = config.radioCooldownSeconds;
  }

  const baseState: NpcAiState = {
    npcId: state.npcId,
    squadId: state.squadId,
    homePosition: copyVector(state.homePosition),
    phase,
    suspicion,
    secondsSinceTargetSeen,
    searchRemainingSeconds,
    damageReactionRemainingSeconds,
    radioCooldownRemainingSeconds,
    lastKnownTarget,
    investigatePoint,
    outboundRadioSequence,
    radioCursor: consumedRadio.cursor,
  };
  const decision = makeDecision(
    baseState,
    input,
    perception,
    Boolean(consumedRadio.signal),
    config,
  );

  // Dynamic accuracy ("aim bloom") bookkeeping — fully deterministic, so the
  // engine can keep its seeded hit roll and simply scale it by accuracyScale.
  //
  // Suppression: taking a hit (damage stimulus or the engine's underFire
  // pulse) pins suppression to full and it eases back over
  // suppressionRecoverySeconds, blooming the cone toward suppressionBloomMax.
  let suppressionLevel = clamp(state.suppressionLevel ?? 0, 0, 1);
  if (alive && (directDamage || input.underFire)) {
    suppressionLevel = 1;
  } else if (config.suppressionRecoverySeconds > 0) {
    suppressionLevel = Math.max(0, suppressionLevel - deltaSeconds / config.suppressionRecoverySeconds);
  } else {
    suppressionLevel = 0;
  }

  // Burst bloom: only a stationary NPC with eyes on the target is actually
  // cycling the trigger, so firing time accrues only while the 'engage'
  // decision holds without repositioning — breaking contact, taking cover,
  // reacting to damage, or strafing all reset the cone.
  const engaging = alive && decision.action === 'engage' && perception.targetSeen;
  const movedSpeed = deltaSeconds > 0 && state.previousPosition
    ? planarDistance(state.previousPosition, input.position) / deltaSeconds
    : 0;
  const repositioned = movedSpeed > config.burstResetMoveSpeed;
  const burstFireSeconds = engaging && !repositioned
    ? nonNegative(state.burstFireSeconds ?? 0) + deltaSeconds
    : 0;
  const bloom = resolveAimBloom(burstFireSeconds, suppressionLevel, config);

  // Ambush bonus: fresh contact (first sighting after losing track, or being
  // damaged into combat) arms one tighter first shot; the first burst shot
  // spends it, so breaking line of sight re-arms the bonus.
  let ambushShotAvailable = alive && Boolean(state.ambushShotAvailable);
  if (
    directDamage
    || (perception.targetSeen
      && (state.secondsSinceTargetSeen === null || nonNegative(state.secondsSinceTargetSeen) > 0))
  ) {
    ambushShotAvailable = alive;
  }
  if (bloom.shotsInBurst > 0) ambushShotAvailable = false;

  const accuracyScale = clamp(
    (engaging && ambushShotAvailable ? config.ambushAccuracyBonus : 1) / bloom.aimBloom,
    0,
    4,
  );

  const nextState: NpcAiState = {
    ...baseState,
    burstFireSeconds,
    shotsInBurst: bloom.shotsInBurst,
    suppressionLevel,
    ambushShotAvailable,
    aimBloom: bloom.aimBloom,
    accuracyScale,
    previousPosition: copyVector(input.position),
  };

  return {
    state: nextState,
    decision,
    perception,
    emittedRadio,
  };
}
