// Scene-linear image encoders for HDRI export. Input: RGBA float32, row-major, top row first.

import { toHalf } from './half';

/** Radiance .hdr (RGBE), flat scanlines. Readable by every HDR tool. */
export function encodeRadianceHDR(width: number, height: number, rgba: Float32Array): Uint8Array {
  const header = new TextEncoder().encode(
    `#?RADIANCE\n# skyCaptain environment, scene-linear\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
  );
  const out = new Uint8Array(header.length + width * height * 4);
  out.set(header);
  let o = header.length;
  for (let i = 0; i < width * height; i++) {
    const r = Math.max(0, rgba[i * 4]);
    const g = Math.max(0, rgba[i * 4 + 1]);
    const b = Math.max(0, rgba[i * 4 + 2]);
    const m = Math.max(r, g, b);
    if (!(m >= 1e-32) || !Number.isFinite(m)) {
      o += 4;
      continue;
    }
    const e = Math.ceil(Math.log2(m) + 1e-9);
    const scale = 256 / 2 ** e;
    out[o] = Math.min(255, Math.floor(r * scale));
    out[o + 1] = Math.min(255, Math.floor(g * scale));
    out[o + 2] = Math.min(255, Math.floor(b * scale));
    out[o + 3] = e + 128;
    o += 4;
  }
  return out;
}

const HALF_MAX = 65504;

/**
 * OpenEXR 2.0, single-part scanline, no compression, B, G, R channels. Half float when every
 * value fits; otherwise 32-bit float, because a sun core easily exceeds the half range and
 * clamping it would throw away the light that matters most for IBL.
 */
export function encodeOpenEXR(width: number, height: number, rgba: Float32Array): { bytes: Uint8Array; pixelType: 'half' | 'float' } {
  let fitsHalf = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] > HALF_MAX || rgba[i + 1] > HALF_MAX || rgba[i + 2] > HALF_MAX) { fitsHalf = false; break; }
  }
  const pixelType = fitsHalf ? 'half' : 'float';
  const sampleBytes = fitsHalf ? 2 : 4;
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 0xff);
  const u32 = (v: number) => { u8(v); u8(v >>> 8); u8(v >>> 16); u8(v >>> 24); };
  const i32 = u32;
  const f32 = (v: number) => {
    const b = new Uint8Array(new Float32Array([v]).buffer);
    bytes.push(...b);
  };
  const str = (s: string) => { for (const c of s) u8(c.charCodeAt(0)); u8(0); };
  const attr = (name: string, type: string, size: number, write: () => void) => {
    str(name); str(type); u32(size); write();
  };

  u32(20000630); // magic
  u32(2); // version 2, single-part scanline
  // Channels must be listed in alphabetical order.
  attr('channels', 'chlist', 3 * (2 + 16) + 1, () => {
    for (const c of ['B', 'G', 'R']) {
      str(c);
      i32(fitsHalf ? 1 : 2); // HALF or FLOAT
      u8(0); u8(0); u8(0); u8(0); // pLinear + reserved
      i32(1); i32(1); // x/y sampling
    }
    u8(0);
  });
  attr('compression', 'compression', 1, () => u8(0));
  attr('dataWindow', 'box2i', 16, () => { i32(0); i32(0); i32(width - 1); i32(height - 1); });
  attr('displayWindow', 'box2i', 16, () => { i32(0); i32(0); i32(width - 1); i32(height - 1); });
  attr('lineOrder', 'lineOrder', 1, () => u8(0));
  attr('pixelAspectRatio', 'float', 4, () => f32(1));
  attr('screenWindowCenter', 'v2f', 8, () => { f32(0); f32(0); });
  attr('screenWindowWidth', 'float', 4, () => f32(1));
  u8(0); // end of header

  const headerBytes = Uint8Array.from(bytes);
  const lineBytes = width * 3 * sampleBytes;
  const blockSize = 8 + lineBytes;
  const tableSize = height * 8;
  const out = new Uint8Array(headerBytes.length + tableSize + height * blockSize);
  out.set(headerBytes);
  const view = new DataView(out.buffer);
  let offset = headerBytes.length + tableSize;
  for (let y = 0; y < height; y++) {
    view.setBigUint64(headerBytes.length + y * 8, BigInt(offset), true);
    view.setInt32(offset, y, true);
    view.setInt32(offset + 4, lineBytes, true);
    let p = offset + 8;
    for (const c of [2, 1, 0]) { // B, G, R
      for (let x = 0; x < width; x++) {
        const v = rgba[(y * width + x) * 4 + c];
        if (fitsHalf) view.setUint16(p, toHalf(v), true); else view.setFloat32(p, v, true);
        p += sampleBytes;
      }
    }
    offset += blockSize;
  }
  return { bytes: out, pixelType };
}
