import { useEffect, useMemo, useRef, useState } from "react";
import { episodeLabel } from "../../shared/specials.ts";
import type { ClientMessage, MediaItem, Queue } from "../../shared/protocol.ts";
import { api, type LibraryResponse } from "./api.ts";
import { MovieCard, MoviePage, SearchResults, ShowCard, ShowPage, type Browse } from "./Browse.tsx";
import { buildCatalog, fmtRuntime } from "./catalog.ts";
import { BackIcon, CloseIcon, GripIcon, PlayIcon, SearchIcon, TrashIcon } from "./Icons.tsx";
import { Details, fmtLength, Poster } from "./Library.tsx";

type Tab = "next" | "movies" | "shows";

/**
 * Change video, for the host in a party: Up next, plus the dashboard's posters and movie and show pages in one window,
 * with "Play for everyone" in place of Start party and Add to Up next beside it. Without [edit] (guests), it shows just
 * Up next, read-only.
 */
export function Picker(props: {
  queue: Queue | null;
  /** The video playing now. */
  media: MediaItem | null;
  /** Plays these for everyone, one after another. */
  onPlay: (ids: string[]) => void;
  /** Sends Up next changes; the host only. */
  edit?: (msg: ClientMessage) => void;
  /** Who picks, for the guests' note ("Jake picks what plays"). */
  hostName?: string;
  /** The host watching alone: play buttons say Play rather than Play for everyone. */
  solo?: boolean;
  onClose: () => void;
}) {
  const { queue, media, edit } = props;
  const at = queue?.at ?? (queue && media ? queue.items.findIndex((i) => i.id === media.id) : -1);
  const upcoming = queue && at >= 0 ? queue.items.slice(at + 1) : [];
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(upcoming.length > 0 || !edit ? "next" : "movies");
  const [query, setQuery] = useState("");
  // A movie or show page opened from the posters, like the dashboard's #/movie/ID and #/show/KEY.
  const [page, setPage] = useState<string | null>(null);
  const [info, setInfo] = useState<{ id: string; fix: boolean } | null>(null);
  // "Added … to Up next", with Undo, for a few seconds.
  const [added, setAdded] = useState<{ ids: string[]; label: string } | null>(null);
  const addedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (edit) api.library().then(setLibrary, (e) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !info && (page ? setPage(null) : props.onClose());
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info, page]);
  useEffect(() => () => clearTimeout(addedTimer.current), []);

  const queuedIds = useMemo(() => new Set(upcoming.map((i) => i.id)), [queue, at]);
  const add = (ids: string[], label: string) => {
    edit?.({ type: "queue-add", mediaIds: ids });
    setAdded({ ids, label });
    clearTimeout(addedTimer.current);
    addedTimer.current = setTimeout(() => setAdded(null), 5000);
  };
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
      startLabel: props.solo ? "Play" : "Play for everyone",
      compact: true,
      queue: { has: (id) => queuedIds.has(id), add },
    }),
    [cat, library, queuedIds, props.solo],
  );

  const movieId = page && /^\/movie\/([\w-]+)/.exec(page)?.[1];
  const showKey = page && /^\/show\/([^/]+)/.exec(page)?.[1];
  const movie = movieId ? cat.byId.get(movieId) : undefined;
  const show = showKey ? cat.shows.find((s) => s.key === decodeURIComponent(showKey)) : undefined;
  const infoItem = info ? cat.byId.get(info.id) : undefined;

  const upNext = (
    <UpNextList
      media={media}
      upcoming={upcoming}
      details={library ? !!library.details : true}
      edit={edit}
      onPlay={(id) => props.onPlay([id])}
      note={
        edit ? (
          <>
            Add more from{" "}
            <button className="link" onClick={() => setTab("movies")}>
              Movies
            </button>{" "}
            or{" "}
            <button className="link" onClick={() => setTab("shows")}>
              TV Shows
            </button>
            , or with the Add to Up next button on any poster or episode.
          </>
        ) : (
          `${props.hostName ?? "The host"} picks what plays. Ask in chat to add something.`
        )
      }
    />
  );

  let body;
  if (!edit) body = upNext;
  else if (error) body = <p className="error">{error}</p>;
  else if (!library && tab !== "next") body = <p className="muted">Loading the library…</p>;
  else if (query.trim()) body = <SearchResults b={b} query={query} />;
  else if (movie) body = <MoviePage b={b} item={movie} />;
  else if (show) body = <ShowPage b={b} show={show} />;
  else if (tab === "next") body = upNext;
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

  const tabs: [Tab, string][] = [
    ["next", "Up next"],
    ["movies", "Movies"],
    ["shows", "TV Shows"],
  ];
  const browsing = !!edit && !page && !query.trim();

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
            <h2>{edit ? "Change video" : "Up next"}</h2>
            {edit && (
              <label className="search picker-search">
                <SearchIcon size={18} />
                <input type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the library" />
              </label>
            )}
            <button className="icon" onClick={props.onClose} title="Close" aria-label="Close">
              <CloseIcon />
            </button>
          </div>
          {browsing && (
            <div className="picker-tabs">
              <div className="chips" role="tablist">
                {tabs.map(([t, label]) => (
                  <button key={t} role="tab" className={tab === t ? "chip on" : "chip"} aria-selected={tab === t} onClick={() => setTab(t)}>
                    {label}
                    {t === "next" && upcoming.length > 0 && <span className="chip-count">{upcoming.length}</span>}
                  </button>
                ))}
              </div>
              {tab === "next" && upcoming.length > 0 && (
                <button className="pill text small" onClick={() => edit({ type: "queue-clear" })}>
                  <TrashIcon size={16} /> Clear Up next
                </button>
              )}
            </div>
          )}
          <div className="picker-body">{body}</div>
          {added && (
            <div className="snackbar" role="status">
              <span>Added “{added.label}” to Up next</span>
              <button
                onClick={() => {
                  for (const id of added.ids) edit?.({ type: "queue-remove", mediaId: id });
                  setAdded(null);
                }}
              >
                Undo
              </button>
            </div>
          )}
        </div>
      </div>
      {infoItem && (
        <Details
          key={infoItem.id + info!.fix}
          item={infoItem}
          startFixing={info!.fix}
          canMatch={b.details}
          actionLabel={props.solo ? "Play" : "Play for everyone"}
          lengthLabel={infoItem.duration ? fmtLength(infoItem.duration) : ""}
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
          onQueue={infoItem.id === media?.id ? undefined : () => add(infoItem.part?.ids ?? [infoItem.id], infoItem.title)}
          queued={queuedIds.has(infoItem.id)}
          onMatched={setLibrary}
          onClose={() => setInfo(null)}
        />
      )}
    </>
  );
}

/** What's playing now, then Up next in order. The host drags the dots to reorder, × removes, Play now jumps there. */
function UpNextList(props: {
  media: MediaItem | null;
  upcoming: MediaItem[];
  details: boolean;
  edit?: (msg: ClientMessage) => void;
  onPlay: (id: string) => void;
  note: React.ReactNode;
}) {
  const { upcoming, edit } = props;
  const [dragging, setDragging] = useState<string | null>(null);
  // Where the dragged row would land: before the row at this index (upcoming.length = at the end).
  const [over, setOver] = useState<number | null>(null);
  const total = upcoming.reduce((s, i) => s + (i.duration ?? 0), 0);

  const drop = () => {
    if (dragging && over !== null && edit) {
      const from = upcoming.findIndex((i) => i.id === dragging);
      const to = over > from ? over - 1 : over;
      if (to !== from) edit({ type: "queue-move", mediaId: dragging, to });
    }
    setDragging(null);
    setOver(null);
  };

  return (
    <div className="un-wrap">
      {props.media && (
        <div className="un-row un-now">
          {/* Lined up with the rows below, which only have a lead (the drag handle) for the host. */}
          {edit && (
            <span className="un-lead">
              <PlayIcon size={16} />
            </span>
          )}
          <Thumb item={props.media} details={props.details} />
          <span className="un-text">
            <span className="un-label">Playing now</span>
            <span className="un-title">{name(props.media)}</span>
            <span className="un-facts">{facts(props.media)}</span>
          </span>
        </div>
      )}
      {upcoming.length > 0 ? (
        <>
          <p className="un-count">
            Next · {upcoming.length === 1 ? "1 video" : `${upcoming.length} videos`}
            {total > 0 && ` · ${fmtRuntime(total)}`}
          </p>
          <ol className="un-list" onDragOver={(e) => dragging && e.preventDefault()} onDrop={drop}>
            {upcoming.map((item, i) => (
              <li
                key={item.id}
                className={["un-row", dragging === item.id ? "dragging" : "", over === i ? "drop-before" : "", over === upcoming.length && i === upcoming.length - 1 ? "drop-after" : ""].join(" ")}
                draggable={!!edit}
                onDragStart={(e) => {
                  setDragging(item.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={(e) => {
                  if (!dragging) return;
                  const box = e.currentTarget.getBoundingClientRect();
                  setOver(e.clientY < box.top + box.height / 2 ? i : i + 1);
                }}
              >
                {edit && (
                  <span className="un-lead">
                    <GripIcon size={18} />
                  </span>
                )}
                <Thumb item={item} details={props.details} />
                <span className="un-text">
                  <span className="un-title">{name(item)}</span>
                  <span className="un-facts">{facts(item)}</span>
                </span>
                {edit && (
                  <>
                    <button className="pill text small" onClick={() => props.onPlay(item.id)}>
                      <PlayIcon size={15} /> Play now
                    </button>
                    <button className="icon" onClick={() => edit({ type: "queue-remove", mediaId: item.id })} title="Remove from Up next" aria-label={`Remove from Up next: ${item.title}`}>
                      <CloseIcon size={18} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        </>
      ) : (
        <p className="un-count">Nothing in Up next yet.</p>
      )}
      <p className="un-note">{props.note}</p>
    </div>
  );
}

function Thumb(props: { item: MediaItem; details: boolean }) {
  const m = props.item.meta;
  const path = m?.stillPath ?? m?.backdropPath ?? m?.posterPath ?? m?.showPosterPath ?? null;
  return props.details && path ? <Poster path={path} size="w300" className="un-thumb" /> : <span className="un-thumb empty" />;
}

/** "Who Is Alive? · 55 m" for an episode, "Movie · 1995 · 2 h 50 m" for a movie. */
/** The episode's or movie's own name; the show and episode number go in [facts]. */
function name(item: MediaItem): string {
  if (item.episode) return item.episode.title ?? item.meta?.title ?? item.title;
  return item.meta?.title ?? item.title;
}

function facts(item: MediaItem): string {
  const length = item.duration ? fmtRuntime(item.duration) : "";
  const ep = item.episode;
  if (ep) return [`${item.meta?.show ?? ep.show} ${episodeLabel(ep.season, ep.episode)}`, item.part ? `Part ${item.part.index}` : "", length].filter(Boolean).join(" · ");
  return [item.extra ? item.extra.kind : "Movie", item.part ? `Part ${item.part.index}` : "", String(item.meta?.year ?? item.year ?? ""), length].filter(Boolean).join(" · ");
}
