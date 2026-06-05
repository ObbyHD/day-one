// Day One Icon-Generator — erzeugt assets/icon.ico + assets/icon.png
// Konzept: dunkle abgerundete Kachel, orange Ring mit Öffnung oben,
// aufgehende Sonne (Punkt) in der Öffnung = "neuer Tag".
// Keine externen Abhängigkeiten (eigener PNG- + ICO-Encoder).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---- CRC32 (für PNG-Chunks) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- PNG-Encoder (RGBA, 8-bit) ----
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// ---- ICO-Encoder (PNG-komprimierte Einträge, Vista+) ----
function encodeICO(images) {
  const n = images.length;
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(n, 4);
  const entries = [];
  let offset = 6 + 16 * n;
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(im.buf.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e); offset += im.buf.length;
  }
  return Buffer.concat([dir, ...entries, ...images.map((im) => im.buf)]);
}

// ---- Zeichnen (Master in hoher Auflösung, dann herunterskalieren = Anti-Aliasing) ----
const lerp = (a, b, t) => a + (b - a) * t;
function angleDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

function renderMaster(S) {
  const buf = Buffer.alloc(S * S * 4);
  const sc = S / 256;
  const cx = S / 2, cy = S / 2;
  const R = 80 * sc;          // Ring-Radius
  const W = 22 * sc;          // Ring-Dicke
  const rr = 58 * sc;         // Eckradius der Kachel
  const topAng = -Math.PI / 2;
  const gapHalf = 33 * Math.PI / 180; // halbe Öffnung (≈66° gesamt)
  const oA = [0xd9, 0x7a, 0x4a], oB = [0xe8, 0x90, 0x66], sun = [0xf3, 0xa9, 0x7b];
  const dotR = W * 0.92, dotX = cx, dotY = cy - R;
  const capAngs = [topAng + gapHalf, topAng - gapHalf];

  function roundRectSDF(x, y) {
    const qx = Math.abs(x - S / 2) - (S / 2 - rr);
    const qy = Math.abs(y - S / 2) - (S / 2 - rr);
    const dx = Math.max(qx, 0), dy = Math.max(qy, 0);
    return Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - rr;
  }
  function ringColor(ang) {
    const start = topAng + gapHalf;
    let tt = (((ang - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    tt = Math.max(0, Math.min(1, tt / (2 * Math.PI - 2 * gapHalf)));
    return [Math.round(lerp(oA[0], oB[0], tt)), Math.round(lerp(oA[1], oB[1], tt)), Math.round(lerp(oA[2], oB[2], tt))];
  }

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (roundRectSDF(x + 0.5, y + 0.5) > 0) { buf[i + 3] = 0; continue; }
      // Hintergrund: warmer dunkler Vertikal-Verlauf
      const t = y / S;
      let col = [Math.round(lerp(0x1b, 0x0c, t)), Math.round(lerp(0x15, 0x0a, t)), Math.round(lerp(0x12, 0x09, t))];

      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx);
      const inBand = Math.abs(d - R) <= W / 2;
      const inGap = Math.abs(angleDiff(ang, topAng)) < gapHalf;
      let inCap = false;
      for (const ca of capAngs) {
        const ccx = cx + R * Math.cos(ca), ccy = cy + R * Math.sin(ca);
        if (Math.hypot(x + 0.5 - ccx, y + 0.5 - ccy) <= W / 2) inCap = true;
      }
      if ((inBand && !inGap) || inCap) col = ringColor(ang);

      // Sonne (Punkt) in der Öffnung + sanfter Schein
      const dd = Math.hypot(x + 0.5 - dotX, y + 0.5 - dotY);
      if (dd <= dotR) col = sun;
      else if (dd <= dotR * 2.1) {
        const g = 1 - (dd - dotR) / (dotR * 1.1);
        col = [Math.round(lerp(col[0], sun[0], g * 0.5)), Math.round(lerp(col[1], sun[1], g * 0.5)), Math.round(lerp(col[2], sun[2], g * 0.45))];
      }

      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
  return buf;
}

function downsample(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, aSum = 0, cnt = 0;
      const x0 = Math.floor(x * fx), x1 = Math.max(Math.floor((x + 1) * fx), x0 + 1);
      const y0 = Math.floor(y * fy), y1 = Math.max(Math.floor((y + 1) * fy), y0 + 1);
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * sw + sx) * 4;
        const al = src[i + 3] / 255;
        r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
        aSum += src[i + 3]; cnt++;
      }
      const ii = (y * dw + x) * 4;
      const alsum = aSum / 255;
      if (alsum > 0) {
        dst[ii] = Math.round(r / alsum); dst[ii + 1] = Math.round(g / alsum); dst[ii + 2] = Math.round(b / alsum);
        dst[ii + 3] = Math.round(aSum / cnt);
      }
    }
  }
  return dst;
}

// ---- Erzeugen ----
const MASTER = 1024;
const master = renderMaster(MASTER);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const assetsDir = path.join(__dirname, "assets");
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

const images = sizes.map((s) => ({ size: s, buf: encodePNG(downsample(master, MASTER, MASTER, s, s), s, s) }));
fs.writeFileSync(path.join(assetsDir, "icon.ico"), encodeICO(images));
fs.writeFileSync(path.join(assetsDir, "icon.png"), images.find((im) => im.size === 256).buf);
console.log("OK: assets/icon.ico (" + sizes.join(",") + ") + assets/icon.png");
