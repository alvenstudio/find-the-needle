import type { AssetManifestEntry } from '../core/Assets';

/**
 * The model library.
 *
 * Split into a small critical set that gates the title screen and a larger
 * set that streams in behind it, so the player is looking at the farm within a
 * second or two rather than staring at a progress bar for the whole download.
 *
 * `castShadow` is off for anything small or numerous: a grass tuft's shadow is
 * invisible and its shadow-map draw is not.
 */

const url = (name: string): string => `${import.meta.env.BASE_URL}models/${name}.glb`;

function entry(name: string, options: Partial<AssetManifestEntry> = {}): AssetManifestEntry {
  return { name, url: url(name), castShadow: true, receiveShadow: true, ...options };
}

/** Needed before the first frame can be drawn. */
export const CRITICAL_ASSETS: readonly AssetManifestEntry[] = [
  entry('straw', { castShadow: false, receiveShadow: false }),
  entry('hay_wisp', { castShadow: false, receiveShadow: false }),
  entry('hands', { castShadow: false, receiveShadow: false }),
  entry('needle', { castShadow: false }),
  entry('sell_trough'),
  entry('upgrade_kiosk'),
  entry('grass_tuft', {
    castShadow: false,
    variant: { key: 'grass', rim: 0.3, wind: 0.09, windAnchor: 0 },
  }),
];

/** Streams in while the player reads the title screen. */
export const DEFERRED_ASSETS: readonly AssetManifestEntry[] = [
  // tools
  entry('pitchfork', { castShadow: false, receiveShadow: false }),
  entry('rake', { castShadow: false, receiveShadow: false }),
  entry('hay_hook', { castShadow: false, receiveShadow: false }),
  entry('leaf_blower', { castShadow: false, receiveShadow: false }),
  entry('hay_vacuum', { castShadow: false, receiveShadow: false }),
  entry('vacuum_pack', { castShadow: false, receiveShadow: false }),
  entry('magnifier', { castShadow: false, receiveShadow: false }),
  entry('metal_detector', { castShadow: false, receiveShadow: false }),
  entry('compressor', { castShadow: false, receiveShadow: false }),

  // buildings and world furniture
  entry('barn'),
  entry('silo'),
  entry('windmill'),
  entry('windmill_blades'),
  entry('shed'),
  entry('chicken_coop'),
  entry('water_tower'),
  entry('hay_barn'),
  entry('quest_board'),
  entry('leaderboard'),
  entry('rebirth_shrine'),
  entry('tier_gate'),
  entry('tier_gate_rope'),
  entry('storage_silo'),
  entry('spawn_pad'),

  // farmyard props
  entry('fence_section'),
  entry('fence_gate'),
  entry('trough'),
  entry('bucket'),
  entry('crate'),
  entry('barrel'),
  entry('wheelbarrow'),
  entry('signpost'),
  entry('milk_can'),
  entry('pumpkin'),
  entry('apple_crate'),
  entry('scarecrow'),
  entry('well'),
  entry('hay_cart'),
  entry('bale_round'),
  entry('bale_square'),

  // nature
  entry('tree_pine', { variant: { key: 'tree', rim: 0.28, wind: 0.02, windAnchor: 1.2 } }),
  entry('tree_oak', { variant: { key: 'tree', rim: 0.28, wind: 0.02, windAnchor: 1.2 } }),
  entry('tree_stump'),
  entry('bush', { castShadow: false, variant: { key: 'bush', rim: 0.26, wind: 0.05, windAnchor: 0 } }),
  entry('flower_patch', {
    castShadow: false,
    variant: { key: 'grass', rim: 0.3, wind: 0.09, windAnchor: 0 },
  }),
  entry('rock', { castShadow: false }),
  entry('rock_cluster'),
  entry('log'),
  entry('mushroom', { castShadow: false }),
  entry('cattail', { castShadow: false, variant: { key: 'grass', rim: 0.3, wind: 0.09, windAnchor: 0 } }),
  entry('sunflower', { castShadow: false, variant: { key: 'bush', rim: 0.26, wind: 0.05, windAnchor: 0 } }),
  entry('cloud', { castShadow: false, receiveShadow: false }),

  // animals
  entry('cow'),
  entry('chicken'),
  entry('cat'),
  entry('crow'),

  // treasures
  entry('needle_golden', { castShadow: false }),
  entry('ufo', { castShadow: false }),
  entry('coin', { castShadow: false }),
  entry('gem', { castShadow: false }),
  entry('horseshoe', { castShadow: false }),
  entry('pocket_watch', { castShadow: false }),
  entry('arrowhead', { castShadow: false }),
  entry('bone', { castShadow: false }),
  entry('ring', { castShadow: false }),
  entry('chest', { castShadow: false }),
  entry('chest_lid', { castShadow: false }),
  entry('key', { castShadow: false }),
  entry('gnome', { castShadow: false }),
];

export const ALL_ASSETS: readonly AssetManifestEntry[] = [...CRITICAL_ASSETS, ...DEFERRED_ASSETS];
