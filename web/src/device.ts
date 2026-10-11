/** Smart TV browsers and the webOS app. */
export function isTv(): boolean {
  return /Web0S|webOS|SMART-TV|SmartTV|Tizen|NetCast/i.test(navigator.userAgent);
}

const FOCUSABLE = "button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/**
 * Moves focus with the remote's arrow keys on TVs that have no pointer. Up and down always move
 * between controls; left and right do too once a button has focus (in a room, left and right
 * on the video itself seek instead).
 */
export function enableArrowNavigation(): void {
  window.addEventListener("keydown", (e) => {
    const dir = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
    if (!dir || e.defaultPrevented) return;
    const active = document.activeElement as HTMLElement | null;
    const onControl = active && active !== document.body && active.matches(FOCUSABLE);
    if (dir[0] !== 0 && (!onControl || active!.matches("input, textarea, select"))) return;

    const candidates = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      const r = el.getBoundingClientRect();
      return el !== active && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    if (candidates.length === 0) return;
    if (!onControl) {
      candidates[0].focus();
      e.preventDefault();
      return;
    }

    const from = active!.getBoundingClientRect();
    const cx = from.left + from.width / 2;
    const cy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx;
      const dy = r.top + r.height / 2 - cy;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 1) continue; // not in that direction
      const across = Math.abs(dx * dir[1] + dy * dir[0]);
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: "nearest" });
      e.preventDefault();
    }
  });
}
