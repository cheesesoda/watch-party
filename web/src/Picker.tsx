import { useEffect, useMemo, useState } from "react";
import type { Queue } from "../../shared/protocol.ts";
import { api, type LibraryResponse } from "./api.ts";
import { EpisodeRow, MovieCard, MoviePage, SearchResults, ShowCard, ShowPage, type Browse } from "./Browse.tsx";
import { buildCatalog } from "./catalog.ts";
import { BackIcon, CloseIcon, SearchIcon } from "./Icons.tsx";
import { Details, fmtLength, fmtSize } from "./Library.tsx";

type Tab = "binge" | "movies" | "shows";

/**
 * Change video, for the host in a party: the dashboard's posters and movie and show pages in one window, with
 * "Play for everyone" in place of Start party. Movies, TV shows and (during a binge) This binge, plus search.
 */
export function Picker(props: {
  queue: Queue | null;
  /** Which video of the binge is playing. */
  at: number;
  /** Plays these for everyone, one after another. */
  onPlay: (ids: string[]) => void;
  onClose: () => void;
}) {
  const { queue } = props;
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(queue ? "binge" : "movies");
  const [query, setQuery] = useState("");
  // A movie or show page opened from the posters, like the dashboard's #/movie/ID and #/show/KEY.
  const [page, setPage] = useState<string | null>(null);
  const [info, setInfo] = useState<{ id: string; fix: boolean } | null>(null);

  useEffect(() => {
    api.library().then(setLibrary, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !info && (page ? setPage(null) : props.onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info, page]);

  const cat = useMemo(() => buildCatalog(library?.items ?? []), [library]);
  const b: Browse = useMemo(
    () => ({
      cat,
      details: !!library?.details,
      convert: library?.convert ?? true,
      start: props.onPlay,
      openInfo: (id, fix = false) => setInfo({ id, fix }),
      open: (path) => {
        setQuery("");
        setPage(path);
      },
      startLabel: "Play for everyone",
      compact: true,
    }),
    [cat, library],
  );

  const movieId = page && /^\/movie\/([\w-]+)/.exec(page)?.[1];
  const showKey = page && /^\/show\/([^/]+)/.exec(page)?.[1];
  const movie = movieId ? cat.byId.get(movieId) : undefined;
  const show = showKey ? cat.shows.find((s) => s.key === decodeURIComponent(showKey)) : undefined;
  const infoItem = info ? cat.byId.get(info.id) : undefined;

  let body;
  if (error) body = <p className="error">{error}</p>;
  else if (!library) body = <p className="muted">Loading the library…</p>;
  else if (query.trim()) body = <SearchResults b={b} query={query} />;
  else if (movie) body = <MoviePage b={b} item={movie} />;
  else if (show) body = <ShowPage b={b} show={show} />;
  else if (tab === "binge" && queue)
    body = (
      <ul className="ep-list">
        {queue.items.map((item, i) => (
          <EpisodeRow key={item.id} item={cat.byId.get(item.id) ?? item} b={b} playing={i === props.at} context={item.part ? `Part ${item.part.index}` : undefined} />
        ))}
      </ul>
    );
  else if (tab === "shows")
    body =
      cat.shows.length === 0 ? (
        <p className="muted">No TV shows yet.</p>
      ) : (
        <div className="poster-grid">
          {cat.shows.map((s) => (
            <ShowCard key={s.key} show={s} b={b} />
          ))}
        </div>
      );
  else
    body =
      cat.movies.length === 0 ? (
        <p className="muted">No movies yet.</p>
      ) : (
        <div className="poster-grid">
          {cat.movies.map((m) => (
            <MovieCard key={m.id} item={m} b={b} />
          ))}
        </div>
      );

  const tabs: [Tab, string][] = [...(queue ? ([["binge", "This binge"]] as [Tab, string][]) : []), ["movies", "Movies"], ["shows", "TV shows"]];

  return (
    <>
      <div className="modal picker" onClick={props.onClose}>
        <div className="modal-body" onClick={(e) => e.stopPropagation()}>
          <div className="picker-head">
            {page && !query.trim() ? (
              <button className="icon" onClick={() => setPage(null)} title="Back" aria-label="Back">
                <BackIcon />
              </button>
            ) : null}
            <h2>Change video</h2>
            <label className="search picker-search">
              <SearchIcon size={18} />
              <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the library" />
            </label>
            <button className="icon" onClick={props.onClose} title="Close" aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          {!page && !query.trim() && (
            <div className="chips picker-tabs" role="tablist">
              {tabs.map(([t, label]) => (
                <button key={t} role="tab" className={tab === t ? "chip on" : "chip"} aria-selected={tab === t} onClick={() => setTab(t)}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="picker-body">{body}</div>
        </div>
      </div>
        {infoItem && (
          <Details
            key={infoItem.id + info!.fix}
            item={infoItem}
            startFixing={info!.fix}
            canMatch={b.details}
            actionLabel="Play for everyone"
            lengthLabel={[infoItem.duration ? fmtLength(infoItem.duration) : fmtSize(infoItem.size)].join(" · ")}
            onPick={() => {
              setInfo(null);
              props.onPlay(infoItem.part?.ids ?? [infoItem.id]);
            }}
            onBingeFrom={(() => {
              const s = infoItem.episode && cat.shows.find((x) => x.episodes.includes(infoItem));
              if (!s) return undefined;
              return () => {
                setInfo(null);
                props.onPlay(s.episodes.slice(s.episodes.indexOf(infoItem)).map((e) => e.id));
              };
            })()}
            onMatched={setLibrary}
            onClose={() => setInfo(null)}
          />
        )}
    </>
  );
}
