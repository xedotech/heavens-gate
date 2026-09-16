export interface UpgradeDefinition {
  id: string;
  name: string;
  detail: string;
  cost: number;
}

export const UPGRADES: UpgradeDefinition[] = [
  { id: 'vitals', name: 'Vitality lattice', detail: 'Maximum health 100 → 130, restored on attunement.', cost: 30 },
  { id: 'aegis', name: 'Aegis weave', detail: 'Armor capacity 50 → 90 and slowly regenerates.', cost: 35 },
  { id: 'coil', name: 'Coil tensioning', detail: 'All weapon damage increased by 20%.', cost: 45 },
  { id: 'flow', name: 'Flow channel', detail: 'Resonance regenerates 50% faster.', cost: 35 },
  { id: 'plating', name: 'Seraph plating', detail: 'Incoming damage reduced by 22%.', cost: 40 },
  { id: 'shroud', name: 'Shroud baffles', detail: 'Muffled report — shots draw half the attention, startle nobody, raise less heat.', cost: 30 },
];

export const UPGRADE_IDS = new Set(UPGRADES.map((upgrade) => upgrade.id));

/** Marks paid per kill, keyed by the id prefix the actor was spawned with. */
export function marksForActor(id: string, kind: string) {
  if (kind === 'civilian') return 0;
  if (kind === 'boss') return 60;
  if (kind === 'drone') return 2;
  if (id.startsWith('sentinel-') || id.startsWith('stalker-')) return 10;
  if (id.startsWith('reinforce-')) return 12;
  return 6;
}
