import { useEffect } from "react";
export function navigate(path: string): void {
  location.hash = path;
}

/** Names the browser tab after what's on screen ("Severance · Popcorn Club"); just the app's name when there's nothing to say. */
export function usePageTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Popcorn Club` : "Popcorn Club";
  }, [title]);
}
