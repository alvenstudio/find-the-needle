import {
  AnimationClip,
  Box3,
  BufferGeometry,
  Mesh,
  Object3D,
  Sphere,
  Vector3,
  type Material,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import { familyFromName, MaterialLibrary } from './Materials';
import { Signal } from './Signals';

export interface LoadedModel {
  readonly name: string;
  /** The template. Never added to the scene directly - clone it instead. */
  readonly root: Object3D;
  readonly clips: readonly AnimationClip[];
  /** Local-space bounds, precomputed once. */
  readonly bounds: Box3;
  readonly size: Vector3;
  readonly boundingSphere: Sphere;
  /**
   * The merged geometry, if the model turned out to be a single mesh. Present
   * for everything we want to draw with an `InstancedMesh`.
   */
  readonly geometry: BufferGeometry | null;
  readonly material: Material | null;
  readonly skinned: boolean;
  readonly triangles: number;
}

export interface AssetManifestEntry {
  name: string;
  url: string;
  /** Cast shadows when instantiated. Off for tiny scatter and viewmodels. */
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Override the surface variant, e.g. give foliage its own wind amount. */
  variant?: { key: string; rim?: number; wind?: number; windAnchor?: number };
}

export interface LoadProgress {
  loaded: number;
  total: number;
  fraction: number;
  current: string;
}

/**
 * Loads the model library and normalises it for the renderer.
 *
 * Blender hands us one material per surface family per file; this swaps every
 * one of them for the shared instance from `MaterialLibrary` so the whole world
 * draws with a handful of programs, and it precomputes bounds so nothing has to
 * walk geometry at spawn time.
 */
export class Assets {
  readonly progress = new Signal<LoadProgress>();

  private readonly loader = new GLTFLoader();
  private readonly models = new Map<string, LoadedModel>();

  constructor(private readonly materials: MaterialLibrary) {}

  async loadAll(manifest: readonly AssetManifestEntry[]): Promise<void> {
    let loaded = 0;
    const total = manifest.length;
    const report = (current: string) => {
      this.progress.emit({ loaded, total, fraction: total === 0 ? 1 : loaded / total, current });
    };
    report('');

    // Six at a time keeps the network pipe full without starving the main
    // thread of the parse work that follows each response.
    const queue = [...manifest];
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const entry = queue.shift();
        if (!entry) return;
        try {
          this.models.set(entry.name, await this.loadOne(entry));
        } catch (error) {
          console.error(`[assets] failed to load ${entry.name} (${entry.url})`, error);
        }
        loaded++;
        report(entry.name);
      }
    });
    await Promise.all(workers);
  }

  private async loadOne(entry: AssetManifestEntry): Promise<LoadedModel> {
    const gltf = await this.loader.loadAsync(entry.url);
    const root = gltf.scene;
    root.name = entry.name;

    let triangles = 0;
    let skinned = false;
    const meshes: Mesh[] = [];

    root.traverse((node) => {
      if (!(node as Mesh).isMesh) return;
      const mesh = node as Mesh;
      meshes.push(mesh);
      mesh.castShadow = entry.castShadow ?? true;
      mesh.receiveShadow = entry.receiveShadow ?? true;
      if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) skinned = true;

      const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const replaced = source.map((material) => this.resolveMaterial(material, entry));
      mesh.material = replaced.length === 1 ? replaced[0] : replaced;

      const geometry = mesh.geometry;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const index = geometry.getIndex();
      triangles += (index ? index.count : geometry.getAttribute('position').count) / 3;
    });

    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    const size = bounds.getSize(new Vector3());
    const boundingSphere = bounds.getBoundingSphere(new Sphere());

    const single = meshes.length === 1 && !skinned ? meshes[0] : null;

    return {
      name: entry.name,
      root,
      clips: gltf.animations ?? [],
      bounds,
      size,
      boundingSphere,
      geometry: single ? single.geometry : null,
      material: single ? (Array.isArray(single.material) ? single.material[0] : single.material) : null,
      skinned,
      triangles: Math.round(triangles),
    };
  }

  private resolveMaterial(material: Material, entry: AssetManifestEntry): Material {
    const family = familyFromName(material.name ?? '');
    if (entry.variant) {
      const { key, ...options } = entry.variant;
      return this.materials.variant(family, key, options);
    }
    return this.materials.get(family);
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  model(name: string): LoadedModel {
    const model = this.models.get(name);
    if (!model) throw new Error(`[assets] model "${name}" was never loaded`);
    return model;
  }

  /** Optional lookup for props that are allowed to be absent. */
  tryModel(name: string): LoadedModel | null {
    return this.models.get(name) ?? null;
  }

  /**
   * A fresh instance ready to add to the scene. Skinned models go through
   * SkeletonUtils so each copy gets its own bone hierarchy; everything else
   * uses the cheap shallow clone, which shares geometry and materials.
   */
  instantiate(name: string): Object3D {
    const model = this.model(name);
    const copy = model.skinned ? cloneSkinned(model.root) : model.root.clone(true);
    copy.name = name;
    return copy;
  }

  /** Geometry for an `InstancedMesh`. Throws for multi-mesh models. */
  geometryOf(name: string): BufferGeometry {
    const model = this.model(name);
    if (!model.geometry) {
      throw new Error(`[assets] "${name}" is not a single mesh and cannot be instanced directly`);
    }
    return model.geometry;
  }

  materialOf(name: string): Material {
    const model = this.model(name);
    if (!model.material) throw new Error(`[assets] "${name}" has no single material`);
    return model.material;
  }

  clip(name: string, clipName: string): AnimationClip | null {
    return this.model(name).clips.find((clip) => clip.name === clipName) ?? null;
  }

  /** Total triangles in the loaded library - printed by the debug overlay. */
  get triangleCount(): number {
    let total = 0;
    for (const model of this.models.values()) total += model.triangles;
    return total;
  }

  get names(): string[] {
    return [...this.models.keys()];
  }

  dispose(): void {
    for (const model of this.models.values()) {
      model.root.traverse((node) => {
        const mesh = node as Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
    }
    this.models.clear();
  }
}
