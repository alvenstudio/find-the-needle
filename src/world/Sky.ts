import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';

import { clamp01 } from '../core/MathX';

/**
 * The sky.
 *
 * A single inverted sphere with a hand-written shader: a three-stop vertical
 * gradient, a sun disc with a wide soft halo, and clouds raymarched-lite by
 * projecting the view direction onto a horizontal plane and running two octaves
 * of value noise across it. That last trick is what makes the clouds drift with
 * real perspective - they bunch toward the horizon exactly as a flat cloud
 * layer should - for the cost of about a dozen instructions per pixel.
 *
 * The dome is drawn *last*, with depth testing on and depth writes off, and its
 * vertex shader pins every vertex to the far plane. That combination means it
 * fills exactly the pixels nothing else reached and shades nothing that is
 * about to be painted over - the opposite of the intuitive "draw the background
 * first" arrangement, which both wastes fragments and, with depth testing
 * disabled, paints over the entire world.
 */

export type SkyMood = 'noon' | 'golden' | 'overcast' | 'storm' | 'night' | 'dawn';

export interface SkyPreset {
  zenith: string;
  horizon: string;
  haze: string;
  sun: string;
  /** Degrees above the horizon. */
  sunElevation: number;
  /** Degrees clockwise from -Z. */
  sunAzimuth: number;
  sunSize: number;
  sunIntensity: number;
  ambientSky: string;
  ambientGround: string;
  ambientIntensity: number;
  fog: string;
  fogDensity: number;
  cloudColor: string;
  /** 0 = clear, 1 = solid overcast. */
  cloudCover: number;
  cloudSpeed: number;
  /** Renderer exposure and bloom strength for this mood. */
  exposure: number;
  bloom: number;
  /** Strength of the shared wind uniform, which drives all foliage sway. */
  wind: number;
}

export const SKY_PRESETS: Readonly<Record<SkyMood, SkyPreset>> = {
  noon: {
    zenith: '#3f9fe0',
    horizon: '#b8e4fb',
    haze: '#e8f6ff',
    sun: '#fff6d8',
    sunElevation: 58,
    sunAzimuth: 38,
    sunSize: 0.028,
    sunIntensity: 3.0,
    ambientSky: '#bfe3ff',
    ambientGround: '#7e9a54',
    ambientIntensity: 1.15,
    fog: '#d8ecf8',
    fogDensity: 0.0042,
    cloudColor: '#ffffff',
    cloudCover: 0.34,
    cloudSpeed: 0.006,
    exposure: 1.02,
    bloom: 0.2,
    wind: 1,
  },
  golden: {
    zenith: '#2f6fb4',
    horizon: '#ffbf7a',
    haze: '#ffd9a3',
    sun: '#ffd98a',
    sunElevation: 11,
    sunAzimuth: 200,
    sunSize: 0.05,
    sunIntensity: 2.5,
    ambientSky: '#ffcf9c',
    ambientGround: '#8a6a3a',
    ambientIntensity: 1.05,
    fog: '#ffcb92',
    fogDensity: 0.0072,
    cloudColor: '#ffd9b0',
    cloudCover: 0.42,
    cloudSpeed: 0.005,
    exposure: 1.08,
    bloom: 0.34,
    wind: 0.85,
  },
  overcast: {
    zenith: '#8fa4b4',
    horizon: '#cdd8e0',
    haze: '#dee6ec',
    sun: '#e8eef2',
    sunElevation: 42,
    sunAzimuth: 120,
    sunSize: 0.09,
    sunIntensity: 1.35,
    ambientSky: '#c8d6e0',
    ambientGround: '#6f7a63',
    ambientIntensity: 1.3,
    fog: '#c9d6df',
    fogDensity: 0.0095,
    cloudColor: '#eef3f7',
    cloudCover: 0.86,
    cloudSpeed: 0.012,
    exposure: 1.0,
    bloom: 0.12,
    wind: 1.4,
  },
  storm: {
    zenith: '#31394a',
    horizon: '#6d7688',
    haze: '#8b93a2',
    sun: '#b9c4d2',
    sunElevation: 28,
    sunAzimuth: 300,
    sunSize: 0.1,
    sunIntensity: 0.95,
    ambientSky: '#7d8798',
    ambientGround: '#454b41',
    ambientIntensity: 1.1,
    fog: '#77808f',
    fogDensity: 0.016,
    cloudColor: '#9aa3b2',
    cloudCover: 0.95,
    cloudSpeed: 0.03,
    exposure: 1.06,
    bloom: 0.2,
    wind: 2.4,
  },
  night: {
    zenith: '#0b1430',
    horizon: '#2b3f66',
    haze: '#3d558a',
    sun: '#dfe8ff',
    sunElevation: 46,
    sunAzimuth: 250,
    sunSize: 0.022,
    sunIntensity: 0.62,
    ambientSky: '#3a4f80',
    ambientGround: '#1d2436',
    ambientIntensity: 0.85,
    fog: '#22304f',
    fogDensity: 0.011,
    cloudColor: '#54689a',
    cloudCover: 0.3,
    cloudSpeed: 0.004,
    exposure: 1.24,
    bloom: 0.5,
    wind: 0.6,
  },
  dawn: {
    zenith: '#2a5f9e',
    horizon: '#ffc9c0',
    haze: '#ffe0cf',
    sun: '#fff0d0',
    sunElevation: 7,
    sunAzimuth: 20,
    sunSize: 0.045,
    sunIntensity: 2.1,
    ambientSky: '#ffd2c4',
    ambientGround: '#7c6a55',
    ambientIntensity: 1.0,
    fog: '#ffd6c4',
    fogDensity: 0.0085,
    cloudColor: '#ffd7cd',
    cloudCover: 0.4,
    cloudSpeed: 0.005,
    exposure: 1.05,
    bloom: 0.32,
    wind: 0.7,
  },
};

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDirection;
void main() {
  vDirection = position;
  // Keep the dome centred on the camera and pinned to the far plane.
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform vec3 uCloudColor;
uniform float uSunSize;
uniform float uCloudCover;
uniform float uCloudSpeed;
uniform float uTime;

varying vec3 vDirection;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    total += valueNoise(p) * amplitude;
    p = p * 2.07 + 13.7;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec3 dir = normalize(vDirection);
  float height = clamp(dir.y, -1.0, 1.0);

  // Three-stop gradient: a bright hazy band hugs the horizon, then the sky
  // deepens toward the zenith. pow() shapes where the transition sits.
  float horizonMix = pow(clamp(1.0 - abs(height), 0.0, 1.0), 3.4);
  float zenithMix = pow(clamp(height, 0.0, 1.0), 0.62);
  vec3 sky = mix(uHorizon, uZenith, zenithMix);
  sky = mix(sky, uHaze, horizonMix * 0.85);

  // Sun disc plus a wide, soft bloom halo.
  float sunDot = clamp(dot(dir, uSunDirection), 0.0, 1.0);
  float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, sunDot);
  float halo = pow(sunDot, 26.0) * 0.55 + pow(sunDot, 4.0) * 0.14;
  sky += uSunColor * (disc * 2.2 + halo);

  // Clouds live on a plane above the camera; projecting the view direction onto
  // it gives correct perspective foreshortening toward the horizon.
  if (dir.y > 0.015) {
    vec2 plane = dir.xz / dir.y * 0.55 + vec2(uTime * uCloudSpeed, uTime * uCloudSpeed * 0.4);
    float density = fbm(plane * 0.9);
    density += fbm(plane * 2.6 + 7.3) * 0.35;
    float threshold = mix(1.15, 0.28, uCloudCover);
    float mask = smoothstep(threshold, threshold + 0.34, density);
    // Fade clouds out at the horizon so the plane's edge never shows.
    mask *= smoothstep(0.015, 0.24, dir.y);
    // A cheap two-tone shade: denser cores read darker underneath.
    vec3 lit = mix(uCloudColor * 0.72, uCloudColor, smoothstep(threshold, threshold + 0.6, density));
    lit += uSunColor * pow(sunDot, 8.0) * 0.35;
    sky = mix(sky, lit, mask * 0.94);
  }

  gl_FragColor = vec4(sky, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly sunDirection = new Vector3();

  constructor() {
    const geometry = new SphereGeometry(1, 24, 16);
    this.material = new ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      uniforms: {
        uZenith: { value: new Color() },
        uHorizon: { value: new Color() },
        uHaze: { value: new Color() },
        uSunColor: { value: new Color() },
        uSunDirection: { value: new Vector3(0, 1, 0) },
        uCloudColor: { value: new Color() },
        uSunSize: { value: 0.03 },
        uCloudCover: { value: 0.35 },
        uCloudSpeed: { value: 0.006 },
        uTime: { value: 0 },
      },
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
    this.mesh.matrixAutoUpdate = false;
  }

  /** World-space direction *toward* the sun, for the directional light. */
  get sunVector(): Vector3 {
    return this.sunDirection;
  }

  addTo(scene: Scene): void {
    scene.add(this.mesh);
  }

  apply(preset: SkyPreset): void {
    const uniforms = this.material.uniforms;
    (uniforms.uZenith.value as Color).set(preset.zenith);
    (uniforms.uHorizon.value as Color).set(preset.horizon);
    (uniforms.uHaze.value as Color).set(preset.haze);
    (uniforms.uSunColor.value as Color).set(preset.sun);
    (uniforms.uCloudColor.value as Color).set(preset.cloudColor);
    uniforms.uSunSize.value = preset.sunSize;
    uniforms.uCloudCover.value = clamp01(preset.cloudCover);
    uniforms.uCloudSpeed.value = preset.cloudSpeed;

    const elevation = (preset.sunElevation * Math.PI) / 180;
    const azimuth = (preset.sunAzimuth * Math.PI) / 180;
    this.sunDirection
      .set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation))
      .normalize();
    (uniforms.uSunDirection.value as Vector3).copy(this.sunDirection);
  }

  /**
   * Blend between two presets. Used for the fade when a tier changes, so the
   * player never gets a hard cut from noon to midnight.
   */
  static blend(from: SkyPreset, to: SkyPreset, t: number, out: SkyPreset): SkyPreset {
    const mixColor = (a: string, b: string): string =>
      `#${new Color(a).lerp(new Color(b), t).getHexString()}`;
    const mixNumber = (a: number, b: number): number => a + (b - a) * t;

    out.zenith = mixColor(from.zenith, to.zenith);
    out.horizon = mixColor(from.horizon, to.horizon);
    out.haze = mixColor(from.haze, to.haze);
    out.sun = mixColor(from.sun, to.sun);
    out.ambientSky = mixColor(from.ambientSky, to.ambientSky);
    out.ambientGround = mixColor(from.ambientGround, to.ambientGround);
    out.fog = mixColor(from.fog, to.fog);
    out.cloudColor = mixColor(from.cloudColor, to.cloudColor);
    out.sunElevation = mixNumber(from.sunElevation, to.sunElevation);
    out.sunAzimuth = mixNumber(from.sunAzimuth, to.sunAzimuth);
    out.sunSize = mixNumber(from.sunSize, to.sunSize);
    out.sunIntensity = mixNumber(from.sunIntensity, to.sunIntensity);
    out.ambientIntensity = mixNumber(from.ambientIntensity, to.ambientIntensity);
    out.fogDensity = mixNumber(from.fogDensity, to.fogDensity);
    out.cloudCover = mixNumber(from.cloudCover, to.cloudCover);
    out.cloudSpeed = mixNumber(from.cloudSpeed, to.cloudSpeed);
    out.exposure = mixNumber(from.exposure, to.exposure);
    out.bloom = mixNumber(from.bloom, to.bloom);
    out.wind = mixNumber(from.wind, to.wind);
    return out;
  }

  update(elapsed: number, camera: PerspectiveCamera): void {
    this.material.uniforms.uTime.value = elapsed;
    // The dome rides with the camera; scale is irrelevant because the vertex
    // shader pins it to the far plane, but keeping it modest avoids precision
    // trouble in the matrix.
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.5);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** A mutable preset used as the blend target, so blending allocates nothing. */
export function cloneSkyPreset(preset: SkyPreset): SkyPreset {
  return { ...preset };
}
