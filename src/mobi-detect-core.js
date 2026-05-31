// mobi-detect-core.js – detects MOBI file format from an ArrayBuffer.
// Returns { format: 'kf8'|'palmdoc'|'unknown', drm: boolean, compressionCode: number }
//
// Detection logic based on PalmDB header:
//   firstRecOffset  = dv.getUint32(78)
//   compression     = dv.getUint16(firstRecOffset + 0)
//   encryption      = dv.getUint16(firstRecOffset + 12)
//   compression 2     → PalmDoc LZ77 (Mobi7)
//   compression 17480 → HUFF/CDIC (KF8)
//   encryption != 0   → DRM-protected

function detectMobiFormat(buffer) {
  if (!buffer || buffer.byteLength < 100) {
    return { format: 'unknown', drm: false, compressionCode: 0 };
  }
  try {
    const dv = new DataView(buffer);
    const firstRecOffset = dv.getUint32(78);
    if (firstRecOffset + 14 > buffer.byteLength) {
      return { format: 'unknown', drm: false, compressionCode: 0 };
    }
    const compression = dv.getUint16(firstRecOffset);
    const encryption  = dv.getUint16(firstRecOffset + 12);
    const drm = encryption !== 0;
    let format;
    if      (compression === 17480) format = 'kf8';
    else if (compression === 2)     format = 'palmdoc';
    else if (compression === 1)     format = 'palmdoc'; // no compression, still PalmDoc-style
    else                            format = 'unknown';
    return { format, drm, compressionCode: compression };
  } catch (e) {
    return { format: 'unknown', drm: false, compressionCode: 0 };
  }
}

