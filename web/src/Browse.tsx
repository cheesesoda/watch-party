import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MediaItem, Spot } from "../../shared/protocol.ts";
import { imageUrl } from "./api.ts";
import { byName, fmtRuntime, partsLength, plural, type Catalog, type Show } from "./catalog.ts";
import { CheckIcon, InfoIcon, ListPlusIcon, ListVideoIcon, PlayIcon } from "./Icons.tsx";
import { BROWSER_SAFE, fmtSize, MoreMenu, Poster, Shelf } from "./Library.tsx";
import { navigate } from "./nav.ts";
import { SpotLine } from "./Spots.tsx";

/** What every page needs: the grouped library, and how to start a party or open the Details window. */
export interface Browse {
  cat: Catalog;
  /** TMDB lookups are on: posters, backdrops, summaries and Fix match. */
  details: boolean;
  /** The server converts what browsers can't play, so there's nothing to warn about. */
  convert: boolean;
  /** Starts a party with these videos, one after another. */
  start: (ids: string[]) => void;
  /** The Details window, for episodes and extras, or straight on Fix match. */
  openInfo: (id: string, fix?: boolean) => void;
  /** Goes to a movie or show page; the dashboard changes the address, the in-party picker its own view. */
  open?: (path: string) => void;
  /** The play buttons' name: "Start party" on the dashboard ("Play" while watching alone), "Play for everyone" in a party. */
  startLabel?: string;
  /** Titles on the posters rather than under them, for the in-party picker. */
  compact?: boolean;
  /** In a party, for the host: what's coming up, and adding videos to the end of Up next ([label] names them). */
  queue?: { has: (id: string) => boolean; add: (ids: string[], label: string) => void };
  /** On the dashboard: the show's saved spot (Pick up where you left off), and starting a party there. */
  spot?: { of: (show: Show) => Spot | undefined; start: (s: Spot) => void };
}

const go = (b: Browse, path: string) => (b.open ?? navigate)(path);
const startLabel = (b: Browse) => b.startLabel ?? "Start party";

export const movieLink = (item: MediaItem) => `/movie/${item.id}`;
export const showLink = (show: Show) => `/show/${encodeURIComponent(show.key)}`;
/** A movie in several files plays all of them. */
const playIds = (item: MediaItem) => item.part?.ids ?? [item.id];

/** "2015 · 2 h 0 m · ★ 7.6 · Action, Adventure · Subtitles" */
function movieFacts(item: MediaItem, cat: Catalog): string[] {
  const length = partsLength(item, cat.byId);
  return [
    String(item.meta?.year ?? item.year ?? ""),
    item.part ? `${item.part.ids.length} parts${length ? `, ${fmtRuntime(length)}` : ""}` : length ? fmtRuntime(length) : fmtSize(item.size),
    item.meta?.rating ? `★ ${item.meta.rating.toFixed(1)}` : "",
    (item.meta?.genres ?? []).slice(0, 3).join(", "),
    item.subtitles.length > 0 ? "Subtitles" : "",
  ].filter(Boolean);
}

function showFacts(show: Show): string[] {
  return [
    String(show.meta?.year ?? ""),
    plural(show.seasons.length, "season"),
    show.specials.length ? plural(show.specials.length, "special") : "",
    show.meta?.rating ? `★ ${show.meta.rating.toFixed(1)}` : "",
    (show.meta?.genres ?? []).slice(0, 3).join(", "),
  ].filter(Boolean);
}

/**
 * A 2:3 poster with the title under it. Without a poster, the title sits on a plain card. In the compact in-party picker
 * ([overlay]) the title and year sit on every poster instead, with nothing under it. The play button starts a party.
 */
export function PosterCard(props: {
  title: string;
  year?: number | string | null;
  sub?: string;
  poster?: string | null;
  badge?: string;
  details: boolean;
  overlay?: boolean;
  onOpen: () => void;
  onStart?: () => void;
  startLabel?: string;
  /** Adds it to Up next; [queued] when it's already there. */
  onQueue?: () => void;
  queued?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const art = props.details && props.poster && !failed;
  return (
    <div className={props.overlay ? "pcard-poster overlay" : "pcard-poster"}>
      <button className="pcard-open" onClick={props.onOpen}>
        <span className="pcard-art">
          {art && <img src={imageUrl(props.poster!, "w342")} alt="" loading="lazy" onError={() => setFailed(true)} />}
          {props.overlay ? (
            <span className="pcard-over">
              {props.title}
              {props.year ? <span className="year"> {props.year}</span> : null}
            </span>
          ) : (
            !art && <span className="pcard-fallback">{props.title}</span>
          )}
          {props.badge && <span className="pcard-badge">{props.badge}</span>}
          {props.queued && (
            <span className="pcard-queued">
              <CheckIcon size={12} /> Up next
            </span>
          )}
        </span>
        {!props.overlay && <span className="pcard-title">{props.title}</span>}
        {!props.overlay && props.sub && <span className="pcard-sub">{props.sub}</span>}
      </button>
      {props.onQueue && !props.queued && (
        <button className="pcard-queue" onClick={props.onQueue} title="Add to Up next" aria-label={`Add to Up next: ${props.title}`}>
          <ListPlusIcon size={18} />
        </button>
      )}
      {props.onStart && (
        <button className="pcard-start" onClick={props.onStart} title={props.startLabel ?? "Start party"} aria-label={`${props.startLabel ?? "Start party"}: ${props.title}`}>
          <PlayIcon size={18} />
        </button>
      )}
    </div>
  );
}

export function MovieCard(props: { item: MediaItem; b: Browse }) {
  const { item, b } = props;
  return (
    <PosterCard
      title={item.meta?.title ?? item.title}
      year={item.meta?.year ?? item.year}
      sub={String(item.meta?.year ?? item.year ?? "") || undefined}
      poster={item.meta?.posterPath}
      details={b.details}
      overlay={b.compact}
      onOpen={() => go(b, movieLink(item))}
      onStart={() => b.start(playIds(item))}
      startLabel={startLabel(b)}
      onQueue={b.queue && (() => b.queue!.add(playIds(item), item.meta?.title ?? item.title))}
      queued={b.queue?.has(playIds(item)[0])}
    />
  );
}

export function ShowCard(props: { show: Show; b: Browse }) {
  const { show } = props;
  return (
    <PosterCard
      title={show.name}
      year={show.meta?.year}
      sub={plural(show.episodes.length, "episode")}
      poster={show.meta?.showPosterPath}
      badge={plural(show.seasons.length, "season")}
      details={props.b.details}
      overlay={props.b.compact}
      onOpen={() => go(props.b, showLink(show))}
    />
  );
}

/** A titled row of posters with See all, paged with arrows. */
export function PosterRow(props: { title: string; seeAll?: string; children: ReactNode }) {
  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h2>{props.title}</h2>
        {props.seeAll && (
          <button className="see-all" onClick={() => navigate(props.seeAll!)}>
            See all
          </button>
        )}
      </div>
      <Shelf className="poster-shelf">{props.children}</Shelf>
    </section>
  );
}

type Featured = { key: string; title: string; facts: string[]; backdrop: string; link: string; start?: () => void };

/** The big backdrop at the top of Home: the newest movies and shows that have background art, taking turns. */
export function Banner(props: { b: Browse }) {
  const { cat } = props.b;
  const picks = useMemo<Featured[]>(() => {
    const movies = cat.movies
      .filter((m) => m.meta?.backdropPath && !m.extra)
      .map((m) => ({ at: m.addedAt ?? 0, f: { key: m.id, title: m.meta!.title, facts: movieFacts(m, cat), backdrop: m.meta!.backdropPath!, link: movieLink(m), start: () => props.b.start(playIds(m)) } }));
    const shows = cat.shows
      .filter((s) => s.meta?.backdropPath)
      .map((s) => ({ at: s.addedAt, f: { key: s.key, title: s.name, facts: showFacts(s), backdrop: s.meta!.backdropPath!, link: showLink(s) } }));
    return [...movies, ...shows]
      .sort((a, b) => b.at - a.at)
      .slice(0, 5)
      .map((x) => x.f);
  }, [cat]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || picks.length < 2 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % picks.length), 8000);
    return () => clearTimeout(t);
  }, [index, paused, picks.length]);

  if (!props.b.details || picks.length === 0) return null;
  const shown = picks[index % picks.length];
  return (
    <section className="banner" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      {picks.map((p, i) => (
        <img key={p.key} className={i === index % picks.length ? "banner-art on" : "banner-art"} src={imageUrl(p.backdrop, "w1280")} alt="" />
      ))}
      <div className="banner-text">
        <p className="eyebrow">New in your library</p>
        <h1>{shown.title}</h1>
        <p className="facts">{shown.facts.join(" · ")}</p>
        <div className="banner-actions">
          {shown.start ? (
            <button className="pill primary" onClick={shown.start}>
              <PlayIcon size={18} /> {startLabel(props.b)}
            </button>
          ) : null}
          <button className="pill tonal" onClick={() => navigate(shown.link)}>
            <InfoIcon size={18} /> {shown.start ? "Details" : "Episodes"}
          </button>
          {picks.length > 1 && (
            <span className="dots">
              {picks.map((p, i) => (
                <button key={p.key} className={i === index % picks.length ? "on" : ""} aria-label={`Show ${p.title}`} aria-current={i === index % picks.length} onClick={() => setIndex(i)} />
              ))}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Home's rows: newest first, then every movie and show. */
export function HomeRows(props: { b: Browse }) {
  const { cat } = props.b;
  const recent = useMemo(() => {
    const movies = cat.movies.filter((m) => !m.extra).map((m) => ({ at: m.addedAt ?? 0, node: <MovieCard key={m.id} item={m} b={props.b} /> }));
    const shows = cat.shows.map((s) => ({ at: s.addedAt, node: <ShowCard key={s.key} show={s} b={props.b} /> }));
    return [...movies, ...shows].sort((a, b) => b.at - a.at).slice(0, 16);
  }, [cat, props.b]);
  const movies = cat.movies.filter((m) => !m.extra).sort((a, b) => byName(a.title, b.title));
  return (
    <>
      {recent.length > 0 && <PosterRow title="Recently added">{recent.map((r) => r.node)}</PosterRow>}
      {movies.length > 0 && (
        <PosterRow title="Movies" seeAll="/movies">
          {movies.slice(0, 24).map((m) => (
            <MovieCard key={m.id} item={m} b={props.b} />
          ))}
        </PosterRow>
      )}
      {cat.shows.length > 0 && (
        <PosterRow title="TV shows" seeAll="/shows">
          {cat.shows.slice(0, 24).map((s) => (
            <ShowCard key={s.key} show={s} b={props.b} />
          ))}
        </PosterRow>
      )}
    </>
  );
}

type Sort = "recent" | "az" | "length" | "size";
const SORTS: [Sort, string][] = [
  ["recent", "Recently added"],
  ["az", "A–Z"],
  ["length", "Length"],
  ["size", "Size"],
];

/** Movies: every one as a poster, sorted the way the host picks (remembered). */
export function MoviesPage(props: { b: Browse; subtitlesOnly?: boolean }) {
  const { cat } = props.b;
  const [sort, setSort] = useState<Sort>(() => (readPref("sort") as Sort) ?? "az");
  useEffect(() => writePref("sort", sort), [sort]);
  const movies = useMemo(() => {
    const list = cat.movies.filter((m) => !props.subtitlesOnly || m.subtitles.length > 0);
    const length = (m: MediaItem) => partsLength(m, cat.byId) ?? -1;
    const cmp: Record<Sort, (a: MediaItem, b: MediaItem) => number> = {
      az: (a, b) => byName(a.title, b.title),
      recent: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || byName(a.title, b.title),
      length: (a, b) => length(b) - length(a) || byName(a.title, b.title),
      size: (a, b) => b.size - a.size,
    };
    return list.sort(cmp[sort]);
  }, [cat, sort, props.subtitlesOnly]);
  const shows = props.subtitlesOnly ? cat.shows.filter((s) => s.episodes.some((e) => e.subtitles.length > 0)) : [];

  return (
    <>
      <div className="page-head">
        <h1>{props.subtitlesOnly ? "Has subtitles" : "Movies"}</h1>
        <span className="count">{props.subtitlesOnly ? plural(movies.length + shows.length, "title") : movies.length}</span>
        <span className="spacer" />
        <div className="chips" role="group" aria-label="Sort">
          {SORTS.map(([s, label]) => (
            <button key={s} className={sort === s ? "chip on" : "chip"} aria-pressed={sort === s} onClick={() => setSort(s)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {props.subtitlesOnly && <p className="muted page-note">Videos with a matching .srt or .vtt file next to them.</p>}
      {movies.length === 0 && shows.length === 0 && <p className="muted">{props.subtitlesOnly ? "Nothing has subtitles yet." : "No movies yet."}</p>}
      {props.subtitlesOnly && movies.length > 0 && shows.length > 0 && <h2 className="grid-title">Movies</h2>}
      <div className="poster-grid">
        {movies.map((m) => (
          <MovieCard key={m.id} item={m} b={props.b} />
        ))}
      </div>
      {shows.length > 0 && (
        <>
          <h2 className="grid-title">TV shows</h2>
          <div className="poster-grid">
            {shows.map((s) => (
              <ShowCard key={s.key} show={s} b={props.b} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ShowsPage(props: { b: Browse }) {
  const { shows } = props.b.cat;
  return (
    <>
      <div className="page-head">
        <h1>TV shows</h1>
        <span className="count">{shows.length}</span>
      </div>
      {shows.length === 0 && <p className="muted">No TV shows yet. Episodes named like "Show S01E02" are grouped here.</p>}
      <div className="poster-grid">
        {shows.map((s) => (
          <ShowCard key={s.key} show={s} b={props.b} />
        ))}
      </div>
    </>
  );
}

/** The wide background art behind a details page, fading into the page. */
function Backdrop(props: { path?: string | null; details: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!props.details || !props.path || failed) return <div className="hero-art empty" />;
  return <img className="hero-art" src={imageUrl(props.path, "w1280")} alt="" onError={() => setFailed(true)} />;
}

/** A movie's page: backdrop, poster, facts, summary, Start party, and its extras. */
export function MoviePage(props: { b: Browse; item: MediaItem }) {
  const { b, item } = props;
  const m = item.meta;
  const extras = b.cat.movieExtras.get(item.id) ?? [];
  return (
    <div className="hero-page">
      <Backdrop path={m?.backdropPath} details={b.details} />
      <div className="hero">
        {b.details && <Poster path={m?.posterPath} size="w342" className="hero-poster" />}
        <div className="hero-text">
          <h1>{m?.title ?? item.title}</h1>
          <p className="facts">{movieFacts(item, b.cat).join(" · ")}</p>
          {!b.convert && !BROWSER_SAFE.has(item.mime) && (
            <p className="warn">Browsers may not play this format as-is. Install ffmpeg on the server so it can convert it.</p>
          )}
          {m?.overview && <p className="overview">{m.overview}</p>}
          <div className="hero-actions">
            <button className="pill primary" onClick={() => b.start(playIds(item))}>
              <PlayIcon size={18} /> {startLabel(b)}
            </button>
            {b.queue && <QueueButton b={b} ids={playIds(item)} label={m?.title ?? item.title} />}
            {b.details && <MoreMenu label={`More for ${item.title}`} items={[[m ? "Fix match" : "Find movie details", () => b.openInfo(item.id, true)]]} />}
          </div>
        </div>
      </div>
      {extras.length > 0 && (
        <section className="dash-section">
          <h2>Extras</h2>
          <ul className="ep-list">{extras.map((e) => <EpisodeRow key={e.id} item={e} b={b} />)}</ul>
        </section>
      )}
      {b.details && <Credit />}
    </div>
  );
}

/** The Extras tab after a show's seasons, and the Specials tab (season 0) before it. */
const EXTRAS = -1;
const SPECIALS = -2;

/** A show's page: backdrop, poster, facts, binge buttons, season chips and the season's episodes. */
export function ShowPage(props: { b: Browse; show: Show }) {
  const { b, show } = props;
  const m = show.meta;
  const tabs = [...show.seasons, ...(show.specials.length ? [SPECIALS] : []), ...(show.extras.length ? [EXTRAS] : [])];
  const remembered = Number(readPref(`season:${show.key}`));
  const [season, setSeason] = useState(() => (tabs.includes(remembered) ? remembered : tabs[0]));
  useEffect(() => writePref(`season:${show.key}`, String(season)), [show.key, season]);
  // A season's list has the specials that aired during it, where they aired.
  const inSeason = (n: number) => (n === SPECIALS ? show.specials : (show.bySeason.get(n) ?? []));
  const binge = season === EXTRAS ? tabs[0] : season;
  const bingeName = binge === SPECIALS ? "specials" : `season ${binge}`;
  const spot = b.spot?.of(show);

  return (
    <div className="hero-page">
      <Backdrop path={m?.backdropPath} details={b.details} />
      <div className="hero">
        {b.details && <Poster path={m?.showPosterPath} size="w342" className="hero-poster" />}
        <div className="hero-text">
          <h1>{show.name}</h1>
          <p className="facts">{showFacts(show).join(" · ")}</p>
          {m?.showOverview && <p className="overview">{m.showOverview}</p>}
          {spot && <SpotLine spot={spot} details={b.details} />}
          <div className="hero-actions">
            {spot && (
              <button className="pill primary" onClick={() => b.spot!.start(spot)}>
                <PlayIcon size={18} /> Continue binge
              </button>
            )}
            {binge !== EXTRAS && (
              <button className={spot ? "pill tonal" : "pill primary"} onClick={() => b.start(inSeason(binge).map((e) => e.id))}>
                <PlayIcon size={18} /> Binge {bingeName}
              </button>
            )}
            {b.queue && binge !== EXTRAS && (
              <button className="pill tonal" onClick={() => b.queue!.add(inSeason(binge).map((e) => e.id), `${show.name} ${bingeName}`)}>
                <ListPlusIcon size={18} /> Add {bingeName} to Up next
              </button>
            )}
            {show.seasons.length > 1 && (
              <button className={b.queue ? "pill text" : "pill tonal"} onClick={() => b.start(show.episodes.map((e) => e.id))}>
                <ListVideoIcon size={18} /> Binge all {show.seasons.length} seasons
              </button>
            )}
            {b.details && <MoreMenu label={`More for ${show.name}`} items={[[m ? "Fix match" : "Find show details", () => b.openInfo(show.episodes[0].id, true)]]} />}
          </div>
        </div>
      </div>
      {tabs.length > 1 && (
        <div className="chips seasons">
          {tabs.map((n) => (
            <button key={n} className={n === season ? "chip on" : "chip"} aria-pressed={n === season} onClick={() => setSeason(n)}>
              {n === SPECIALS ? "Specials" : n === EXTRAS ? "Extras" : `Season ${n}`}
            </button>
          ))}
        </div>
      )}
      <ul className="ep-list">
        {(season === EXTRAS ? show.extras : inSeason(season)).map((e) => (
          <EpisodeRow key={e.id} item={e} b={b} special={season !== SPECIALS && e.episode?.season === 0} />
        ))}
      </ul>
      {b.details && <Credit />}
    </div>
  );
}

/** An episode or extra: its still, "3. Title", length, summary and its own Start party. Clicking the row opens its details. */
export function EpisodeRow(props: { item: MediaItem; b: Browse; context?: string; playing?: boolean; special?: boolean }) {
  const { item, b } = props;
  const ep = item.episode;
  // A special in a season's list: a "Special" tag instead of its number.
  const title = !ep ? item.title : props.special ? (ep.title ?? `Special ${ep.episode}`) : `${ep.episode}. ${ep.title ?? `Episode ${ep.episode}`}`;
  const facts = [
    props.context,
    item.extra?.kind,
    item.duration ? fmtRuntime(item.duration) : fmtSize(item.size),
    item.subtitles.length > 0 ? "Subtitles" : "",
    !b.convert && !BROWSER_SAFE.has(item.mime) ? "may not play in browser" : "",
  ].filter(Boolean);
  return (
    <li className="ep-row">
      <button className="ep-open" onClick={() => b.openInfo(item.id)}>
        {b.details && ep ? <Poster path={item.meta?.stillPath} size="w300" className="ep-still" /> : <span className="ep-still empty">{ep ? `E${ep.episode}` : ""}</span>}
        <span className="ep-text">
          <span className="ep-title">
            {props.special && <span className="special-tag">Special</span>}
            {title}
          </span>
          <span className="ep-facts">{facts.join(" · ")}</span>
          {b.details && ep && item.meta?.overview && <span className="ep-overview">{item.meta.overview}</span>}
        </span>
      </button>
      {b.queue && !props.playing && <QueueButton b={b} ids={[item.id]} label={item.title} small />}
      {props.playing ? (
        <span className="ep-playing">Playing now</span>
      ) : (
        <button className="pill tonal small" onClick={() => b.start([item.id])}>
          <PlayIcon size={15} /> {startLabel(b)}
        </button>
      )}
    </li>
  );
}

/** Add to Up next, or "In Up next" once it's there. [small] is the round icon button on episode rows. */
function QueueButton(props: { b: Browse; ids: string[]; label: string; small?: boolean }) {
  const { queue } = props.b;
  if (!queue) return null;
  if (queue.has(props.ids[0]))
    return (
      <span className="queued">
        <CheckIcon size={16} /> In Up next
      </span>
    );
  return props.small ? (
    <button className="round-icon" onClick={() => queue.add(props.ids, props.label)} title="Add to Up next" aria-label={`Add to Up next: ${props.label}`}>
      <ListPlusIcon size={18} />
    </button>
  ) : (
    <button className="pill tonal" onClick={() => queue.add(props.ids, props.label)}>
      <ListPlusIcon size={18} /> Add to Up next
    </button>
  );
}

/** Search across titles and file names: movies and shows as posters, then matching episodes and extras. */
export function SearchResults(props: { b: Browse; query: string }) {
  const { cat } = props.b;
  const q = props.query.trim().toLowerCase();
  const hit = (i: MediaItem) => i.title.toLowerCase().includes(q) || i.relPath.toLowerCase().includes(q) || !!i.meta?.title.toLowerCase().includes(q);
  const movies = cat.movies.filter(hit);
  const shows = cat.shows.filter((s) => s.aliases.concat(s.name).some((n) => n.toLowerCase().includes(q)));
  const episodes = cat.shows.flatMap((s) => (shows.includes(s) ? [] : s.episodes.filter(hit).map((e) => ({ e, s }))));
  const extras = [...cat.movieExtras.values(), ...cat.shows.map((s) => s.extras)].flat().filter(hit);
  const none = movies.length + shows.length + episodes.length + extras.length === 0;
  return (
    <>
      <div className="page-head">
        <h1>Results for “{props.query.trim()}”</h1>
      </div>
      {none && <p className="muted">Nothing matches. Try part of the title or the file name.</p>}
      {(movies.length > 0 || shows.length > 0) && (
        <div className="poster-grid">
          {movies.map((m) => (
            <MovieCard key={m.id} item={m} b={props.b} />
          ))}
          {shows.map((s) => (
            <ShowCard key={s.key} show={s} b={props.b} />
          ))}
        </div>
      )}
      {episodes.length > 0 && (
        <section className="dash-section">
          <h2>Episodes</h2>
          <ul className="ep-list">
            {episodes.slice(0, 50).map(({ e, s }) => (
              <EpisodeRow key={e.id} item={e} b={props.b} context={`${s.name} · Season ${e.episode!.season}`} />
            ))}
          </ul>
        </section>
      )}
      {extras.length > 0 && (
        <section className="dash-section">
          <h2>Extras</h2>
          <ul className="ep-list">
            {extras.map((e) => (
              <EpisodeRow key={e.id} item={e} b={props.b} context={cat.byId.get(e.extra?.of ?? "")?.title ?? e.extra?.show ?? undefined} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Credit() {
  return <p className="credit">Details and images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>;
}

/** Remembered choices (sort, a show's season): kept across visits on this browser. Storage can be unavailable; that's fine. */
export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(`dash:${key}`);
  } catch {
    return null;
  }
}
export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(`dash:${key}`, value);
  } catch {
    // Remembering is a convenience.
  }
}
