import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { episodeLabel } from "../../shared/specials.ts";
import { worthSaving, type HealthReport, type MediaItem, type PartyInvite, type RoomPlayback, type RoomSummary, type ScheduledParty, type Spot } from "../../shared/protocol.ts";
import { api, getInviteBase, imageUrl, type LibraryResponse } from "./api.ts";
import { Banner, HomeRows, movieLink, MoviePage, MoviesPage, readPref, SearchResults, ShowPage, showLink, ShowsPage, writePref, type Browse } from "./Browse.tsx";
import { buildCatalog } from "./catalog.ts";
import { FindSubtitlesDialog } from "./FindSubtitles.tsx";
import { ActivityIcon, CalendarPlusIcon, CaptionsIcon, FilmIcon, HistoryIcon, HomeIcon, ListVideoIcon, LogOutIcon, PencilIcon, RefreshIcon, SearchIcon, TvIcon, UserIcon, UsersIcon } from "./Icons.tsx";
import { HealthPage, needsFixing } from "./Health.tsx";
import { HistoryPage } from "./History.tsx";
import { Details } from "./Library.tsx";
import { navigate, usePageTitle } from "./nav.ts";
import { Logo } from "./Logo.tsx";
import { useArtTone } from "./artTone.ts";
import { SaveSpotDialog, spotPreview, SpotRow } from "./Spots.tsx";
import { addToCalendar, partyTitle, ScheduledCard, ScheduleDialog, whenLong, type ScheduleWhat } from "./Schedule.tsx";

/** The link friends open to join; it lands on the join screen with the code filled in. */
// A real path rather than #/join/, so Android can open it in the app; the server redirects browsers to #/join/.
export const inviteLink = (code: string) =>
  `${getInviteBase()}/join/${code.toUpperCase()}`;
/**
 * A scheduled party's invite carries its title and start time, so the always-on invite page can still show them (and
 * make the calendar event) while the host's PC is off.
 */
const scheduledLink = (p: { id: string; at: number; title: string }) => `${inviteLink(p.id)}?${new URLSearchParams({ t: p.title, at: String(p.at) })}`;

const NAV: [string, string, (p: { size?: number }) => ReactNode][] = [
  ["/", "Home", HomeIcon],
  ["/movies", "Movies", FilmIcon],
  ["/shows", "TV Shows", TvIcon],
  ["/parties", "Watch Parties", UsersIcon],
  ["/history", "History", HistoryIcon],
  ["/subtitles", "Has subtitles", CaptionsIcon],
];

/**
 * The host's dashboard, laid out like Jellyfin or Plex: a sidebar, search and party code on top, and pages for Home,
 * Movies, TV shows, Watch parties and Has subtitles, plus a page per movie and show. Starting a party shows its code;
 * nothing plays until someone joins.
 */
export function Home(props: {
  route: string;
  name: string;
  onRename: () => void;
  onSignOut: () => void;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [started, setStarted] = useState<RoomSummary | null>(null);
  // Parties scheduled for later (Coming up), the Schedule dialog while it's open, and the one just scheduled.
  const [scheduled, setScheduled] = useState<ScheduledParty[]>([]);
  const [scheduling, setScheduling] = useState<ScheduleWhat | null>(null);
  const [planned, setPlanned] = useState<PartyInvite | null>(null);
  // Find subtitles: the video it's open for, then "English subtitles added" for a moment.
  const [findingSubs, setFindingSubs] = useState<MediaItem | null>(null);
  const [subsAdded, setSubsAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!subsAdded) return;
    const t = setTimeout(() => setSubsAdded(null), 6000);
    return () => clearTimeout(t);
  }, [subsAdded]);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  // The party whose code was just clicked, to say its invite link was copied.
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Pick up where you left off, and the party being ended while "Save your spot?" is up.
  const [spots, setSpots] = useState<Spot[]>([]);
  const [ending, setEnding] = useState<RoomSummary | null>(null);
  // Together / Alone: watching alone, every play button goes straight to the player, with no code to share.
  const [alone, setAlone] = useState(() => readPref("alone") === "1");
  useEffect(() => writePref("alone", alone ? "1" : "0"), [alone]);
  const startLabel = alone ? "Play" : "Start party";
  const loadSpots = () => api.spots().then(setSpots, () => {});
  const [query, setQuery] = useState(() => session("query") ?? "");
  useEffect(() => saveSession("query", query), [query]);

  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ id: string; fix: boolean | "times" } | null>(null);
  const loadLibrary = (rescan = false) => {
    setLibraryError(null);
    (rescan ? api.rescan() : api.library()).then(setLibrary, (e) => setLibraryError(e.message));
  };
  useEffect(() => loadLibrary(), []);

  // Library health: the server checks files in the background after a scan, so look again now and then.
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      api.health().then(
        (r) => (setHealth(r), setHealthError(null)),
        (e) => setHealthError(e.message),
      );
    load();
    const timer = setInterval(load, health && health.checked < health.total ? 5_000 : 60_000);
    return () => clearInterval(timer);
  }, [library, health && health.checked < health.total]);

  // When the list arrived, so playing parties' progress can move on between refreshes.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () =>
      api.rooms().then(
        (rs) => {
          setRooms(rs);
          setFetchedAt(Date.now());
        },
        () => {},
      );
      api.scheduled().then(setScheduled, () => {});
      // Parties that closed by themselves, or ended elsewhere, may have saved a spot.
      void loadSpots();
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const anyPlaying = rooms.some((r) => r.playback && !r.playback.paused);
  useEffect(() => {
    if (!anyPlaying) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyPlaying]);

  /** position: where in the first video to start (Pick up, from History). */
  const start = async (ids: string[], spot?: Spot, position?: number) => {
    setError(null);
    try {
      const room = spot ? await api.startSpot(spot.id, alone) : await api.createRoom(ids[0], ids.length > 1 ? ids : undefined, alone, position);
      if (spot) setSpots((ss) => ss.filter((x) => x.id !== spot.id));
      if (room.solo) return navigate(`/room/${room.id}`);
      setStarted(room);
      window.scrollTo({ top: 0, behavior: "smooth" });
      setRooms((rs) => [...rs.filter((r) => r.id !== room.id), room]);
    } catch (err) {
      setError((err as Error).message);
      if (spot) void loadSpots();
    }
  };

  const copy = async (id: string, link = inviteLink(id)) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this invite link", link);
    }
  };
  const copyCode = async (id: string, link = inviteLink(id)) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedCode(id);
      setTimeout(() => setCopiedCode((c) => (c === id ? null : c)), 2000);
    } catch {
      prompt("Copy this invite link", link);
    }
  };

  const schedule = async (what: ScheduleWhat, at: number) => {
    const made = await api.schedule(what.ids, at, props.name);
    setScheduling(null);
    setStarted(null);
    setPlanned(made.invite);
    setScheduled((ss) => [...ss.filter((x) => x.id !== made.scheduled.id), made.scheduled].sort((a, b) => a.at - b.at));
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Within 30 minutes of the start it's a party already.
    api.rooms().then(setRooms, () => {});
  };
  const cancelScheduled = async (p: ScheduledParty) => {
    if (!confirm(`Cancel the ${partyTitle(p.media)} party on ${whenLong(p.at)}? Its code stops working.`)) return;
    try {
      await api.cancelScheduled(p.id);
      setScheduled((ss) => ss.filter((x) => x.id !== p.id));
      setPlanned((x) => (x?.id === p.id ? null : x));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const startScheduled = async (p: ScheduledParty) => {
    setError(null);
    try {
      const room = await api.startScheduled(p.id);
      setScheduled((ss) => ss.filter((x) => x.id !== p.id));
      setPlanned((x) => (x?.id === p.id ? null : x));
      setStarted(room);
      window.scrollTo({ top: 0, behavior: "smooth" });
      setRooms((rs) => [...rs.filter((r) => r.id !== room.id), room]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // A party partway through something asks "Save your spot?"; otherwise it just checks.
  const end = (room: RoomSummary) => {
    const p = room.playback;
    const position = p ? (p.paused ? p.position : p.position + Math.max(0, (Date.now() - fetchedAt) / 1000)) : 0;
    if (room.media && worthSaving(position, p?.duration ?? room.media.duration, room.upNext?.count ?? 0, room.media.marks?.credits)) return setEnding(room);
    const title = room.media?.title ?? "this party";
    if (confirm(`End ${title} for everyone? Anyone watching goes back to the start screen.`)) void finish(room, false);
  };
  const finish = async (room: RoomSummary, save: boolean) => {
    setEnding(null);
    try {
      await api.endRoom(room.id, props.name, save);
      setRooms((rs) => rs.filter((r) => r.id !== room.id));
      setStarted((s) => (s?.id === room.id ? null : s));
      if (save) void loadSpots();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeSpot = (spot: Spot) => {
    setSpots((ss) => ss.filter((x) => x.id !== spot.id));
    api.removeSpot(spot.id).catch(() => void loadSpots());
  };
  // Clicking a spot opens its show or movie page.
  const openSpot = (spot: Spot) => {
    const m = cat.byId.get(spot.media.id) ?? spot.media;
    // An extra opens the show or movie it belongs to.
    const show = cat.shows.find((s) => s.episodes.some((e) => e.id === m.id) || s.extras.some((e) => e.id === m.id));
    const owner = m.extra?.of ? cat.byId.get(m.extra.of) : undefined;
    go(show ? showLink(show) : movieLink(owner ?? m));
  };

  const join = (e: FormEvent) => {
    e.preventDefault();
    const id = code.trim().toLowerCase();
    if (id) navigate(`/room/${id}`);
  };

  // Mark as watched / not watched shows straight away; the server's answer (or the library again, if it fails) settles it.
  const mark = (ids: string[], watched: boolean) => {
    const now = Date.now();
    const local = new Map(ids.map((id) => [id, watched ? { watchedAt: now, position: null, updatedAt: now } : null]));
    const apply = (states: Map<string, MediaItem["watch"]>) =>
      setLibrary((lib) => lib && { ...lib, items: lib.items.map((i) => (states.has(i.id) ? { ...i, watch: states.get(i.id) } : i)) });
    apply(local);
    api.markWatched(ids, watched).then(
      (states) => apply(new Map(Object.entries(states))),
      (e) => {
        setError(e.message);
        loadLibrary();
      },
    );
  };

  const cat = useMemo(() => buildCatalog(library?.items ?? []), [library]);
  const browse: Browse = useMemo(
    () => ({
      cat,
      details: !!library?.details,
      convert: library?.convert ?? true,
      start: (ids) => void start(ids),
      startLabel,
      // Watching alone there's nobody to schedule for.
      schedule: alone ? undefined : setScheduling,
      openInfo: (id, fix = false) => setInfo({ id, fix }),
      findSubtitles: setFindingSubs,
      spot: {
        of: (show) => spots.find((sp) => show.episodes.some((e) => e.id === sp.media.id)),
        start: (sp) => void start([], sp),
      },
      watch: { mark },
    }),
    [cat, library, spots, alone],
  );

  // Going to another page clears the search, the way a search box in an app does.
  const route = props.route;
  const go = (path: string) => {
    setQuery("");
    navigate(path);
  };
  const lastRoute = useRef(route);
  useEffect(() => {
    if (lastRoute.current !== route) setQuery("");
    lastRoute.current = route;
  }, [route]);

  // Each page keeps its scroll position, so Back from a movie lands where you were (also after a refresh).
  const scrolls = useRef<Record<string, number>>(JSON.parse(session("scroll") ?? "{}"));
  useEffect(() => {
    const save = () => {
      scrolls.current[route] = window.scrollY;
      saveSession("scroll", JSON.stringify(scrolls.current));
    };
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [route]);
  useLayoutEffect(() => {
    if (library) window.scrollTo(0, scrolls.current[route] ?? 0);
  }, [route, !!library]);

  const movieId = /^\/movie\/([\w-]+)/.exec(route)?.[1];
  const showKey = /^\/show\/([^/]+)/.exec(route)?.[1];
  const movie = movieId ? cat.byId.get(movieId) : undefined;
  const show = showKey ? cat.shows.find((s) => s.key === decodeURIComponent(showKey)) : undefined;
  const section = movie ? "/movies" : show ? "/shows" : route;
  const hero = !query.trim() && (movie || show || (route === "/" && browse.details));
  const mainRef = useRef<HTMLElement>(null);
  const tone = useArtTone(mainRef, !!hero);
  usePageTitle(
    query.trim() ? `Search: ${query.trim()}` : movie ? movie.title : show ? show.name : route === "/" ? null : route === "/health" ? "Library health" : NAV.find(([path]) => path === route)?.[1],
  );

  let page: ReactNode;
  if (libraryError) page = <p className="error">{libraryError}</p>;
  else if (!library) page = <p className="muted">Loading library…</p>;
  else if (route === "/health") page = <HealthPage b={browse} report={health} error={healthError} />;
  else if (library.items.length === 0 && route !== "/parties")
    page = <p className="muted">No videos found. Put files in the server's media folder and press Rescan library.</p>;
  else if (query.trim()) page = <SearchResults b={browse} query={query} />;
  else if (route === "/parties") page = null;
  else if (movie) page = <MoviePage key={movie.id} b={browse} item={movie} />;
  else if (show) page = <ShowPage key={show.key} b={browse} show={show} />;
  else if (route === "/movies") page = <MoviesPage b={browse} />;
  else if (route === "/shows") page = <ShowsPage b={browse} />;
  else if (route === "/subtitles") page = <MoviesPage b={browse} subtitlesOnly />;
  else if (route === "/history") page = <HistoryPage b={browse} startAt={(item, position) => void start([item.id], undefined, position)} />;
  else if (movieId || showKey) page = <p className="muted">That video isn't in the library anymore.</p>;
  else page = <HomeRows b={browse} />;

  const partyCards = (
    <div className="party-grid">
      {rooms.map((r) => (
        <PartyCard
          key={r.id}
          room={r}
          elapsed={(now - fetchedAt) / 1000}
          details={browse.details}
          copied={copiedCode === r.id}
          onCopy={() => copyCode(r.id)}
          onEnd={() => end(r)}
        />
      ))}
    </div>
  );
  const comingUp = scheduled.length > 0 && (
    <>
      <h2 className="coming-up">Coming up</h2>
      <div className="party-grid">
        {scheduled.map((p) => (
          <ScheduledCard
            key={p.id}
            party={p}
            details={browse.details}
            copied={copiedCode === p.id}
            onCopy={() => copyCode(p.id, scheduledLink({ id: p.id, at: p.at, title: partyTitle(p.media) }))}
            onCancel={() => void cancelScheduled(p)}
            onStart={() => void startScheduled(p)}
          />
        ))}
      </div>
    </>
  );
  const partyCount = rooms.length + scheduled.length;

  return (
    <div className="dash">
      <aside className="sidebar">
        <button className="sidebar-logo" onClick={() => go("/")} aria-label="Home">
          <Logo size={34} />
        </button>
        <nav>
          {NAV.map(([path, label, Icon]) => (
            <button key={path} className={section === path && !query.trim() ? "on" : ""} aria-current={section === path && !query.trim() ? "page" : undefined} onClick={() => go(path)}>
              <Icon size={20} />
              <span>{label}</span>
              {path === "/parties" && partyCount > 0 && <b className="nav-count">{partyCount}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="name-link" onClick={props.onRename} title="Change name">
            <span>
              Hosting as <strong>{props.name}</strong>
            </span>
            <PencilIcon size={14} />
          </button>
          <button className={route === "/health" && !query.trim() ? "on" : ""} onClick={() => go("/health")} title="Files that won't play well">
            <ActivityIcon size={16} /> Library health
            {needsFixing(health) > 0 && <b className="nav-count warn">{needsFixing(health)}</b>}
          </button>
          <button onClick={() => loadLibrary(true)} title="Look for new or removed videos">
            <RefreshIcon size={16} /> Rescan library
          </button>
          <button onClick={props.onSignOut}>
            <LogOutIcon size={16} /> Sign out
          </button>
        </div>
      </aside>

      <main ref={mainRef} className={hero ? "dash-main over-art" : "dash-main"}>
        <header className={["dash-top", tone.left && "light-left", tone.right && "light-right"].filter(Boolean).join(" ")}>
          <label className="search">
            <SearchIcon size={18} />
            <input
              type="search"
              placeholder={library ? `Search ${cat.movies.length + cat.shows.length} movies and TV shows` : "Search movies and TV shows"}
              aria-label="Search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                window.scrollTo(0, 0);
              }}
            />
          </label>
          <span className="spacer" />
          <div className="mode-switch" role="group" aria-label="Watch together or alone">
            <button className={alone ? "" : "on"} aria-pressed={!alone} onClick={() => setAlone(false)} title="Play buttons start a party">
              <UsersIcon size={16} /> Together
            </button>
            <button className={alone ? "on" : ""} aria-pressed={alone} onClick={() => setAlone(true)} title="Play buttons play just for you">
              <UserIcon size={16} /> Alone
            </button>
          </div>
          <form className="join-code" onSubmit={join}>
            <label htmlFor="party-code">Party code</label>
            <input id="party-code" placeholder="______" value={code} maxLength={12} autoComplete="off" onChange={(e) => setCode(e.target.value.toUpperCase())} />
            <button className="pill tonal" disabled={!code.trim()}>
              Join
            </button>
          </form>
        </header>

        {(error || started || planned) && (
          <div className="dash-notices">
            {error && <p className="error">{error}</p>}
            {planned && (
              <div className="started">
                <div>
                  <p>
                    Party scheduled for <strong>{planned.title}</strong> on <strong>{whenLong(planned.at)}</strong>. Share the code or the invite link now;
                    friends who open it early see when it starts.
                  </p>
                  <p className="party-code">{planned.id.toUpperCase()}</p>
                </div>
                <div className="started-actions">
                  <button className="pill primary" onClick={() => copy(planned.id, scheduledLink(planned))}>
                    {copied ? "Link copied" : "Copy invite link"}
                  </button>
                  <button className="pill tonal" onClick={() => addToCalendar(planned, scheduledLink(planned))}>
                    <CalendarPlusIcon size={18} /> Add to calendar
                  </button>
                  <button className="pill text" onClick={() => setPlanned(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {started && (
              <div className="started">
                <div>
                  <p>
                    Party ready for <strong>{started.media?.title}</strong>
                    {started.binge && `, the first of ${started.binge.length} in this binge`}. Share the code or the invite link, then join when you're
                    ready to watch.
                  </p>
                  <p className="party-code">{started.id.toUpperCase()}</p>
                </div>
                <div className="started-actions">
                  <button className="pill primary" onClick={() => navigate(`/room/${started.id}`)}>
                    Join party
                  </button>
                  <button className="pill tonal" onClick={() => copy(started.id)}>
                    {copied ? "Link copied" : "Copy invite link"}
                  </button>
                  <button className="pill text" onClick={() => end(started)}>
                    End party
                  </button>
                  <button className="pill text" onClick={() => setStarted(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {route === "/" && !query.trim() && library && <Banner b={browse} />}

        {route === "/" && !query.trim() && spots.length > 0 && (
          <SpotRow spots={spots} details={browse.details} startLabel={startLabel} onStart={(sp) => void start([], sp)} onRemove={removeSpot} onOpen={openSpot} />
        )}

        {route === "/" && !query.trim() && partyCount > 0 && (
          <section className="dash-section">
            <div className="dash-section-head">
              <h2>Watch Parties</h2>
            </div>
            {rooms.length > 0 && partyCards}
            {comingUp}
          </section>
        )}

        {route === "/parties" && !query.trim() ? (
          <>
            <div className="page-head">
              <h1>Watch Parties</h1>
              <span className="count">{partyCount}</span>
            </div>
            {partyCount === 0 ? <p className="muted">No parties right now. Start or schedule one from any movie or show.</p> : rooms.length > 0 && partyCards}
            {comingUp}
          </>
        ) : (
          page
        )}
      </main>

      {scheduling && (
        <ScheduleDialog what={scheduling} details={browse.details} onCancel={() => setScheduling(null)} onSchedule={(at) => schedule(scheduling, at)} />
      )}

      {ending?.media &&
        (() => {
          const r = ending;
          const p = r.playback;
          const position = p ? (p.paused ? p.position : p.position + Math.max(0, (now - fetchedAt) / 1000)) : 0;
          const preview = spotPreview(r.media!, position, p?.duration ?? r.media!.duration, r.upNext?.item ?? null, r.upNext?.count ?? 0);
          return (
            <SaveSpotDialog
              {...preview}
              details={browse.details}
              onSave={() => void finish(r, true)}
              onDontSave={() => void finish(r, false)}
              onCancel={() => setEnding(null)}
            />
          );
        })()}

      {info && cat.byId.has(info.id) && (
        <Details
          key={info.id + info.fix}
          item={cat.byId.get(info.id)!}
          startFixing={info.fix === true}
          startTiming={info.fix === "times"}
          canMatch={browse.details}
          actionLabel={startLabel}
          lengthLabel={detailsLine(cat.byId.get(info.id)!)}
          onPick={() => {
            const item = cat.byId.get(info.id)!;
            setInfo(null);
            void start(item.part?.ids ?? [item.id]);
          }}
          onBingeFrom={(() => {
            const item = cat.byId.get(info.id)!;
            const s = item.episode && cat.shows.find((x) => x.episodes.includes(item));
            if (!s) return undefined;
            return () => {
              setInfo(null);
              void start(s.episodes.slice(s.episodes.indexOf(item)).map((e) => e.id));
            };
          })()}
          onMatched={setLibrary}
          onFindSubtitles={() => {
            setFindingSubs(cat.byId.get(info.id)!);
            setInfo(null);
          }}
          onClose={() => setInfo(null)}
        />
      )}

      {findingSubs && (
        <FindSubtitlesDialog
          item={findingSubs}
          {...subtitlesHeading(findingSubs)}
          poster={browse.details ? (findingSubs.meta?.posterPath ?? null) : null}
          onCancel={() => setFindingSubs(null)}
          onAdded={(r) => {
            setLibrary(r);
            setSubsAdded(subtitlesHeading(findingSubs).title);
            setFindingSubs(null);
          }}
        />
      )}
      {subsAdded && (
        <div className="toast info dash-toast" role="status">
          English subtitles added for {subsAdded}. Pick them in the player, on any TV, phone or browser.
        </div>
      )}
    </div>
  );
}

/** Find subtitles' heading: "Casablanca" over "1942", or "Reacher · S2 E1" over the episode's name. */
function subtitlesHeading(item: MediaItem): { title: string; sub: string } {
  const m = item.meta;
  if (item.episode) return { title: `${m?.show ?? item.episode.show} · ${episodeLabel(item.episode.season, item.episode.episode)}`, sub: m?.title ?? "" };
  const year = m?.year ?? item.year;
  return { title: m?.title ?? item.title, sub: year ? String(year) : "" };
}

function detailsLine(item: { duration?: number | null; size: number; subtitles: unknown[]; extra?: { kind: string } | null }) {
  const length = item.duration ? clock(item.duration) : "";
  return [item.extra?.kind, length, item.subtitles.length > 0 ? "Subtitles" : ""].filter(Boolean).join(" · ");
}

/** A running party: its art, whether it's playing, the code (click to copy the invite link), who's there and how far in. */
function PartyCard(props: { room: RoomSummary; elapsed: number; details: boolean; copied: boolean; onCopy: () => void; onEnd: () => void }) {
  const r = props.room;
  const m = r.media?.meta;
  const art = props.details ? (m?.backdropPath ?? m?.stillPath ?? null) : null;
  const [failed, setFailed] = useState(false);
  const state = !r.playback || r.members.length === 0 ? "Waiting" : r.playback.paused ? "Paused" : "Watching";
  const title = r.media?.episode ? (m?.show ?? r.media.episode.show) : (m?.title ?? r.media?.title ?? "Nothing picked yet");
  const sub = r.media?.episode ? episodeLabel(r.media.episode.season, r.media.episode.episode) : null;
  return (
    <div className="party-card">
      <span className="party-art">
        {art && !failed && <img src={imageUrl(art, "w780")} alt="" loading="lazy" onError={() => setFailed(true)} />}
        <span className={`party-state ${state.toLowerCase()}`}>{state}</span>
        <span className="party-title">
          {title}
          {r.binge && <span className="year"> · {r.binge.index} of {r.binge.length}</span>}
        </span>
      </span>
      <div className="party-body">
        <span className="meta">
          {[sub, r.members.length === 0 ? "Nobody here yet" : [...new Set(r.members.map((x) => x.name))].join(", ")].filter(Boolean).join(" · ")}
        </span>
        {r.upNext && (
          <span className="party-next">
            <ListVideoIcon size={14} /> Up next: <b>{r.upNext.item.episode?.title ?? r.upNext.item.title}</b>
            {r.upNext.count > 1 && <span className="muted"> +{r.upNext.count - 1} more</span>}
          </span>
        )}
        {r.playback ? <Progress playback={r.playback} elapsed={props.elapsed} /> : <span />}
        <div className="party-actions">
          <button className="party-end" onClick={props.onEnd}>
            End
          </button>
          {/* Covers the whole card, so clicking anywhere on it joins. */}
          <button className="party-open" onClick={() => navigate(`/room/${r.id}`)} aria-label={`Join ${title}`}>
            Join
          </button>
        </div>
      </div>
      <button className={props.copied ? "party-card-code copied" : "party-card-code"} onClick={props.onCopy} title="Copy invite link">
        {props.copied ? "Link copied" : r.id.toUpperCase()}
      </button>
    </div>
  );
}

/** How far into its video a party is: a bar when the length is known, and the time either way. */
function Progress(props: { playback: RoomPlayback; elapsed: number }) {
  const { position, paused, duration } = props.playback;
  const at = paused ? position : position + Math.max(0, props.elapsed);
  const shown = duration ? Math.min(at, duration) : at;
  return (
    <span className={paused ? "progress paused" : "progress"}>
      {duration ? (
        <span
          className="progress-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(shown)}
        >
          <span style={{ width: `${(shown / duration) * 100}%` }} />
        </span>
      ) : null}
      <span className="progress-time">
        {clock(shown)}
        {duration ? ` / ${clock(duration)}` : ""}
      </span>
    </span>
  );
}

/** 1:05:09 or 5:09. */
function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Session storage: survives a refresh of this tab, not a new visit. It can be unavailable (private windows), so failures are ignored.
function session(key: string): string | null {
  try {
    return sessionStorage.getItem(`dash:${key}`);
  } catch {
    return null;
  }
}
function saveSession(key: string, value: string) {
  try {
    sessionStorage.setItem(`dash:${key}`, value);
  } catch {
    // Remembering is a convenience.
  }
}
