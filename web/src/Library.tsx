import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MediaItem } from "../../shared/protocol.ts";
import { api, imageUrl, type LibraryResponse, type MatchCandidate } from "./api.ts";
import { ChevronLeftIcon, ChevronRightIcon, InfoIcon } from "./Icons.tsx";

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
  /** The show names read from file names that were grouped into this one. */
  aliases: string[];
  episodes: MediaItem[];
  seasons: number[];
  addedAt: number;
}

/** The library: one menu (All videos, Movies, TV shows), sorting, a Recently added row, and shows grouped into seasons. */
export function Library(props: {
  onPick: (item: MediaItem) => void;
  actionLabel: string;
  /** Plays these one after another (a season, a whole show, or a show from one episode on). */
  onBinge?: (ids: string[]) => void;
}) {
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
  // TMDB details are on: posters, summaries and the Details window with Fix match.
  const [details, setDetails] = useState(false);
  const [shownInfo, setShownInfo] = useState<string | null>(null);

  const apply = (r: LibraryResponse) => {
    setItems(r.items);
    setConvert(r.convert);
    setDetails(!!r.details);
  };

  const load = (rescan = false) => {
    setError(null);
    (rescan ? api.rescan() : api.library()).then(apply, (e) => setError(e.message));
  };
  useEffect(() => load(), []);

  const q = query.trim().toLowerCase();
  const matches = (i: MediaItem) => !q || i.title.toLowerCase().includes(q) || i.relPath.toLowerCase().includes(q);

  // Extras (behind the scenes, trailers…) that belong to a movie or show are listed under it, not on their own.
  const owned = (i: MediaItem) => !!(i.extra && (i.extra.of || i.extra.show));
  // A movie split into files ("Pt 1", "Pt 2") is listed once, as its first part, and plays all of them.
  const laterPart = (i: MediaItem) => !!i.part && i.part.index > 1;
  const pick = (item: MediaItem) => (item.part && props.onBinge ? props.onBinge(item.part.ids) : props.onPick(item));
  const { movieExtras, showExtras: extrasByFolderName, byId } = useMemo(() => {
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
      // With TMDB, "Franklin & Bash" and "Franklin and Bash" folders are one show, under TMDB's name.
      const id = item.meta?.tmdbId ? `tmdb:${item.meta.tmdbId}` : item.episode.show.toLowerCase().replace(/\s*&\s*/g, " and ");
      if (!map.has(id)) map.set(id, { name: item.meta?.show ?? item.episode.show, aliases: [], episodes: [], seasons: [], addedAt: 0 });
      const show = map.get(id)!;
      if (!show.aliases.includes(item.episode.show)) show.aliases.push(item.episode.show);
      show.episodes.push(item);
      show.addedAt = Math.max(show.addedAt, item.addedAt ?? 0);
    }
    for (const show of map.values()) {
      show.episodes.sort((a, b) => a.episode!.season - b.episode!.season || a.episode!.episode - b.episode!.episode);
      show.seasons = [...new Set(show.episodes.map((e) => e.episode!.season))];
    }
    return [...map.values()].sort((a, b) => byName(a.name, b.name));
  }, [items]);

  // A show's extras are found by its folder name, which may be one of several merged under TMDB's name.
  const showExtras = useMemo(() => {
    const byShow = new Map<string, MediaItem[]>();
    for (const show of shows) {
      const extras = show.aliases.flatMap((a) => extrasByFolderName.get(a) ?? []);
      if (extras.length > 0) byShow.set(show.name, extras);
    }
    return byShow;
  }, [shows, extrasByFolderName]);

  // Movies (anything that isn't an episode), plus one row per show under All videos.
  const rows = useMemo(() => {
    const list = (items ?? []).filter(
      // While searching, matching extras show up on their own too, labeled with what they belong to.
      (i) => !laterPart(i) && (view === "all" || (!i.episode && !i.extra?.show)) && (q || !owned(i)) && (!subsOnly || i.subtitles.length > 0) && matches(i),
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

  // "2 parts · 3:11:00": the whole length once every part's is known.
  const partsLabel = (item: MediaItem) => {
    const parts = item.part!.ids.map((id) => byId.get(id));
    const total = parts.every((p) => p?.duration) ? parts.reduce((n, p) => n + p!.duration!, 0) : null;
    return `${parts.length} parts${total ? ` · ${fmtLength(total)}` : ""}`;
  };

  const recent = useMemo(
    () =>
      (items ?? [])
        .filter((i) => !i.episode && !i.extra && !laterPart(i))
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
      {item.part ? partsLabel(item) : item.duration ? fmtLength(item.duration) : fmtSize(item.size)}
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

  const listed = (items ?? []).filter((i) => !owned(i) && !laterPart(i));
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
    <li key={e.id} className="row-line">
      <button className={details ? "item episode has-still" : "item episode"} onClick={() => props.onPick(e)}>
        <span className="num">E{e.episode!.episode}</span>
        {details && <Poster path={e.meta?.stillPath} size="w300" className="still" />}
        <span className="title">{e.episode!.title ?? `Episode ${e.episode!.episode}`}</span>
        {details && e.meta?.overview && <span className="overview">{e.meta.overview}</span>}
        <span className="meta">{meta(e)}</span>
        <span className="action">{props.actionLabel}</span>
      </button>
      {details && <InfoButton onClick={() => setShownInfo(e.id)} />}
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
                      <button key={item.id} className={details ? "tile has-poster" : "tile"} onClick={() => pick(item)}>
                        {details && <Poster path={item.meta?.posterPath} size="w185" />}
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
                    <li key={r.item.id} className="row-line">
                      <button className={details ? "item has-poster" : "item"} onClick={() => pick(r.item)}>
                        {details && <Poster path={r.item.meta?.posterPath} size="w92" />}
                        <span className="title">
                          {r.item.title}
                          {r.item.year && <span className="year"> {r.item.year}</span>}
                        </span>
                        <span className="meta">{meta(r.item)}</span>
                        <span className="action">{props.actionLabel}</span>
                      </button>
                      {details && <InfoButton onClick={() => setShownInfo(r.item.id)} />}
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
                      <button className={details ? "item has-poster" : "item"} onClick={() => openShow(r.show.name)}>
                        {details && <Poster path={r.show.episodes[0].meta?.showPosterPath} size="w92" />}
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
                  <button
                    key={s.name}
                    className={`tile show${details ? " has-poster" : ""}${s === show ? " on" : ""}`}
                    aria-pressed={s === show}
                    onClick={() => openShow(s.name)}
                  >
                    {details && <Poster path={s.episodes[0].meta?.showPosterPath} size="w185" />}
                    <span className="title">{s.name}</span>
                    <span className="meta">
                      {plural(s.seasons.length, "season")} · {plural(s.episodes.length, "episode")}
                    </span>
                  </button>
                ))}
              </Shelf>
              {show && (
                <>
                  {details ? (
                    <div className="show-head">
                      <Poster path={show.episodes[0].meta?.showPosterPath} size="w185" />
                      <div>
                        <h3>
                          {show.episodes[0].meta?.show ?? show.name}
                          {show.episodes[0].meta?.year && <span className="year"> {show.episodes[0].meta.year}</span>}
                        </h3>
                        {show.episodes[0].meta?.showOverview && <p className="overview">{show.episodes[0].meta.showOverview}</p>}
                        <button className="link" onClick={() => setShownInfo(show.episodes[0].id)}>
                          {show.episodes[0].meta ? "Wrong show? Fix match" : "Find show details"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <h3 className="shelf-title">{show.name}</h3>
                  )}
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
                  {props.onBinge && shownSeason !== EXTRAS && (
                    <div className="binge-bar">
                      <button className="primary" onClick={() => props.onBinge!(show.episodes.filter((e) => e.episode!.season === shownSeason).map((e) => e.id))}>
                        Binge season {shownSeason}
                      </button>
                      {show.seasons.length > 1 && (
                        <button onClick={() => props.onBinge!(show.episodes.map((e) => e.id))}>Binge all {show.seasons.length} seasons</button>
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
      {shownInfo && byId.has(shownInfo) && (
        <Details
          item={byId.get(shownInfo)!}
          actionLabel={props.actionLabel}
          lengthLabel={meta(byId.get(shownInfo)!)}
          onPick={() => {
            const item = byId.get(shownInfo)!;
            setShownInfo(null);
            pick(item);
          }}
          onBingeFrom={
            props.onBinge && byId.get(shownInfo)!.episode
              ? () => {
                  const item = byId.get(shownInfo)!;
                  const show = shows.find((s) => s.episodes.includes(item));
                  setShownInfo(null);
                  if (show) props.onBinge!(show.episodes.slice(show.episodes.indexOf(item)).map((e) => e.id));
                }
              : undefined
          }
          onMatched={apply}
          onClose={() => setShownInfo(null)}
        />
      )}
    </div>
  );
}

/** A TMDB poster or still, or an empty frame of the same size so rows line up when there's none. */
function Poster(props: { path?: string | null; size: "w92" | "w185" | "w342" | "w300"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const cls = props.className ?? "poster";
  if (!props.path || failed) return <span className={`${cls} empty`} aria-hidden="true" />;
  return <img className={cls} src={imageUrl(props.path, props.size)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function InfoButton(props: { onClick: () => void }) {
  return (
    <button className="row-tool" aria-label="Details" title="Details" onClick={props.onClick}>
      <InfoIcon size={18} />
    </button>
  );
}

/** A movie's or episode's TMDB details, with Fix match for when the server picked the wrong one. */
function Details(props: {
  item: MediaItem;
  actionLabel: string;
  lengthLabel: ReactNode;
  onPick: () => void;
  /** For an episode: play it and every episode after it. */
  onBingeFrom?: () => void;
  onMatched: (r: LibraryResponse) => void;
  onClose: () => void;
}) {
  const { item } = props;
  const m = item.meta;
  const kind = item.episode ? "tv" : "movie";
  const [fixing, setFixing] = useState(!m);
  const [query, setQuery] = useState(item.episode?.show ?? item.title);
  const [results, setResults] = useState<MatchCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const search = (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    api.searchMatch(kind, query.trim()).then(
      (r) => {
        setResults(r);
        setBusy(false);
      },
      (err) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  useEffect(() => {
    if (fixing && results === null && query.trim()) search();
  }, [fixing]);

  const choose = (tmdbId: number | null) => {
    setBusy(true);
    setError(null);
    api.setMatch(item.id, tmdbId).then(
      (r) => {
        props.onMatched(r);
        setFixing(false);
        setResults(null);
        setBusy(false);
      },
      (err) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };

  const heading = item.episode ? (m?.show ?? item.episode.show) : (m?.title ?? item.title);
  return (
    <div
      className="details-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }}
    >
      <div className="details" role="dialog" aria-modal="true" aria-label={heading} onClick={(e) => e.stopPropagation()}>
        <div className="details-main">
          <Poster path={m?.posterPath} size="w342" className="details-poster" />
          <div className="details-text">
            <h2>
              {heading}
              {(m?.year ?? item.year) && <span className="year"> {m?.year ?? item.year}</span>}
            </h2>
            {item.episode && (
              <p className="details-sub">
                Season {item.episode.season}, episode {item.episode.episode}
                {item.episode.title && ` · ${item.episode.title}`}
              </p>
            )}
            <p className="meta">{props.lengthLabel}</p>
            {m?.overview ? <p className="overview">{m.overview}</p> : !fixing && <p className="muted">No summary.</p>}
            <div className="details-actions">
              <button className="primary" onClick={props.onPick}>
                {props.actionLabel}
              </button>
              {props.onBingeFrom && <button onClick={props.onBingeFrom}>Binge from here</button>}
              {!fixing && <button onClick={() => setFixing(true)}>{m ? "Fix match" : "Find details"}</button>}
              <button onClick={props.onClose}>Close</button>
            </div>
          </div>
        </div>

        {fixing && (
          <div className="fix-match">
            <h3>{m ? `Wrong ${item.episode ? "show" : "movie"}? Pick the right one` : `Find this ${item.episode ? "show" : "movie"}`}</h3>
            {item.episode && <p className="muted small">This changes every episode of {item.episode.show}.</p>}
            <form onSubmit={search}>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search TMDB" />
              <button disabled={busy || !query.trim()}>Search</button>
            </form>
            {error && <p className="error">{error}</p>}
            {busy && !results && <p className="muted">Searching…</p>}
            {results?.length === 0 && <p className="muted">Nothing found. Try fewer words, or the original title.</p>}
            <ul className="items">
              {results?.map((c) => (
                <li key={c.tmdbId}>
                  <button className="item has-poster" disabled={busy} aria-current={c.tmdbId === m?.tmdbId} onClick={() => choose(c.tmdbId)}>
                    <Poster path={c.posterPath} size="w92" />
                    <span className="title">
                      {c.title}
                      {c.year && <span className="year"> {c.year}</span>}
                    </span>
                    <span className="meta overview-line">{c.overview ?? ""}</span>
                    <span className="action">{c.tmdbId === m?.tmdbId ? "Current" : "Use this"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {m && (
              <button className="link" disabled={busy} onClick={() => choose(null)}>
                None of these: show it without details
              </button>
            )}
          </div>
        )}
        <p className="credit">Details and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
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
