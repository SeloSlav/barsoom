import * as THREE from "three";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const finishingShader = {
  name: "Barsoom HDR finishing pass",
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
    uAspect: { value: 1 },
    uSharpen: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform vec2 uTexelSize;
    uniform float uAspect;
    uniform float uSharpen;
    varying vec2 vUv;

    float luminance(vec3 colour) {
      return dot(colour, vec3(0.2126, 0.7152, 0.0722));
    }

    // Jimenez interleaved-gradient noise is inexpensive, stable in screen
    // space, and breaks up the low-contrast bands most visible in the thin
    // atmosphere without introducing a noise texture fetch.
    float interleavedGradientNoise(vec2 pixel) {
      return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec3 colour = texture2D(tDiffuse, vUv).rgb;
      float centreLuminance = luminance(colour);

      // Four extra reads are guarded by a frame-wide uniform branch. The
      // engine enables them only while measured frame-time headroom exists.
      if (uSharpen > 0.001) {
        vec3 neighbours =
          texture2D(tDiffuse, vUv + vec2(uTexelSize.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv - vec2(uTexelSize.x, 0.0)).rgb +
          texture2D(tDiffuse, vUv + vec2(0.0, uTexelSize.y)).rgb +
          texture2D(tDiffuse, vUv - vec2(0.0, uTexelSize.y)).rgb;
        vec3 localAverage = neighbours * 0.25;
        float localDelta = abs(centreLuminance - luminance(localAverage));
        float haloGuard = 1.0 - smoothstep(0.09, 0.34, localDelta);
        float visibleScene = smoothstep(0.002, 0.025, centreLuminance);
        colour = max(colour + (colour - localAverage) * uSharpen * haloGuard * visibleScene, vec3(0.0));
        centreLuminance = luminance(colour);
      }

      // Preserve deep space while opening the planet's low mid-tones. The
      // warm lift is deliberately tiny in linear HDR space; AgX and the sRGB
      // transfer perform the perceptually significant expansion afterwards.
      float visibleScene = smoothstep(0.0025, 0.028, centreLuminance);
      float shadowLift = (1.0 - smoothstep(0.045, 0.26, centreLuminance)) * visibleScene;
      colour += vec3(0.0070, 0.0030, 0.0015) * shadowLift;

      float gradedLuminance = luminance(colour);
      float saturation = mix(1.045, 1.015, smoothstep(0.45, 2.5, gradedLuminance));
      colour = max(mix(vec3(gradedLuminance), colour, saturation), vec3(0.0));

      // The old CSS overlay forced a separate browser-compositor effect. This
      // gentler vignette now lives in the existing HDR finish and never dims
      // the centre of the reconstructed field.
      vec2 centred = vUv * 2.0 - 1.0;
      centred.x *= uAspect;
      float radialEdge = smoothstep(0.62, 1.38, length(centred));
      float verticalEdge = pow(abs(centred.y), 4.0);
      colour *= max(0.78, 1.0 - radialEdge * 0.13 - verticalEdge * 0.07);

      // Dither only visible dark gradients. Keeping true black untouched
      // preserves the clean star field and prevents a grey noisy background.
      float ditherMask = smoothstep(0.002, 0.018, gradedLuminance) *
        (1.0 - smoothstep(0.42, 1.6, gradedLuminance));
      float dither = interleavedGradientNoise(gl_FragCoord.xy) - 0.5;
      colour = max(colour + vec3(dither * (0.42 / 255.0) * ditherMask), vec3(0.0));

      gl_FragColor = vec4(colour, 1.0);
    }
  `,
};

export class MarsFinishingPass extends ShaderPass {
  constructor() {
    super(finishingShader);
    this.material.name = finishingShader.name;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.toneMapped = false;
  }

  setSize(width: number, height: number) {
    this.uniforms.uTexelSize.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.uniforms.uAspect.value = width / Math.max(1, height);
  }

  setSharpenStrength(strength: number) {
    this.uniforms.uSharpen.value = THREE.MathUtils.clamp(strength, 0, 0.2);
  }
}
