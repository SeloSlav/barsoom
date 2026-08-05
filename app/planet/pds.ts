export type PdsRasterEncoding = {
  sampleType: "MSB_INTEGER" | "LSB_INTEGER";
  sampleBits: 16;
  offset: number;
  scalingFactor: number;
};

export function decodePdsInt16Sample(
  bytes: Uint8Array,
  sampleIndex: number,
  encoding: PdsRasterEncoding,
) {
  const offset = sampleIndex * 2;
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new RangeError("PDS sample index is outside the raster");
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  const raw = view.getInt16(0, encoding.sampleType === "LSB_INTEGER");
  return raw * encoding.scalingFactor + encoding.offset;
}

