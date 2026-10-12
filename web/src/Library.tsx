import { useEffect, useMemo, useState } from "react";
import type { MediaItem } from "../../shared/protocol.ts";
import { api } from "./api.ts";

function fmtSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

const BROWSER_SAFE = new Set(["video/mp4", "video/webm"]);

/** Searchable library grouped by folder. */
export function Library(props: { onPick: (item: MediaItem) => void; actionLabel: string }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [convert, setConvert] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = (rescan = false) => {
    setError(null);
    (rescan ? api.rescan() : api.library()).then(
      (r) => {
        setItems(r.items);
        setConvert(r.convert);
      },
      (e) => setError(e.message),
    );
  };
  useEffect(() => load(), []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = (items ?? []).filter((i) => !q || i.relPath.toLowerCase().includes(q));
    const map = new Map<string, MediaItem[]>();
    for (const item of filtered) {
      if (!map.has(item.folder)) map.set(item.folder, []);
      map.get(item.folder)!.push(item);
    }
    return [...map.entries()];
  }, [items, query]);

  return (
    <div className="library">
      <div className="library-bar">
        <input type="search" placeholder="Search the library" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => load(true)}>Rescan</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading library…</p>}
      {items?.length === 0 && <p className="muted">No videos found. Put files in the server's media folder and press Rescan.</p>}
      {groups.map(([folder, list]) => (
        <section key={folder}>
          {folder && <h3 className="folder">{folder}</h3>}
          <ul className="items">
            {list.map((item) => (
              <li key={item.id}>
                <button className="item" onClick={() => props.onPick(item)}>
                  <span className="title">{item.title}</span>
                  <span className="meta">
                    {fmtSize(item.size)}
                    {item.subtitles.length > 0 && " · CC"}
                    {/* With ffmpeg the server converts whatever browsers can't play, so there's nothing to warn about. */}
                    {!convert && !BROWSER_SAFE.has(item.mime) && (
                      <span className="warn" title="Browsers may not play this format as-is. Install ffmpeg on the server so it can convert it. The Android app usually plays it directly.">
                        {" "}
                        · may not play in browser
                      </span>
                    )}
                  </span>
                  <span className="action">{props.actionLabel}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
