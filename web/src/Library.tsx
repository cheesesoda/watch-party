import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MediaItem } from "../../shared/protocol.ts";
import { api } from "./api.ts";
import { ChevronLeftIcon, ChevronRightIcon } from "./Icons.tsx";

function fmtSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** 7260 -> "2:01:00", 3000 -> "50:00" */
export function fmtLength(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

const BROWSER_SAFE = new Set(["video/mp4", "video/webm"]);
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

type View = "all" | "movies" | "shows";
type Sort = "recent" | "az" | "length" | "size";
const SORTS: [Sort, string][] = [
  ["recent", "Recently added"],
  ["az", "A–Z"],
  ["length", "Length"],
  ["size", "Size"],
];

interface Show {
  name: string;
  episodes: MediaItem[];
  seasons: number[];
  addedAt: number;
}

/** The library: one menu (All videos, Movies, TV shows), sorting, a Recently added row, and shows grouped into seasons. */
export function Library(props: { onPick: (item: MediaItem) => void; actionLabel: string }) {
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [convert, setConvert] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<Sort>("az");
  const [subsOnly, setSubsOnly] = useState(false);
  const [showName, setShowName] = useState<string | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [openExtras, setOpenExtras] = useState<string | null>(null);

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

  const q = query.trim().toLowerCase();
  const matches = (i: MediaItem) => !q || i.title.toLowerCase().includes(q) || i.relPath.toLowerCase().includes(q);

  // Extras (behind the scenes, trailers…) that belong to a movie or show are listed under it, not on their own.
  const owned = (i: MediaItem) => !!(i.extra && (i.extra.of || i.extra.show));
  const { movieExtras, showExtras, byId } = useMemo(() => {
    const movieExtras = new Map<string, MediaItem[]>();
    const showExtras = new Map<string, MediaItem[]>();
    for (const i of items ?? []) {
      const key = i.extra?.of ?? i.extra?.show;
      if (!key) continue;
      const map = i.extra!.of ? movieExtras : showExtras;
      map.set(key, [...(map.get(key) ?? []), i].sort((a, b) => byName(a.title, b.title)));
    }
    return { movieExtras, showExtras, byId: new Map((items ?? []).map((i) => [i.id, i])) };
  }, [items]);

  const shows = useMemo(() => {
    const map = new Map<string, Show>();
    for (const item of items ?? []) {
      if (!item.episode) continue;
      const name = item.episode.show;
      if (!map.has(name)) map.set(name, { name, episodes: [], seasons: [], addedAt: 0 });
      const show = map.get(name)!;
      show.episodes.push(item);
      show.addedAt = Math.max(show.addedAt, item.addedAt ?? 0);
    }
    for (const show of map.values()) {
      show.episodes.sort((a, b) => a.episode!.season - b.episode!.season || a.episode!.episode - b.episode!.episode);
      show.seasons = [...new Set(show.episodes.map((e) => e.episode!.season))];
    }
    return [...map.values()].sort((a, b) => byName(a.name, b.name));
  }, [items]);

  // Movies (anything that isn't an episode), plus one row per show under All videos.
  const rows = useMemo(() => {
    const list = (items ?? []).filter(
      // While searching, matching extras show up on their own too, labeled with what they belong to.
      (i) => (view === "all" || (!i.episode && !i.extra?.show)) && (q || !owned(i)) && (!subsOnly || i.subtitles.length > 0) && matches(i),
    );
    const singles = list.filter((i) => !i.episode);
    const showRows = view === "all" ? shows.filter((s) => s.episodes.some((e) => list.includes(e))) : [];
    type Row = { kind: "item"; item: MediaItem } | { kind: "show"; show: Show };
    const all: Row[] = [...singles.map((item) => ({ kind: "item" as const, item })), ...showRows.map((show) => ({ kind: "show" as const, show }))];
    const name = (r: Row) => (r.kind === "item" ? r.item.title : r.show.name);
    const added = (r: Row) => (r.kind === "item" ? r.item.addedAt ?? 0 : r.show.addedAt);
    const length = (r: Row) => (r.kind === "item" ? r.item.duration ?? -1 : -1);
    const size = (r: Row) => (r.kind === "item" ? r.item.size : r.show.episodes.reduce((n, e) => n + e.size, 0));
    const cmp: Record<Sort, (a: Row, b: Row) => number> = {
      az: (a, b) => byName(name(a), name(b)),
      recent: (a, b) => added(b) - added(a) || byName(name(a), name(b)),
      length: (a, b) => length(b) - length(a) || byName(name(a), name(b)),
      size: (a, b) => size(b) - size(a),
    };
    return all.sort(cmp[sort]);
  }, [items, shows, view, subsOnly, sort, q]);

  const recent = useMemo(
    () =>
      (items ?? [])
        .filter((i) => !i.episode && !i.extra)
        .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
        .slice(0, 12),
    [items],
  );

  const visibleShows = shows.filter((s) => !q || s.name.toLowerCase().includes(q) || s.episodes.some(matches));
  const show = visibleShows.find((s) => s.name === showName) ?? visibleShows[0];
  const shownSeason =
    show && season !== null && (show.seasons.includes(season) || (season === EXTRAS && showExtras.has(show.name))) ? season : show?.seasons[0];

  const openShow = (name: string) => {
    setView("shows");
    setShowName(name);
    setSeason(null);
  };

  const meta = (item: MediaItem) => (
    <>
      {item.extra && `${item.extra.kind}${q && (item.extra.of || item.extra.show) ? ` · ${byId.get(item.extra.of ?? "")?.title ?? item.extra.show}` : ""} · `}
      {item.duration ? fmtLength(item.duration) : fmtSize(item.size)}
      {item.subtitles.length > 0 && " · CC"}
      {/* With ffmpeg the server converts whatever browsers can't play, so there's nothing to warn about. */}
      {!convert && !BROWSER_SAFE.has(item.mime) && (
        <span className="warn" title="Browsers may not play this format as-is. Install ffmpeg on the server so it can convert it. The Android app usually plays it directly.">
          {" "}
          · may not play in browser
        </span>
      )}
    </>
  );

  const listed = (items ?? []).filter((i) => !owned(i));
  const movieCount = listed.filter((i) => !i.episode).length;
  const menu: [View, string, number][] = [
    ["all", "All videos", listed.length],
    ["movies", "Movies", movieCount],
    ...(shows.length > 0 ? [["shows", "TV shows", shows.length] as [View, string, number]] : []),
  ];

  const extraRow = (e: MediaItem) => (
    <li key={e.id}>
      <button className="item" onClick={() => props.onPick(e)}>
        <span className="title">{e.title}</span>
        <span className="meta">{meta(e)}</span>
        <span className="action">{props.actionLabel}</span>
      </button>
    </li>
  );

  const episodeRow = (e: MediaItem) => (
    <li key={e.id}>
      <button className="item episode" onClick={() => props.onPick(e)}>
        <span className="num">E{e.episode!.episode}</span>
        <span className="title">{e.episode!.title ?? `Episode ${e.episode!.episode}`}</span>
        <span className="meta">{meta(e)}</span>
        <span className="action">{props.actionLabel}</span>
      </button>
    </li>
  );

  return (
    <div className="library">
      <div className="library-bar">
        <input type="search" placeholder={items ? `Search ${listed.length} videos` : "Search"} value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={() => load(true)}>Rescan</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading library…</p>}
      {items?.length === 0 && <p className="muted">No videos found. Put files in the server's media folder and press Rescan.</p>}

      {items && items.length > 0 && (
        <div className="browse">
          <nav className="rail">
            {menu.map(([v, label, count]) => (
              <button key={v} className={view === v ? "on" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
                {label} <b>{count}</b>
              </button>
            ))}
            {view !== "shows" && (
              <>
                <hr />
                <button className={subsOnly ? "on" : ""} aria-pressed={subsOnly} onClick={() => setSubsOnly(!subsOnly)}>
                  Has subtitles <b>{listed.filter((i) => i.subtitles.length > 0 && (view === "all" || !i.episode)).length}</b>
                </button>
              </>
            )}
          </nav>

          {view !== "shows" ? (
            <div className="browse-main">
              {!q && sort !== "recent" && recent.length > 2 && (
                <section>
                  <h3 className="shelf-title">Recently added</h3>
                  <Shelf>
                    {recent.map((item) => (
                      <button key={item.id} className="tile" onClick={() => props.onPick(item)}>
                        <span className="title">{item.title}</span>
                        <span className="meta">
                          {item.year ? `${item.year} · ` : ""}
                          {meta(item)}
                        </span>
                      </button>
                    ))}
                  </Shelf>
                </section>
              )}
              <div className="sortbar">
                <span className="muted">Sort</span>
                {SORTS.map(([s, label]) => (
                  <button key={s} className={sort === s ? "chip on" : "chip"} aria-pressed={sort === s} onClick={() => setSort(s)}>
                    {label}
                  </button>
                ))}
              </div>
              {rows.length === 0 && <p className="muted">No videos match.</p>}
              <ul className="items">
                {rows.map((r) =>
                  r.kind === "item" ? (
                    <li key={r.item.id} className={!q && movieExtras.has(r.item.id) ? "with-extras" : undefined}>
                      <button className="item" onClick={() => props.onPick(r.item)}>
                        <span className="title">
                          {r.item.title}
                          {r.item.year && <span className="year"> {r.item.year}</span>}
                        </span>
                        <span className="meta">{meta(r.item)}</span>
                        <span className="action">{props.actionLabel}</span>
                      </button>
                      {!q && movieExtras.has(r.item.id) && (
                        <button
                          className="extras-toggle"
                          aria-expanded={openExtras === r.item.id}
                          onClick={() => setOpenExtras(openExtras === r.item.id ? null : r.item.id)}
                        >
                          {plural(movieExtras.get(r.item.id)!.length, "extra")}
                        </button>
                      )}
                      {!q && openExtras === r.item.id && <ul className="items extras">{movieExtras.get(r.item.id)!.map(extraRow)}</ul>}
                    </li>
                  ) : (
                    <li key={"show-" + r.show.name}>
                      <button className="item" onClick={() => openShow(r.show.name)}>
                        <span className="title">{r.show.name}</span>
                        <span className="meta">
                          TV show · {plural(r.show.seasons.length, "season")} · {plural(r.show.episodes.length, "episode")}
                          {showExtras.has(r.show.name) && ` · ${plural(showExtras.get(r.show.name)!.length, "extra")}`}
                        </span>
                        <span className="action">Episodes</span>
                      </button>
                    </li>
                  ),
                )}
              </ul>
            </div>
          ) : (
            <div className="browse-main">
              {visibleShows.length === 0 && <p className="muted">No shows match.</p>}
              <Shelf>
                {visibleShows.map((s) => (
                  <button key={s.name} className={s === show ? "tile show on" : "tile show"} aria-pressed={s === show} onClick={() => openShow(s.name)}>
                    <span className="title">{s.name}</span>
                    <span className="meta">
                      {plural(s.seasons.length, "season")} · {plural(s.episodes.length, "episode")}
                    </span>
                  </button>
                ))}
              </Shelf>
              {show && (
                <>
                  <h3 className="shelf-title">{show.name}</h3>
                  {(show.seasons.length > 1 || showExtras.has(show.name)) && (
                    <div className="sortbar">
                      {show.seasons.map((n) => (
                        <button key={n} className={n === shownSeason ? "chip on" : "chip"} aria-pressed={n === shownSeason} onClick={() => setSeason(n)}>
                          Season {n}
                        </button>
                      ))}
                      {showExtras.has(show.name) && (
                        <button className={shownSeason === EXTRAS ? "chip on" : "chip"} aria-pressed={shownSeason === EXTRAS} onClick={() => setSeason(EXTRAS)}>
                          Extras
                        </button>
                      )}
                    </div>
                  )}
                  <ul className="items">
                    {shownSeason === EXTRAS
                      ? showExtras.get(show.name)!.map(extraRow)
                      : show.episodes.filter((e) => e.episode!.season === shownSeason).map(episodeRow)}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The Extras tab next to a show's seasons. */
const EXTRAS = -1;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A row of cards with no scrollbar: arrow buttons page through it when it doesn't all fit. Swiping still works. */
function Shelf(props: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (el) setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(() => {
    update();
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const page = (direction: number) => ref.current?.scrollBy({ left: direction * ref.current.clientWidth * 0.9, behavior: "smooth" });
  return (
    <div className="shelf-wrap">
      <div className="shelf" ref={ref} onScroll={update}>
        {props.children}
      </div>
      {edges.left && (
        <button className="shelf-arrow left" onClick={() => page(-1)} aria-label="Previous">
          <ChevronLeftIcon size={20} />
        </button>
      )}
      {edges.right && (
        <button className="shelf-arrow right" onClick={() => page(1)} aria-label="More">
          <ChevronRightIcon size={20} />
        </button>
      )}
    </div>
  );
}
