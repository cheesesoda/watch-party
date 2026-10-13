import { useEffect, useState, type RefObject } from "react";

/** Which parts of the top bar sit on light art: the search box (left) and Party code with Join (right). */
export type ArtTone = { left: boolean; right: boolean };

const DARK: ArtTone = { left: false, right: false };
/** Above this (0 to 1), light text stops reading well, so the controls switch to dark text. */
const LIGHT = 0.5;
/** The page behind the art (--bg), which shows through where the art fades out. */
const BG = luminance(0x18, 0x13, 0x1f);

function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** How much of the art shows at x (0 to 1 across it): the left edge fades in, as in .banner-art's mask. */
const maskAt = (x: number) => (x >= 0.6 ? 1 : 0.25 + (0.75 * Math.max(0, x)) / 0.6);

const loaded = new Map<string, Promise<HTMLImageElement>>();
function load(src: string): Promise<HTMLImageElement> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      // The API allows any origin, so the canvas can read the pixels.
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
    p.catch(() => loaded.delete(src));
    loaded.set(src, p);
  }
  return p;
}

/** How bright the art is behind [box] (perceived lightness, 0 to 1), where [art] is drawn with object-fit: cover at center 25%. */
function brightness(img: HTMLImageElement, art: DOMRect, box: DOMRect): number {
  const scale = Math.max(art.width / img.naturalWidth, art.height / img.naturalHeight);
  const offX = (art.width - img.naturalWidth * scale) * 0.5;
  const offY = (art.height - img.naturalHeight * scale) * 0.25;
  const sx = Math.max(0, (box.left - art.left - offX) / scale);
  const sy = Math.max(0, (box.top - art.top - offY) / scale);
  const sw = Math.min(img.naturalWidth - sx, box.width / scale);
  const sh = Math.min(img.naturalHeight - sy, box.height / scale);
  if (sw <= 0 || sh <= 0) return 0;
  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 6;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    // Each column fades with the mask, so the faded left edge counts as partly page background.
    const x = (box.left - art.left + (((i / 4) % canvas.width) + 0.5) * (box.width / canvas.width)) / art.width;
    const a = maskAt(x);
    sum += a * luminance(data[i], data[i + 1], data[i + 2]) + (1 - a) * BG;
  }
  // Perceived lightness (L*), so 0.5 is a mid gray rather than a fairly light one.
  const y = sum / (data.length / 4);
  return y <= 0.008856 ? (y * 903.3) / 100 : (116 * Math.cbrt(y) - 16) / 100;
}

/**
 * Watches the backdrop behind the top bar (Home's banner as it rotates, or a movie or show page's art) and says which
 * controls sit on light art, so they can switch to dark text.
 */
export function useArtTone(main: RefObject<HTMLElement | null>, on: boolean): ArtTone {
  const [tone, setTone] = useState<ArtTone>(DARK);
  useEffect(() => {
    const root = main.current;
    if (!on || !root) return setTone(DARK);
    let cancelled = false;
    let timer = 0;
    const measure = async () => {
      const art = root.querySelector<HTMLImageElement>(".banner-art.on, img.hero-art");
      const left = root.querySelector(".dash-top .search");
      const right = root.querySelector(".dash-top .join-code");
      const src = art?.currentSrc || art?.src;
      if (!art || !src || !left || !right) return setTone(DARK);
      try {
        const img = await load(src);
        if (cancelled) return;
        const box = art.getBoundingClientRect();
        const next = { left: brightness(img, box, left.getBoundingClientRect()) > LIGHT, right: brightness(img, box, right.getBoundingClientRect()) > LIGHT };
        setTone((t) => (t.left === next.left && t.right === next.right ? t : next));
      } catch {
        if (!cancelled) setTone(DARK);
      }
    };
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => void measure(), 50);
    };
    // The banner switches pictures by moving the "on" class; pages swap the whole backdrop.
    const watch = new MutationObserver(later);
    watch.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "src"] });
    window.addEventListener("resize", later);
    later();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      watch.disconnect();
      window.removeEventListener("resize", later);
    };
  }, [main, on]);
  return tone;
}
