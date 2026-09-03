import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  Vector2,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/**
 * The game's shading language.
 *
 * Every mesh in the project is authored in Blender with a per-corner colour
 * attribute and one of five surface families, so at runtime the entire world
 * runs on a handful of shared materials. That keeps GPU state changes near zero
 * and means a single tweak here restyles the whole game.
 *
 * On top of `MeshStandardMaterial` we patch in three stylised extras the
 * standard shader has no notion of:
 *
 *   * a **rim light**, which traces the silhouette of every prop in warm sky
 *     colour and is what makes chunky low-poly read as "toy" rather than "flat";
 *   * a **wind sway**, a cheap two-frequency displacement masked by the vertex's
 *     height *in object space*, so grass, leaves and straw breathe together and
 *     stay rooted wherever they are placed;
 *   * **emissive from vertex colour**, because glTF vertex colours only reach
 *     the diffuse term and our glowing props carry their colour the same way
 *     everything else does.
 */

/**
 * A note on colour, because getting this wrong is invisible until it is not.
 *
 * three.js has colour management on by default since r152: `new Color('#6fbf3f')`
 * already converts from sRGB into the linear working space. Calling
 * `convertSRGBToLinear()` on top of that squares the value, which darkens and
 * over-saturates everything by a factor that looks almost plausible - grass
 * goes from a bright field green to a swampy near-black. Every colour in this
 * project is authored as an sRGB hex string and handed straight to `Color`.
 */
export type SurfaceFamily = 'Prop' | 'Metal' | 'Foliage' | 'Glass' | 'Emit';

export interface SharedUniforms {
  uTime: IUniform<number>;
  uWindStrength: IUniform<number>;
  uWindDirection: IUniform<Vector2>;
  uRimColor: IUniform<Color>;
}

export interface StylizedOptions {
  /** Strength of the silhouette rim term. 0 disables the patch entirely. */
  rim?: number;
  /** Lateral displacement in metres at one metre above the anchor. */
  wind?: number;
  /** Object-space height below which wind sway is zero. */
  windAnchor?: number;
  /** Drive the emissive term from the vertex colour attribute. */
  emissiveFromColor?: boolean;
  /** Extra shader surgery applied after the standard patches. */
  extend?: (shader: WebGLProgramParametersWithUniforms) => void;
  /** Appended to the program cache key; required whenever `extend` is used. */
  cacheKey?: string;
}

const RIM_FRAGMENT_PARS = /* glsl */ `
uniform vec3 uRimColor;
uniform float uRimStrength;
varying vec3 vStylizedNormal;
varying vec3 vStylizedView;
`;

const RIM_VERTEX_PARS = /* glsl */ `
varying vec3 vStylizedNormal;
varying vec3 vStylizedView;
`;

const WIND_VERTEX_PARS = /* glsl */ `
uniform float uTime;
uniform float uWindStrength;
uniform vec2 uWindDirection;
uniform float uWindAmount;
uniform float uWindAnchor;
`;

/**
 * Displacement is computed in world space and folded into the already-projected
 * view position, which keeps it correct for instanced meshes and for props with
 * arbitrary rotation without paying for a matrix inverse per vertex.
 */
const WIND_VERTEX_BODY = /* glsl */ `
{
  #ifdef USE_INSTANCING
    vec3 ftnWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vec3 ftnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  float ftnHeight = max(transformed.y - uWindAnchor, 0.0);
  float ftnMask = ftnHeight * ftnHeight * uWindAmount * uWindStrength;
  float ftnPhase = ftnWorld.x * 0.34 + ftnWorld.z * 0.27;
  float ftnSway = sin(uTime * 1.7 + ftnPhase) * 0.7 + sin(uTime * 3.9 + ftnPhase * 2.3) * 0.3;
  vec3 ftnOffset = vec3(uWindDirection.x, 0.0, uWindDirection.y) * ftnSway * ftnMask;
  mvPosition.xyz += mat3(viewMatrix) * ftnOffset;
  gl_Position = projectionMatrix * mvPosition;
}
`;

let sharedUniforms: SharedUniforms | null = null;

export function getSharedUniforms(): SharedUniforms {
  if (!sharedUniforms) {
    sharedUniforms = {
      uTime: { value: 0 },
      uWindStrength: { value: 1 },
      uWindDirection: { value: new Vector2(0.82, 0.57) },
      uRimColor: { value: new Color('#ffe6bd') },
    };
  }
  return sharedUniforms;
}

export function advanceSharedUniforms(elapsed: number, windStrength: number): void {
  const uniforms = getSharedUniforms();
  uniforms.uTime.value = elapsed;
  uniforms.uWindStrength.value = windStrength;
}

/** Patch a material with the stylised extras. Returns the same instance. */
export function stylize<T extends Material>(material: T, options: StylizedOptions = {}): T {
  const rim = options.rim ?? 0.34;
  const wind = options.wind ?? 0;
  const windAnchor = options.windAnchor ?? 0;
  const emissiveFromColor = options.emissiveFromColor ?? false;
  const shared = getSharedUniforms();

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    if (wind > 0) {
      shader.uniforms.uTime = shared.uTime;
      shader.uniforms.uWindStrength = shared.uWindStrength;
      shader.uniforms.uWindDirection = shared.uWindDirection;
      shader.uniforms.uWindAmount = { value: wind };
      shader.uniforms.uWindAnchor = { value: windAnchor };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WIND_VERTEX_PARS}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${WIND_VERTEX_BODY}`);
    }

    if (rim > 0) {
      shader.uniforms.uRimColor = shared.uRimColor;
      shader.uniforms.uRimStrength = { value: rim };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${RIM_VERTEX_PARS}`)
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>
  vStylizedNormal = normalize(normalMatrix * objectNormal);
  vStylizedView = normalize(-mvPosition.xyz);`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${RIM_FRAGMENT_PARS}`)
        .replace(
          '#include <dithering_fragment>',
          `float ftnRim = 1.0 - clamp(dot(normalize(vStylizedNormal), normalize(vStylizedView)), 0.0, 1.0);
  ftnRim = pow(ftnRim, 3.2) * uRimStrength;
  gl_FragColor.rgb += uRimColor * ftnRim * gl_FragColor.a;
  #include <dithering_fragment>`,
        );
    }

    if (emissiveFromColor) {
      // `color_fragment` has already folded vColor into diffuseColor, so the
      // attribute is available here and carries the authored glow colour.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
    // vColor is a vec4 when the geometry carries alpha, so swizzle rather than
    // assigning it whole - the shader will not compile otherwise.
    totalEmissiveRadiance *= vColor.rgb;
  #endif`,
      );
    }

    options.extend?.(shader);
  };

  material.customProgramCacheKey = () =>
    `ftn|r${rim.toFixed(2)}|w${wind.toFixed(2)}|a${windAnchor.toFixed(2)}|e${emissiveFromColor ? 1 : 0}` +
    (options.cacheKey ? `|${options.cacheKey}` : '');
  material.needsUpdate = true;
  return material;
}

const FAMILY_DEFAULTS: Record<SurfaceFamily, StylizedOptions> = {
  Prop: { rim: 0.34 },
  Metal: { rim: 0.6 },
  Foliage: { rim: 0.26, wind: 0.05 },
  Glass: { rim: 1.1 },
  Emit: { rim: 0, emissiveFromColor: true },
};

export class MaterialLibrary {
  private readonly cache = new Map<string, MeshStandardMaterial>();

  get(family: SurfaceFamily): MeshStandardMaterial {
    return this.variant(family, 'default', FAMILY_DEFAULTS[family]);
  }

  /**
   * A named variant of a family, cached separately so a swaying bush and a
   * static crate never share one compiled program.
   */
  variant(family: SurfaceFamily, key: string, options: StylizedOptions): MeshStandardMaterial {
    const id = `${family}:${key}`;
    const existing = this.cache.get(id);
    if (existing) return existing;
    const material = this.create(family, options);
    material.name = `FTN_${id}`;
    this.cache.set(id, material);
    return material;
  }

  private create(family: SurfaceFamily, options: StylizedOptions): MeshStandardMaterial {
    const material = new MeshStandardMaterial({ vertexColors: true });
    switch (family) {
      case 'Metal':
        material.metalness = 0.88;
        material.roughness = 0.3;
        material.envMapIntensity = 1.2;
        break;
      case 'Foliage':
        material.roughness = 0.93;
        material.metalness = 0;
        material.side = DoubleSide;
        break;
      case 'Glass':
        material.roughness = 0.05;
        material.metalness = 0.05;
        material.transparent = true;
        material.opacity = 0.4;
        material.depthWrite = false;
        material.envMapIntensity = 1.8;
        break;
      case 'Emit':
        material.roughness = 0.5;
        material.metalness = 0;
        material.emissive = new Color(0xffffff);
        material.emissiveIntensity = 1.3;
        break;
      case 'Prop':
      default:
        material.roughness = 0.86;
        material.metalness = 0;
        break;
    }
    return stylize(material, options);
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}

const KNOWN_FAMILIES: ReadonlySet<string> = new Set(['Prop', 'Metal', 'Foliage', 'Glass', 'Emit']);

/** Map a Blender material name (`FTN_Prop`, ...) onto a surface family. */
export function familyFromName(name: string): SurfaceFamily {
  const suffix = name.replace(/^FTN_/, '');
  return KNOWN_FAMILIES.has(suffix) ? (suffix as SurfaceFamily) : 'Prop';
}
