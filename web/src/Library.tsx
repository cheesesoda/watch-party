import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MediaItem, SkipMarks, TimeRange } from "../../shared/protocol.ts";
import { api, imageUrl, type LibraryResponse, type MatchCandidate, type SkipTimes } from "./api.ts";
import { buildCatalog, byName, isLaterPart, isOwnedExtra, plural, type Show } from "./catalog.ts";
import { ChevronLeftIcon, ChevronRightIcon, ListVideoIcon, MoreIcon } from "./Icons.tsx";

/** 7260 -> "2:01:00", 3000 -> "50:00" */
export function fmtLength(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

export const BROWSER_SAFE = new Set(["video/mp4", "video/webm"]);

type View = "all" | "movies" | "shows";
type Sort = "recent" | "az" | "length" | "size";
const SORTS: [Sort, string][] = [
  ["recent", "Recently added"],
  ["az", "A–Z"],
  ["length", "Length"],
  ["size", "Size"],
];

/** The library: one menu (All videos, Movies, TV shows), sorting, a Recently added row, and shows grouped into seasons. */
export function Library(props: {
  onPick: (item: MediaItem) => void;
  actionLabel: string;
  /** Plays these one after another (a season, a whole show, or a show from one episode on). */
  onBinge?: (ids: string[]) => void;
  /** Keep the menu, show, season, search, open details and scroll position through a page refresh, under this name. */
  remember?: string;
}) {
  const saved = useMemo(() => loadPlace(props.remember), []);
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [convert, setConvert] = useState(true);
  const [query, setQuery] = useState(saved.query ?? "");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(saved.view ?? "all");
  const [sort, setSort] = useState<Sort>(saved.sort ?? "az");
  const [subsOnly, setSubsOnly] = useState(saved.subsOnly ?? false);
  const [showName, setShowName] = useState<string | null>(saved.showName ?? null);
  const [season, setSeason] = useState<number | null>(saved.season ?? null);
  const [openExtras, setOpenExtras] = useState<string | null>(null);
  // TMDB details are on: posters, summaries and the Details window with Fix match.
  const [details, setDetails] = useState(false);
  const [shownInfo, setShownInfo] = useState<string | null>(saved.shownInfo ?? null);
  // The Details window opens straight on Fix match (from a show's ⋮ menu).
  const [fixFirst, setFixFirst] = useState(false);
  const showInfo = (id: string | null, fix = false) => {
    setFixFirst(fix);
    setShownInfo(id);
  };

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

  // Remember where the host is, so a refresh lands in the same place.
  const scroller = useRef<HTMLDivElement>(null);
  const place: Place = { view, sort, subsOnly, showName, season, query, shownInfo };
  useEffect(() => savePlace(props.remember, place), [props.remember, view, sort, subsOnly, showName, season, query, shownInfo]);
  useEffect(() => {
    if (!props.remember) return;
    const onLeave = () => savePlace(props.remember, { ...place, scroll: scroller.current?.scrollTop ?? 0, pageScroll: window.scrollY });
    window.addEventListener("pagehide", onLeave);
    return () => window.removeEventListener("pagehide", onLeave);
  });
  const restored = useRef(false);
  useEffect(() => {
    if (!items || restored.current) return;
    restored.current = true;
    requestAnimationFrame(() => {
      if (saved.scroll && scroller.current) scroller.current.scrollTop = saved.scroll;
      if (saved.pageScroll) window.scrollTo(0, saved.pageScroll);
    });
  }, [items]);

  const q = query.trim().toLowerCase();
  const matches = (i: MediaItem) => !q || i.title.toLowerCase().includes(q) || i.relPath.toLowerCase().includes(q);

  const owned = isOwnedExtra;
  const laterPart = isLaterPart;
  const pick = (item: MediaItem) => (item.part && props.onBinge ? props.onBinge(item.part.ids) : props.onPick(item));
  const { movieExtras, byId, shows } = useMemo(() => buildCatalog(items ?? []), [items]);
  // A show's extras, by its name.
  const showExtras = useMemo(() => new Map(shows.filter((s) => s.extras.length > 0).map((s) => [s.name, s.extras])), [shows]);

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
      {[
        item.extra && `${item.extra.kind}${q && (item.extra.of || item.extra.show) ? ` · ${byId.get(item.extra.of ?? "")?.title ?? item.extra.show}` : ""}`,
        item.part ? partsLabel(item) : item.duration ? fmtLength(item.duration) : "",
        item.subtitles.length > 0 && "CC",
      ]
        .filter(Boolean)
        .join(" · ")}
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
    ...(shows.length > 0 ? [["shows", "TV Shows", shows.length] as [View, string, number]] : []),
  ];

  const extraRow = (e: MediaItem) => (
    <li key={e.id} className="row-line">
      <button className="item" onClick={() => showInfo(e.id)}>
        <span className="title">{e.title}</span>
        <span className="meta">{meta(e)}</span>
      </button>
      <StartButton label={props.actionLabel} onClick={() => props.onPick(e)} />
    </li>
  );

  const episodeRow = (e: MediaItem) => (
    <li key={e.id} className="row-line">
      <button className={details ? "item episode has-still" : "item episode"} onClick={() => showInfo(e.id)}>
        <span className="num">E{e.episode!.episode}</span>
        {details && <Poster path={e.meta?.stillPath} size="w300" className="still" />}
        <span className="title">{e.episode!.title ?? `Episode ${e.episode!.episode}`}</span>
        {details && e.meta?.overview && <span className="overview">{e.meta.overview}</span>}
        <span className="meta">{meta(e)}</span>
      </button>
      <StartButton label={props.actionLabel} onClick={() => props.onPick(e)} />
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
            <div className="browse-main" ref={scroller}>
              {!q && sort !== "recent" && recent.length > 2 && (
                <section>
                  <h3 className="shelf-title">Recently added</h3>
                  <Shelf>
                    {recent.map((item) => (
                      <button key={item.id} className={details ? "tile has-poster" : "tile"} onClick={() => showInfo(item.id)}>
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
                      <button className={details ? "item has-poster" : "item"} onClick={() => showInfo(r.item.id)}>
                        {details && <Poster path={r.item.meta?.posterPath} size="w92" />}
                        <span className="title">
                          {r.item.title}
                          {r.item.year && <span className="year"> {r.item.year}</span>}
                        </span>
                        <span className="meta">{meta(r.item)}</span>
                      </button>
                      <StartButton label={props.actionLabel} onClick={() => pick(r.item)} />
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
                          TV show · {r.show.seasons.length ? `${plural(r.show.seasons.length, "season")} · ` : ""}{plural(r.show.episodes.length, "episode")}
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
            <div className="browse-main" ref={scroller}>
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
                      {s.seasons.length ? `${plural(s.seasons.length, "season")} · ` : ""}{plural(s.episodes.length, "episode")}
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
                      </div>
                      <MoreMenu label={`More for ${show.name}`} items={[[show.episodes[0].meta ? "Fix match" : "Find show details", () => showInfo(show.episodes[0].id, true)]]} />
                    </div>
                  ) : (
                    <h3 className="shelf-title">{show.name}</h3>
                  )}
                  {(show.seasons.length > 1 || showExtras.has(show.name) || props.onBinge) && (
                    <div className="sortbar">
                      {(show.seasons.length > 1 || showExtras.has(show.name)) &&
                        show.seasons.map((n) => (
                          <button key={n} className={n === shownSeason ? "chip on" : "chip"} aria-pressed={n === shownSeason} onClick={() => setSeason(n)}>
                            Season {n}
                          </button>
                        ))}
                      {showExtras.has(show.name) && (
                        <button className={shownSeason === EXTRAS ? "chip on" : "chip"} aria-pressed={shownSeason === EXTRAS} onClick={() => setSeason(EXTRAS)}>
                          Extras
                        </button>
                      )}
                      {props.onBinge && shownSeason !== EXTRAS && (
                        <span className="binge-actions">
                          <button className="binge-link" onClick={() => props.onBinge!(show.episodes.filter((e) => e.episode!.season === shownSeason).map((e) => e.id))}>
                            <ListVideoIcon size={15} />
                            Binge season {shownSeason}
                          </button>
                          {show.seasons.length > 1 && (
                            <button className="binge-link" onClick={() => props.onBinge!(show.episodes.map((e) => e.id))}>
                              Binge all {show.seasons.length} seasons
                            </button>
                          )}
                        </span>
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
          startFixing={fixFirst}
          canMatch={details}
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
export function Poster(props: { path?: string | null; size: "w92" | "w185" | "w342" | "w300" | "w780" | "w1280"; className?: string }) {
  const [failed, setFailed] = useState(false);
  const cls = props.className ?? "poster";
  if (!props.path || failed) return <span className={`${cls} empty`} aria-hidden="true" />;
  return <img className={cls} src={imageUrl(props.path, props.size)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** The row's own Start party (or Play) button, so clicking the row itself only opens its details. */
export function StartButton(props: { label: string; onClick: () => void }) {
  return (
    <button className="row-start" onClick={props.onClick}>
      {props.label}
    </button>
  );
}

interface Place {
  view?: View;
  sort?: Sort;
  subsOnly?: boolean;
  showName?: string | null;
  season?: number | null;
  query?: string;
  shownInfo?: string | null;
  scroll?: number;
  pageScroll?: number;
}

// Session storage: survives a refresh of this tab, not a new visit. It can be unavailable (private windows), so failures are ignored.
function loadPlace(key: string | undefined): Place {
  if (!key) return {};
  try {
    return JSON.parse(sessionStorage.getItem(`place:${key}`) ?? "{}") as Place;
  } catch {
    return {};
  }
}

function savePlace(key: string | undefined, place: Place) {
  if (!key) return;
  try {
    sessionStorage.setItem(`place:${key}`, JSON.stringify(place));
  } catch {
    // Ignore: remembering the place is a convenience.
  }
}

/** A movie's or episode's TMDB details, with Fix match for when the server picked the wrong one. */
export function Details(props: {
  item: MediaItem;
  /** Open on the Fix match search. */
  startFixing?: boolean;
  /** Open on Set skip times. */
  startTiming?: boolean;
  /** TMDB lookups are on, so Fix match and the TMDB credit apply. */
  canMatch: boolean;
  actionLabel: string;
  lengthLabel: ReactNode;
  onPick: () => void;
  /** For an episode: play it and every episode after it. */
  onBingeFrom?: () => void;
  /** In a party, for the host: add it to Up next ([queued] once it's there). */
  onQueue?: () => void;
  queued?: boolean;
  onMatched: (r: LibraryResponse) => void;
  onClose: () => void;
}) {
  const { item } = props;
  const m = item.meta;
  const kind = item.episode ? "tv" : "movie";
  const [fixing, setFixing] = useState(!!props.startFixing);
  const [timing, setTiming] = useState(!!props.startTiming);
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
        {!fixing && !timing && (
          <MoreMenu
            label="More"
            items={[
              ...(props.canMatch ? [[m ? "Fix match" : "Find details", () => setFixing(true)] as [string, () => void]] : []),
              ["Set skip times", () => setTiming(true)],
            ]}
          />
        )}
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
            {m?.overview ? <p className="overview">{m.overview}</p> : !fixing && props.canMatch && <p className="muted">No summary.</p>}
            <div className="details-actions">
              <button className="primary" onClick={props.onPick}>
                {props.actionLabel}
              </button>
              {props.onQueue && (props.queued ? <span className="queued">In Up next</span> : <button onClick={props.onQueue}>Add to Up next</button>)}
              {props.onBingeFrom && <button onClick={props.onBingeFrom}>Binge from here</button>}
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
        {timing && <SkipTimesForm item={item} onDone={() => setTiming(false)} />}
        {props.canMatch && <p className="credit">Details and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>}
      </div>
    </div>
  );
}

/** "1:23", "1:02:03" or "83.5" as seconds; "" as null (none); undefined when it isn't a time. */
export function parseClock(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d+)?$|^\d+:\d{1,2}(\.\d+)?$|^\d+:\d{1,2}:\d{1,2}(\.\d+)?$/.test(t)) return undefined;
  return t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
}

/** Seconds as "1:02:03", with tenths when there are any ("20:16.3"), so a time saved as shown stays the same. */
const clock = (s: number | null | undefined) => {
  if (s == null) return "";
  const tenths = Math.round(s * 10) % 10;
  return fmtLength(Math.floor(Math.round(s * 10) / 10)) + (tenths ? `.${tenths}` : "");
};

/**
 * Set skip times: the intro, recap and credits as the host wants them, kept over what the server found (looking
 * again never replaces them), or back to what it found.
 */
function SkipTimesForm(props: { item: MediaItem; onDone: () => void }) {
  const [times, setTimes] = useState<SkipTimes | null>(null);
  const [fields, setFields] = useState({ introStart: "", introEnd: "", recapStart: "", recapEnd: "", credits: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const show = (t: SkipTimes) => {
    setTimes(t);
    const now = { ...t.found, ...(t.set ?? {}) };
    setFields({ introStart: clock(now.intro?.start), introEnd: clock(now.intro?.end), recapStart: clock(now.recap?.start), recapEnd: clock(now.recap?.end), credits: clock(now.credits) });
  };
  useEffect(() => {
    api.skipTimes(props.item.id).then(show, (err) => setError(err.message));
  }, [props.item.id]);

  const done = (p: Promise<SkipTimes>) => {
    setBusy(true);
    setError(null);
    p.then(
      (t) => {
        show(t);
        setBusy(false);
        setSaved(true);
      },
      (err) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const range = (name: string, a: string, b: string) => {
      const [start, end] = [parseClock(a), parseClock(b)];
      if (start === undefined || end === undefined) throw new Error(`${name}: write times like 1:23 or 1:02:03.`);
      if (start == null && end == null) return null;
      if (start == null || end == null || end <= start) throw new Error(`${name}: give a start and an end after it, or leave both blank.`);
      return { start, end };
    };
    try {
      const credits = parseClock(fields.credits);
      if (credits === undefined) throw new Error("Credits: write a time like 41:30.");
      // Only what differs from what was found is set by hand; the rest is still found (and found again on a rescan).
      const wanted: SkipMarks = { intro: range("Intro", fields.introStart, fields.introEnd), recap: range("Recap", fields.recapStart, fields.recapEnd), credits };
      const found = times?.found ?? {};
      const same = (a: TimeRange | number | null | undefined, b: TimeRange | number | null | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
      const set: SkipMarks = {};
      for (const kind of ["intro", "recap", "credits"] as const) if (!same(wanted[kind], found[kind])) (set as Record<string, unknown>)[kind] = wanted[kind];
      done(Object.keys(set).length ? api.setSkipTimes(props.item.id, set) : api.clearSkipTimes(props.item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const field = (key: keyof typeof fields, label: string) => (
    <input
      value={fields[key]}
      inputMode="decimal"
      placeholder="–"
      aria-label={label}
      onChange={(e) => {
        setFields({ ...fields, [key]: e.target.value });
        setSaved(false);
      }}
    />
  );
  const found = times?.found;
  const foundLine = found && [found.intro && `intro ${clock(found.intro.start)}–${clock(found.intro.end)}`, found.recap && `recap ${clock(found.recap.start)}–${clock(found.recap.end)}`, found.credits != null && `credits ${clock(found.credits)}`].filter(Boolean).join(" · ");
  return (
    <form className="skip-times" onSubmit={save}>
      <h3>Skip times</h3>
      <p className="muted small">
        {times ? (foundLine ? `Found by the server: ${foundLine}.` : "The server hasn't found any.") : "Loading…"} {times?.set && "These are set by hand and stay through rescans."}
      </p>
      <div className="skip-rows">
        <span>Intro</span>
        {field("introStart", "Intro starts")}
        <span>to</span>
        {field("introEnd", "Intro ends")}
        <span>Recap</span>
        {field("recapStart", "Recap starts")}
        <span>to</span>
        {field("recapEnd", "Recap ends")}
        <span>Credits</span>
        {field("credits", "Credits start")}
      </div>
      <p className="muted small">Leave times blank for none. Parties pick up changes from the next video they play.</p>
      {error && <p className="error">{error}</p>}
      <div className="details-actions">
        <button className="primary" disabled={busy || !times}>
          {saved ? "Saved" : "Save"}
        </button>
        {times?.set && (
          <button type="button" disabled={busy} onClick={() => done(api.clearSkipTimes(props.item.id))}>
            Use found times
          </button>
        )}
        <button type="button" onClick={props.onDone}>
          Done
        </button>
      </div>
    </form>
  );
}

/** A ⋮ button in the top-right corner with a small menu, for things that shouldn't take up room. */
/** null in [items] draws a line between groups. */
export function MoreMenu(props: { label: string; items: ([string, () => void] | null)[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  return (
    <div className="more-menu" ref={ref}>
      <button className="more-button" aria-label={props.label} title={props.label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon size={20} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {props.items.map((item, i) => {
            if (!item) return <hr key={i} />;
            const [label, run] = item;
            return (
            <button
              key={label}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                run();
              }}
            >
              {label}
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The Extras tab next to a show's seasons. */
const EXTRAS = -1;


/** A row of cards with no scrollbar: arrow buttons page through it when it doesn't all fit. Swiping still works. */
export function Shelf(props: { children: ReactNode; className?: string }) {
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
      <div className={props.className ? `shelf ${props.className}` : "shelf"} ref={ref} onScroll={update}>
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
