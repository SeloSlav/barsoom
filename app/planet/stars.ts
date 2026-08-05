import * as THREE from "three";

export type StarCatalogue = {
  count: number;
  directions: Float32Array;
  colours: Float32Array;
  magnitudes: Float32Array;
  hipIds: Uint32Array;
};

function colourIndexToRgb(colourIndex: number) {
  const bv = Math.max(-0.4, Math.min(2, colourIndex));
  let temperature = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  temperature = Math.max(2000, Math.min(40_000, temperature)) / 100;
  let red: number;
  let green: number;
  let blue: number;
  if (temperature <= 66) {
    red = 255;
    green = 99.4708025861 * Math.log(temperature) - 161.1195681661;
    blue = temperature <= 19 ? 0 : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  } else {
    red = 329.698727446 * (temperature - 60) ** -0.1332047592;
    green = 288.1221695283 * (temperature - 60) ** -0.0755148492;
    blue = 255;
  }
  return [red, green, blue].map((value) => Math.max(0, Math.min(255, value)) / 255);
}

export async function loadStarCatalogue(): Promise<StarCatalogue> {
  const response = await fetch("/data/stars/hipparcos-bright.bin", { cache: "force-cache" });
  if (!response.ok) throw new Error(`Star catalogue request failed (${response.status})`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "STAR") throw new Error("Star catalogue magic is invalid");
  const view = new DataView(buffer);
  const version = view.getUint16(4, true);
  const recordBytes = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  if (version !== 1 || recordBytes !== 16 || buffer.byteLength !== 12 + count * recordBytes) {
    throw new Error("Star catalogue header is invalid");
  }
  const directions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const magnitudes = new Float32Array(count);
  const hipIds = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * recordBytes;
    const ra = THREE.MathUtils.degToRad(view.getFloat32(offset, true));
    const dec = THREE.MathUtils.degToRad(view.getFloat32(offset + 4, true));
    const magnitude = view.getInt16(offset + 8, true) / 100;
    const colourIndex = view.getInt16(offset + 10, true) / 1000;
    const cosDec = Math.cos(dec);
    directions[index * 3] = cosDec * Math.cos(ra);
    directions[index * 3 + 1] = cosDec * Math.sin(ra);
    directions[index * 3 + 2] = Math.sin(dec);
    const colour = colourIndexToRgb(colourIndex);
    colours[index * 3] = colour[0];
    colours[index * 3 + 1] = colour[1];
    colours[index * 3 + 2] = colour[2];
    magnitudes[index] = magnitude;
    hipIds[index] = view.getUint32(offset + 12, true);
  }
  return { count, directions, colours, magnitudes, hipIds };
}

