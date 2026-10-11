export interface ByteRange {
  start: number;
  end: number; // inclusive
}

/**
 * Parses a single-range `Range: bytes=...` header.
 * Returns null when there is no usable header (serve the whole file),
 * or "unsatisfiable" when the range lies outside the file.
 * Multi-range requests are answered with the first range only.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)/.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    const n = Number(endStr);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? size - 1 : Math.min(Number(endStr), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}
