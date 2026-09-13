import { describe, expect, it } from 'vitest';
import {
  chooseBestCover,
  createNpcAiState,
  evaluatePerception,
  npcAccuracyScale,
  npcAimBloom,
  recordNpcShotFired,
  stepNpcAi,
  type NpcAiInput,
  type NpcAiState,
} from './ai';

const origin = { x: 0, y: 0, z: 0 };
const target = { x: 8, y: 0, z: 2 };

function baseInput(overrides: Partial<NpcAiInput> = {}): NpcAiInput {
  return {
    deltaSeconds: 0.5,
    position: origin,
    health: 100,
    maxHealth: 100,
    ...overrides,
  };
}

function visibleTarget() {
  return {
    position: target,
    distanceMeters: 8,
    viewAlignment: 1,
    inLineOfSight: true,
    visibility: 1,
    movement: 1,
  } as const;
}

function alertGuard(): NpcAiState {
  return {
    ...createNpcAiState({ npcId: 'guard-a', squadId: 'choir', homePosition: origin }),
    phase: 'combat',
    suspicion: 1,
    secondsSinceTargetSeen: 0,
    searchRemainingSeconds: 2,
    lastKnownTarget: target,
  };
}

describe('deterministic NPC awareness and combat decisions', () => {
  it('gates visual perception by line of sight, range, and view alignment', () => {
    const visible = evaluatePerception(baseInput({ target: visibleTarget() }));
    const occluded = evaluatePerception(baseInput({
      target: { ...visibleTarget(), inLineOfSight: false },
    }));
    const behind = evaluatePerception(baseInput({
      target: { ...visibleTarget(), viewAlignment: -1 },
    }));

    expect(visible.targetSeen).toBe(true);
    expect(visible.suspicionGain).toBeGreaterThan(0);
    expect(occluded.visualSignal).toBe(0);
    expect(behind.targetSeen).toBe(false);
  });

  it('advances through suspicion and alert phases before engaging', () => {
    const config = {
      visualSuspicionPerSecond: 0.5,
      suspiciousThreshold: 0.2,
      alertThreshold: 0.45,
      combatThreshold: 0.7,
    };
    let state = createNpcAiState({ npcId: 'guard-a', homePosition: origin });
    const phases: string[] = [];

    for (let tick = 0; tick < 8; tick += 1) {
      const result = stepNpcAi(state, baseInput({ target: visibleTarget() }), config);
      state = result.state;
      phases.push(state.phase);
    }

    expect(phases).toContain('suspicious');
    expect(phases).toContain('alerted');
    expect(state.phase).toBe('combat');
    expect(stepNpcAi(state, baseInput({ target: visibleTarget() }), config).decision).toMatchObject({
      action: 'engage',
      reason: 'visual-contact',
    });
  });

  it('investigates audible events and decays back to calm without contact', () => {
    const config = {
      auditorySuspicionPerSecond: 1,
      suspiciousThreshold: 0.1,
      suspicionDecayPerSecond: 1,
    };
    let result = stepNpcAi(
      createNpcAiState({ npcId: 'listener', homePosition: origin }),
      baseInput({
        sound: { position: { x: 4, y: 0, z: -3 }, distanceMeters: 4, loudness: 1 },
      }),
      config,
    );

    expect(result.state.phase).toBe('suspicious');
    expect(result.decision).toMatchObject({
      action: 'investigate',
      reason: 'auditory-contact',
      destination: { x: 4, y: 0, z: -3 },
    });
    result = stepNpcAi(result.state, baseInput({ deltaSeconds: 1 }), config);
    expect(result.state.phase).toBe('calm');
    expect(result.decision.action).toBe('patrol');
  });

  it('selects tactical cover with stable tie-breaking, otherwise engages', () => {
    const equalCover = [
      { id: 'cover-b', position: { x: 3, y: 0, z: 1 }, distanceMeters: 3, exposure: 0.1, routeCost: 0.1, flankQuality: 0.5 },
      { id: 'cover-a', position: { x: 2, y: 0, z: 1 }, distanceMeters: 3, exposure: 0.1, routeCost: 0.1, flankQuality: 0.5 },
    ];
    expect(chooseBestCover(equalCover)?.id).toBe('cover-a');

    const covered = stepNpcAi(alertGuard(), baseInput({
      target: visibleTarget(),
      underFire: true,
      coverCandidates: equalCover,
    }));
    expect(covered.decision).toMatchObject({
      action: 'take-cover',
      reason: 'under-fire',
      coverId: 'cover-a',
    });

    const exposed = stepNpcAi(alertGuard(), baseInput({
      target: visibleTarget(),
      underFire: true,
      coverCandidates: [],
    }));
    expect(exposed.decision.action).toBe('engage');
  });

  it('searches the last known position, then returns home after the timer expires', () => {
    const config = {
      lostSightGraceSeconds: 0.25,
      searchDurationSeconds: 1,
      suspicionDecayPerSecond: 1,
      searchSuspicionDecayScale: 1,
    };
    let result = stepNpcAi(
      { ...alertGuard(), searchRemainingSeconds: 1 },
      baseInput({ deltaSeconds: 0.5 }),
      config,
    );
    expect(result.state.phase).toBe('searching');
    expect(result.decision).toMatchObject({ action: 'search', destination: target });

    result = stepNpcAi(result.state, baseInput({ deltaSeconds: 0.5 }), config);
    expect(result.state.phase).toBe('searching');
    result = stepNpcAi(result.state, baseInput({ deltaSeconds: 0.5 }), config);
    expect(result.state.phase).toBe('returning');
    expect(result.decision).toMatchObject({ action: 'return', destination: origin });

    result = stepNpcAi(result.state, baseInput({ position: origin }), config);
    expect(result.state.phase).toBe('calm');
    expect(result.state.lastKnownTarget).toBeUndefined();
  });

  it('reacts to damage, broadcasts the threat, and handles depleted health', () => {
    const state = createNpcAiState({ npcId: 'guard-a', squadId: 'choir', homePosition: origin });
    const hit = stepNpcAi(state, baseInput({
      damage: { amount: 25, sourcePosition: target },
    }));

    expect(hit.state.phase).toBe('combat');
    expect(hit.state.damageReactionRemainingSeconds).toBeGreaterThan(0);
    expect(hit.decision.action).toBe('react-to-damage');
    expect(hit.emittedRadio).toMatchObject({
      squadId: 'choir',
      senderId: 'guard-a',
      sequence: 1,
      targetPosition: target,
      threat: 'damage',
    });

    const down = stepNpcAi(hit.state, baseInput({ health: 0, damage: { amount: 100 } }));
    expect(down.state.phase).toBe('incapacitated');
    expect(down.decision).toEqual({ action: 'incapacitated', reason: 'health-depleted' });
  });

  it('propagates squad reports once without creating a radio feedback loop', () => {
    const receiver = createNpcAiState({ npcId: 'guard-b', squadId: 'choir', homePosition: origin });
    const signal = {
      squadId: 'choir',
      senderId: 'guard-a',
      sequence: 1,
      targetPosition: target,
      confidence: 1,
      threat: 'target' as const,
    };
    const first = stepNpcAi(receiver, baseInput({
      radioSignals: [
        { ...signal, squadId: 'outsiders', sequence: 9 },
        signal,
      ],
    }));

    expect(first.state.phase).toBe('alerted');
    expect(first.decision).toMatchObject({
      action: 'search',
      reason: 'squad-report',
      destination: target,
    });
    expect(first.state.radioCursor).toEqual({ 'guard-a': 1 });
    expect(first.emittedRadio).toBeUndefined();

    const duplicate = stepNpcAi(first.state, baseInput({ radioSignals: [signal] }));
    expect(duplicate.state.radioCursor).toEqual({ 'guard-a': 1 });
    expect(duplicate.emittedRadio).toBeUndefined();
  });

  it('records but does not act on a zero-confidence squad report', () => {
    const receiver = createNpcAiState({ npcId: 'guard-b', squadId: 'choir', homePosition: origin });
    const result = stepNpcAi(receiver, baseInput({
      radioSignals: [{
        squadId: 'choir',
        senderId: 'guard-a',
        sequence: 1,
        targetPosition: target,
        confidence: 0,
        threat: 'target',
      }],
    }));

    expect(result.state.phase).toBe('calm');
    expect(result.state.radioCursor).toEqual({ 'guard-a': 1 });
    expect(result.decision.action).toBe('patrol');
  });

  it('returns byte-for-byte equivalent output for equivalent inputs', () => {
    const state = alertGuard();
    const input = baseInput({
      target: visibleTarget(),
      needsReload: true,
      coverCandidates: [
        { id: 'arch', position: { x: 2, y: 0, z: 2 }, distanceMeters: 3, exposure: 0.2, routeCost: 0.1, flankQuality: 0.8 },
      ],
    });

    expect(stepNpcAi(state, input)).toEqual(stepNpcAi(state, input));
  });
});

describe('dynamic enemy accuracy (aim bloom and suppression)', () => {
  function engaging(state: NpcAiState, overrides: Partial<NpcAiInput> = {}) {
    return stepNpcAi(state, baseInput({ target: visibleTarget(), ...overrides }));
  }

  it('blooms the aim cone over a sustained stationary burst', () => {
    let state = alertGuard();
    const blooms: number[] = [];
    for (let tick = 0; tick < 8; tick += 1) {
      const result = engaging(state);
      state = result.state;
      expect(result.decision.action).toBe('engage');
      blooms.push(npcAimBloom(state));
    }

    // ~1.5s per virtual shot: bloom should stair-step up ~15% per shot.
    expect(state.shotsInBurst).toBeGreaterThanOrEqual(2);
    expect(blooms[0]).toBe(1);
    expect(blooms[blooms.length - 1]).toBeGreaterThan(blooms[0]);
    expect(blooms[blooms.length - 1]).toBeLessThanOrEqual(1.9);
    // Accuracy scale is the reciprocal: sustained fire is less accurate.
    expect(npcAccuracyScale(state)).toBeCloseTo(1 / npcAimBloom(state), 6);
  });

  it('resets burst bloom after the NPC stops firing or repositions', () => {
    let state = alertGuard();
    for (let tick = 0; tick < 6; tick += 1) state = engaging(state).state;
    expect(npcAimBloom(state)).toBeGreaterThan(1);

    // Losing sight of the target breaks the burst entirely.
    const paused = stepNpcAi(state, baseInput());
    expect(paused.decision.action).not.toBe('engage');
    expect(paused.state.burstFireSeconds).toBe(0);
    expect(npcAimBloom(paused.state)).toBe(1);
    expect(npcAccuracyScale(paused.state)).toBe(1);

    // A big move between steps also counts as repositioning mid-engagement.
    state = alertGuard();
    state = engaging(state).state;
    const strafed = engaging(state, { position: { x: 6, y: 0, z: 0 } });
    expect(strafed.state.burstFireSeconds).toBe(0);
    expect(strafed.state.shotsInBurst).toBe(0);
  });

  it('widens the cone under fire and recovers after the pressure fades', () => {
    const suppressed = engaging(alertGuard(), { underFire: true });
    expect(suppressed.state.suppressionLevel).toBe(1);
    expect(npcAimBloom(suppressed.state)).toBeCloseTo(2, 6);
    expect(npcAccuracyScale(suppressed.state)).toBeLessThanOrEqual(0.5 + 1e-9);

    // A direct hit suppresses even harder than a near miss flag — and the
    // recovery is linear over suppressionRecoverySeconds once clear.
    const shot = stepNpcAi(alertGuard(), baseInput({
      damage: { amount: 12, sourcePosition: target },
    }));
    expect(shot.state.suppressionLevel).toBe(1);
    expect(npcAimBloom(shot.state)).toBeCloseTo(2, 6);

    // While suppressed and unable to fire back (reacting, then searching),
    // only suppression drives the cone — it should relax back to base.
    let state = shot.state;
    for (let tick = 0; tick < 5; tick += 1) {
      state = stepNpcAi(state, baseInput()).state;
    }
    expect(state.suppressionLevel).toBe(0);
    expect(npcAimBloom(state)).toBe(1);
  });

  it('gives the first shot after acquiring the target an ambush bonus', () => {
    // A guard who lost the target (secondsSinceTargetSeen > 0) re-acquires it.
    const reacquiring: NpcAiState = { ...alertGuard(), secondsSinceTargetSeen: 2 };
    const opener = engaging(reacquiring);
    expect(opener.state.ambushShotAvailable).toBe(true);
    expect(npcAccuracyScale(opener.state)).toBeGreaterThan(1);

    // The bonus is spent by the first burst shot (~1.5s in), so sustained
    // fire drops back to the bloomed baseline.
    let state = opener.state;
    for (let tick = 0; tick < 4; tick += 1) state = engaging(state).state;
    expect(state.ambushShotAvailable).toBe(false);
    expect(npcAccuracyScale(state)).toBeLessThan(1);
  });

  it('lets the engine record real shots without double counting the estimate', () => {
    let state = engaging(alertGuard()).state;
    expect(state.ambushShotAvailable).toBe(false);

    const armed: NpcAiState = { ...alertGuard(), secondsSinceTargetSeen: 2, ambushShotAvailable: true };
    state = engaging(armed).state;
    state = recordNpcShotFired(state);
    expect(state.shotsInBurst).toBe(1);
    expect(state.ambushShotAvailable).toBe(false);
    expect(npcAimBloom(state)).toBeCloseTo(1.15, 6);

    // Time-based accumulation resumes from the recorded count:
    // 1.5s -> 2.0 -> 2.5 -> 3.0 crosses the second virtual shot.
    state = engaging(state).state;
    expect(state.shotsInBurst).toBe(1);
    state = engaging(state).state;
    state = engaging(state).state;
    expect(state.shotsInBurst).toBe(2);
  });
});
