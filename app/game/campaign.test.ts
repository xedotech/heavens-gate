import { describe, expect, it } from 'vitest';
import { MISSIONS } from './types';

describe("Heaven's Gate campaign data", () => {
  it('ships a complete mission arc with a playable epilogue', () => {
    expect(MISSIONS).toHaveLength(8);
    expect(MISSIONS[0].kind).toBe('reach');
    expect(MISSIONS.at(-2)?.kind).toBe('choice');
    expect(MISSIONS.at(-1)?.kind).toBe('complete');
  });

  it('uses unique stable IDs for checkpoint saves', () => {
    const ids = MISSIONS.map((mission) => mission.id);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(id).toMatch(/^[a-z0-9-]+$/));
  });

  it('gives every mission authored copy and completion feedback', () => {
    MISSIONS.forEach((mission) => {
      expect(mission.title.length).toBeGreaterThan(3);
      expect(mission.summary.length).toBeGreaterThan(20);
      expect(mission.completionLine.length).toBeGreaterThan(12);
    });
  });

  it('provides targets for every location-driven operation', () => {
    MISSIONS.filter((mission) => ['reach', 'drive', 'boss'].includes(mission.kind)).forEach((mission) => {
      expect(mission.target).toHaveLength(3);
      expect(mission.radius).toBeGreaterThan(0);
    });
  });

  it('requires positive counts for elimination and memory objectives', () => {
    MISSIONS.filter((mission) => ['eliminate', 'echoes'].includes(mission.kind)).forEach((mission) => {
      expect(mission.count).toBeGreaterThan(0);
    });
  });
});
