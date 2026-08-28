# Game design reference

## High concept

Aurel, a courier who may be a manufactured memory, crosses the city of Aethel after its afterlife network begins broadcasting their name. The governing Choir has turned heaven into infrastructure: identity is stored, edited, and denied by policy. The campaign asks whether liberation without predictability is better than safety built on imprisonment.

## Pillars

1. **Movement is authorship.** Walking, sprinting, jumping, driving, and crossing the Veil are different ways to read the city.
2. **The world answers.** Civilians flee danger, Choir heat escalates, patrols pursue, and the ending permanently changes atmosphere and gate behavior.
3. **Myth is a system.** Resonance, memory echoes, gates, and the Archon are playable mechanics rather than lore-only nouns.
4. **Restraint creates scale.** The HUD stays quiet so landmarks, light, audio, and silhouettes carry the spectacle.

## Combat loop

The Morrow sidearm carries 18 rounds. Critical hits reward controlled aim; armor absorbs most early incoming damage. The resonance pulse clears close threats but consumes the same resource needed to enter the Veil, creating a legible choice between force and information. Violence against civilians sharply raises heat.

## Mission pacing

The campaign alternates navigation, combat, driving, exploration, boss combat, and moral choice so no single system overstays. Each operation writes a checkpoint. The final state continues in free roam, making the ending visible in play instead of only in a cutscene.

## Expansion seams

- Replace procedural humanoids with glTF characters while keeping actor contracts.
- Stream authored districts through spatial cells.
- Add network co-op around deterministic mission state.
- Move saves to an authenticated service without changing the `SaveState` schema.
- Add authored voice and music through the existing audio buses.
- Build additional weapons by implementing the shared shooting and HUD contracts.
