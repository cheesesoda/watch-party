import { useEffect, useState } from "react";
import type { HistoryEntry, MediaItem } from "../../shared/protocol.ts";
import { episodeLabel } from "../../shared/specials.ts";
import { api, imageUrl } from "./api.ts";
import { movieLink, showLink, type Browse } from "./Browse.tsx";

/**
 * History: every video played on this server, newest first, grouped by day. Each row is one video in one party (or
 * Watch alone): who was there, when, and whether it was watched or where it stopped. Kept for everyone, not per person.
 */
export function HistoryPage(props: { b: Browse; startAt: (item: MediaItem, position: number) => void }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.history().then(setEntries, (e) => setError(e.message));
  }, []);

  const { cat } = props.b;
  const open = (m: MediaItem) => {
    const show = m.episode && cat.shows.find((s) => s.episodes.some((e) => e.id === m.id));
    (props.b.open ?? ((path: string) => (location.hash = `#${path}`)))(show ? showLink(show) : movieLink(m));
  };

  const days: { label: string; entries: HistoryEntry[] }[] = [];
  for (const e of entries ?? []) {
    const label = dayLabel(e.lastAt);
    if (days.at(-1)?.label !== label) days.push({ label, entries: [] });
    days.at(-1)!.entries.push(e);
  }

  return (
    <>
      <div className="page-head">
        <h1>History</h1>
      </div>
      <p className="muted page-note">Everything played on this server, newest first. Kept for everyone, not per person.</p>
      {error && <p className="error">{error}</p>}
      {entries && entries.length === 0 && <p className="muted">Nothing played yet. Videos show up here once a party or Watch alone plays them.</p>}
      {days.map((d) => (
        <section key={d.label} className="history-day">
          <h2 className="eyebrow">{d.label}</h2>
          <ul className="history-list">
            {d.entries.map((e) => (
              <HistoryRow key={e.id} entry={e} details={props.b.details} onOpen={() => open(e.media)} onStart={(at) => props.startAt(e.media, at)} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function HistoryRow(props: { entry: HistoryEntry; details: boolean; onOpen: () => void; onStart: (position: number) => void }) {
  const { entry: e } = props;
  const m = e.media;
  const art = props.details ? (m.meta?.stillPath ?? m.meta?.backdropPath ?? null) : null;
  const [failed, setFailed] = useState(false);
  const ep = m.episode;
  const title = ep
    ? [m.meta?.show ?? ep.show, episodeLabel(ep.season, ep.episode), m.meta?.title ?? ep.title].filter(Boolean).join(" · ")
    : (m.meta?.title ?? m.title);
  const time = new Date(e.lastAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const who = [e.solo ? "Watched alone" : "Party", e.names.join(", "), time].filter(Boolean).join(" · ");
  const duration = m.duration ?? null;
  return (
    <li className="history-row">
      <button className="history-open" onClick={props.onOpen}>
        <span className="history-art">{art && !failed ? <img src={imageUrl(art, "w300")} alt="" loading="lazy" onError={() => setFailed(true)} /> : <span>{ep ? `E${ep.episode}` : ""}</span>}</span>
        <span className="history-text">
          <span className="history-title">{title}</span>
          <span className="history-meta">{who}</span>
        </span>
      </button>
      {e.watched ? (
        <span className="history-state done">Watched</span>
      ) : (
        <span className="history-state">
          Stopped at {clock(e.position)}
          {duration ? ` of ${clock(duration)}` : ""}
          {duration ? (
            <span className="progress-bar">
              <span style={{ width: `${Math.min(100, (e.position / duration) * 100)}%` }} />
            </span>
          ) : null}
        </span>
      )}
      <button className="pill tonal small" onClick={() => props.onStart(e.watched ? 0 : e.position)}>
        {e.watched ? "Watch again" : "Pick up"}
      </button>
    </li>
  );
}

/** "Today", "Yesterday", "Friday, Oct 16". */
function dayLabel(ms: number): string {
  const day = new Date(ms);
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(today) - start(day)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", ...(day.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** 1:05:09 or 5:09. */
function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
