(module
  ;; ── Linear memory layout (128 pages × 64 KiB = 8 388 608 bytes) ────────────
  ;; [0x00000, 0x02000)   Input  buffer  – one compressed record  (≤ 8 192 bytes)
  ;; [0x02000, 0x22000)   Output buffer  – one decompressed record (≤ 131 072 bytes)
  ;; [0x22000, 0x22100)   dict1Codelen[256]   u8
  ;; [0x22100, 0x22200)   dict1Term[256]      u8
  ;; [0x22200, 0x22600)   dict1Maxcode[256]   u32 LE
  ;; [0x22600, 0x22684)   mincodeArr[33]      u32 LE
  ;; [0x22700, 0x22784)   maxcodeArr[33]      u32 LE
  ;; [0x30000, 0xC0000)   cdicOffsets[≤147 456 entries]  u32 LE
  ;; [0xC0000, 0x110000)  cdicLengths[≤163 840 entries]  u16 LE
  ;; [0x110000, end)      cdicData  – flat concatenated phrase bytes (~7.3 MB cap)
  (memory (export "mem") 128)

  ;; ── Exported layout constants so JS reads offsets without hardcoding ───────
  (global (export "IN_OFF")  i32 (i32.const 0x00000))
  (global (export "OUT_OFF") i32 (i32.const 0x02000))
  (global (export "CL_OFF")  i32 (i32.const 0x22000))
  (global (export "CT_OFF")  i32 (i32.const 0x22100))
  (global (export "CM_OFF")  i32 (i32.const 0x22200))
  (global (export "MN_OFF")  i32 (i32.const 0x22600))
  (global (export "MX_OFF")  i32 (i32.const 0x22700))
  (global (export "DO_OFF")  i32 (i32.const 0x30000))
  (global (export "DL_OFF")  i32 (i32.const 0xC0000))
  (global (export "DD_OFF")  i32 (i32.const 0x110000))
  ;; Available bytes for cdicData (128 pages total − layout overhead)
  (global (export "DD_CAP")  i32 (i32.const 7274496))

  ;; ── Mutable: number of valid CDIC phrases (set by JS after setup) ──────────
  (global $dictLen (mut i32) (i32.const 0))
  (func (export "setDictLen") (param $n i32)
    (global.set $dictLen (local.get $n)))

  ;; ── read32: big-endian u32 from input buffer at byte offset p ─────────────
  ;; Bytes at or beyond inLen are zero-padded (needed for the last 1-2 reads).
  (func $read32 (param $p i32) (param $inLen i32) (result i32)
    ;; Fast path: all four bytes are within [0, inLen)
    (if (i32.lt_u (i32.add (local.get $p) (i32.const 3)) (local.get $inLen))
      (then
        (return (i32.or
          (i32.or
            (i32.shl (i32.load8_u                        (local.get $p))               (i32.const 24))
            (i32.shl (i32.load8_u (i32.add (local.get $p) (i32.const 1)))              (i32.const 16)))
          (i32.or
            (i32.shl (i32.load8_u (i32.add (local.get $p) (i32.const 2)))              (i32.const 8))
                     (i32.load8_u (i32.add (local.get $p) (i32.const 3))))))))
    ;; Slow path: individual bounds-checked byte reads, out-of-range → 0
    (i32.or
      (i32.or
        (i32.shl
          (select (i32.load8_u (local.get $p))
                  (i32.const 0)
                  (i32.lt_u (local.get $p) (local.get $inLen)))
          (i32.const 24))
        (i32.shl
          (select (i32.load8_u (i32.add (local.get $p) (i32.const 1)))
                  (i32.const 0)
                  (i32.lt_u (i32.add (local.get $p) (i32.const 1)) (local.get $inLen)))
          (i32.const 16)))
      (i32.or
        (i32.shl
          (select (i32.load8_u (i32.add (local.get $p) (i32.const 2)))
                  (i32.const 0)
                  (i32.lt_u (i32.add (local.get $p) (i32.const 2)) (local.get $inLen)))
          (i32.const 8))
        (select (i32.load8_u (i32.add (local.get $p) (i32.const 3)))
                (i32.const 0)
                (i32.lt_u (i32.add (local.get $p) (i32.const 3)) (local.get $inLen))))))

  ;; ── decompress: decode HUFF/CDIC-compressed record ────────────────────────
  ;; Call: write compressed bytes to mem[0..inLen), then call decompress(inLen).
  ;; Result bytes are written to mem[OUT_OFF..OUT_OFF+result).
  ;; Returns the output byte count (≥ 0).
  (func (export "decompress") (param $inLen i32) (result i32)
    (local $pos      i32)   ;; window position (advances in 4-byte steps)
    (local $hi       i32)   ;; upper 32 bits of the 64-bit sliding window
    (local $lo       i32)   ;; lower 32 bits
    (local $n        i32)   ;; valid bits remaining in $hi  (1..32)
    (local $bitsleft i32)   ;; total bits not yet consumed
    (local $code     i32)   ;; current 32-bit code extracted from window top
    (local $idx      i32)   ;; top 8 bits of $code → dict1 row index
    (local $codelen  i32)
    (local $maxcode  i32)
    (local $r        i32)   ;; CDIC phrase index
    (local $doff     i32)   ;; phrase data offset within cdicData
    (local $dlen     i32)   ;; phrase length in bytes
    (local $outLen   i32)   ;; bytes written to output so far
    (local $ci       i32)   ;; byte-copy loop counter

    (local.set $bitsleft (i32.shl (local.get $inLen) (i32.const 3)))
    (local.set $pos      (i32.const 0))
    (local.set $n        (i32.const 32))
    (local.set $outLen   (i32.const 0))
    (local.set $hi (call $read32 (i32.const 0) (local.get $inLen)))
    (local.set $lo (call $read32 (i32.const 4) (local.get $inLen)))

    (block $break
      (loop $loop

        ;; ── Advance the 64-bit window when $hi is exhausted ────────────────
        (if (i32.le_s (local.get $n) (i32.const 0))
          (then
            (local.set $pos (i32.add (local.get $pos) (i32.const 4)))
            (local.set $hi  (local.get $lo))
            (local.set $lo  (call $read32
                              (i32.add (local.get $pos) (i32.const 4))
                              (local.get $inLen)))
            (local.set $n (i32.add (local.get $n) (i32.const 32)))))

        ;; ── Extract 32-bit code from window top ────────────────────────────
        (local.set $code
          (if (result i32) (i32.eq (local.get $n) (i32.const 32))
            (then (local.get $hi))
            (else (i32.or
              (i32.shl (local.get $hi) (i32.sub (i32.const 32) (local.get $n)))
              (i32.shr_u (local.get $lo) (local.get $n))))))

        ;; ── dict1 table lookup (256 entries, indexed by top byte of $code) ─
        (local.set $idx     (i32.shr_u (local.get $code) (i32.const 24)))
        (local.set $codelen (i32.load8_u
          (i32.add (i32.const 0x22000) (local.get $idx))))
        (local.set $maxcode (i32.load
          (i32.add (i32.const 0x22200) (i32.shl (local.get $idx) (i32.const 2)))))

        ;; ── Non-terminal: walk up codelen until code >= mincode[codelen] ───
        (if (i32.eqz (i32.load8_u (i32.add (i32.const 0x22100) (local.get $idx))))
          (then
            (block $tbreak
              (loop $tloop
                (br_if $tbreak
                  (i32.ge_u (local.get $code)
                    (i32.load (i32.add (i32.const 0x22600)
                                (i32.shl (local.get $codelen) (i32.const 2))))))
                (local.set $codelen (i32.add (local.get $codelen) (i32.const 1)))
                (br_if $tbreak (i32.gt_u (local.get $codelen) (i32.const 32)))
                (br $tloop)))
            (local.set $maxcode (i32.load
              (i32.add (i32.const 0x22700)
                       (i32.shl (local.get $codelen) (i32.const 2)))))))

        ;; ── Consume $codelen bits from the window ──────────────────────────
        (local.set $n        (i32.sub (local.get $n)        (local.get $codelen)))
        (local.set $bitsleft (i32.sub (local.get $bitsleft) (local.get $codelen)))
        (br_if $break (i32.lt_s (local.get $bitsleft) (i32.const 0)))

        ;; ── Compute phrase index r = (maxcode – code) >> (32 – codelen) ────
        (local.set $r (i32.shr_u
          (i32.sub (local.get $maxcode) (local.get $code))
          (i32.sub (i32.const 32) (local.get $codelen))))
        (br_if $break (i32.ge_u (local.get $r) (global.get $dictLen)))

        ;; ── Look up phrase: offset (u32) and length (u16) ─────────────────
        (local.set $doff (i32.load
          (i32.add (i32.const 0x30000) (i32.shl (local.get $r) (i32.const 2)))))
        (local.set $dlen (i32.load16_u
          (i32.add (i32.const 0xC0000) (i32.shl (local.get $r) (i32.const 1)))))

        ;; ── Output overflow guard ─────────────────────────────────────────
        (br_if $break (i32.gt_u
          (i32.add (local.get $outLen) (local.get $dlen))
          (i32.const 131072)))

        ;; ── Copy phrase bytes to output (WASM 1.0 byte-by-byte loop) ──────
        ;; Avg phrase length is ~5 bytes; JITs typically optimise short loops
        ;; to use SIMD / rep-movs behind the scenes.
        (local.set $ci (i32.const 0))
        (block $cbreak
          (loop $cloop
            (br_if $cbreak (i32.ge_u (local.get $ci) (local.get $dlen)))
            (i32.store8
              (i32.add (i32.add (i32.const 0x02000) (local.get $outLen)) (local.get $ci))
              (i32.load8_u
                (i32.add (i32.add (i32.const 0x110000) (local.get $doff)) (local.get $ci))))
            (local.set $ci (i32.add (local.get $ci) (i32.const 1)))
            (br $cloop)))

        (local.set $outLen (i32.add (local.get $outLen) (local.get $dlen)))
        (br $loop)))  ;; end of outer decode loop

    (local.get $outLen))
)



