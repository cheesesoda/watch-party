import { useEffect } from "react";
export function navigate(path: string): void {
  // Remember the page a party was started or joined from, so leaving it comes back there.
  const here = location.hash.replace(/^#/, "") || "/";
  if (/^\/(room|join)\//.test(path) && !/^\/(room|join)\//.test(here)) {
    try {
      sessionStorage.setItem("partyFrom", here);
    } catch {}
  }
  location.hash = path;
}

/** Leaves a party for the page it was started or joined from (Home when there isn't one). */
export function leaveParty(): void {
  let from = "/";
  try {
    from = sessionStorage.getItem("partyFrom") || "/";
    sessionStorage.removeItem("partyFrom");
  } catch {}
  navigate(/^\/(room|join|start|pair)\b/.test(from) ? "/" : from);
}

/** Names the browser tab after what's on screen ("Severance · Popcorn Club"); just the app's name when there's nothing to say. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Popcorn Club` : "Popcorn Club";
  }, [title]);
}
