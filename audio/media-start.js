// ISO BMFF presentation delay: only leading empty edits on the first sound
// track. AAC priming (non-negative media_time) is already handled by decoding.
export function audioStartSeconds(input) {
  try {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const typeAt = p => String.fromCharCode(...bytes.subarray(p, p + 4));
    if (!['ftyp', 'moov', 'wide', 'free', 'mdat', 'skip', 'uuid', 'pnot', 'styp'].includes(typeAt(4))) return 0;
    const invalid = () => { throw new Error('Invalid BMFF'); };
    const uint64 = p => {
      const n = view.getBigUint64(p);
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
      return Number(n);
    };
    const boxes = (start, end) => {
      const result = [];
      for (let p = start; p < end;) {
        if (end - p < 8) invalid();
        let size = view.getUint32(p), header = 8;
        if (size === 1) {
          if (end - p < 16) invalid();
          size = uint64(p + 8); header = 16;
        } else if (size === 0) size = end - p;
        if (size < header || size > end - p) invalid();
        result.push({ type: typeAt(p + 4), data: p + header, end: p + size });
        p += size;
      }
      return result;
    };
    const children = b => boxes(b.data, b.end);
    const need = (b, n) => { if (b.end - b.data < n) invalid(); };
    const moov = boxes(0, bytes.byteLength).find(b => b.type === 'moov');
    if (!moov) return 0;
    const movie = children(moov), mvhd = movie.find(b => b.type === 'mvhd');
    if (!mvhd) return 0;
    need(mvhd, 4);
    const version = view.getUint8(mvhd.data);
    if (version !== 0 && version !== 1) return 0;
    const scaleAt = version === 1 ? 20 : 12;
    need(mvhd, scaleAt + 4);
    const scale = view.getUint32(mvhd.data + scaleAt);
    if (!scale) return 0;
    for (const trak of movie.filter(b => b.type === 'trak')) {
      const track = children(trak), mdia = track.find(b => b.type === 'mdia');
      if (!mdia) continue;
      const hdlr = children(mdia).find(b => b.type === 'hdlr');
      if (!hdlr) continue;
      need(hdlr, 12);
      if (typeAt(hdlr.data + 8) !== 'soun') continue;
      const edts = track.find(b => b.type === 'edts');
      if (!edts) return 0;
      const elst = children(edts).find(b => b.type === 'elst');
      if (!elst) return 0;
      need(elst, 8);
      const v = view.getUint8(elst.data), count = view.getUint32(elst.data + 4);
      if (v !== 0 && v !== 1) return 0;
      const width = v === 1 ? 20 : 12;
      if (count > Math.floor((elst.end - elst.data - 8) / width)) return 0;
      let ticks = 0, leading = true;
      for (let i = 0, p = elst.data + 8; i < count; i++, p += width) {
        const duration = v === 1 ? uint64(p) : view.getUint32(p);
        const time = v === 1 ? view.getBigInt64(p + 8) : BigInt(view.getInt32(p + 4));
        if (time < -1n) return 0;
        if (leading && time === -1n) ticks += duration;
        else leading = false;
        if (ticks > scale * 60) return 0;
      }
      return ticks / scale;
    }
    return 0;
  } catch {
    return 0;
  }
}
