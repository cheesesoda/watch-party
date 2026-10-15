import { useEffect, useRef, useState } from "react";
import { episodeLabel } from "../../shared/specials.ts";
import { nearEnd, type MediaItem, type Spot } from "../../shared/protocol.ts";
import { imageUrl, spotFrameUrl } from "./api.ts";
import { fmtRuntime } from "./catalog.ts";
import { CloseIcon, PlayIcon } from "./Icons.tsx";

/** "Severance · S2 E3 Who Is Alive?", or the movie's title. */
export function spotTitle(m: MediaItem): string {
  if (!m.episode) return m.meta?.title ?? m.title;
  const name = m.meta?.title ?? m.episode.title;
  return `${m.meta?.show ?? m.episode.show} · ${episodeLabel(m.episode.season, m.episode.episode)}${name ? ` ${name}` : ""}`;
}

/** "31 m in", or "From the start" for a spot at the very beginning (the next one in a binge). */
const howFar = (position: number) => (position >= 60 ? `${fmtRuntime(position)} in` : "From the start");
const lined = (n: number) => (n > 0 ? `${n} more lined up` : "");

/** Today, Yesterday, Tue, last week, 3 weeks ago. */
function when(ts: number, now = Date.now()): string {
  const day = (t: number) => new Date(t).setHours(0, 0, 0, 0);
  const days = Math.round((day(now) - day(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
  if (days < 14) return "last week";
  return `${Math.floor(days / 7)} weeks ago`;
}

const art = (m: MediaItem) => m.meta?.stillPath ?? m.meta?.backdropPath ?? null;

/**
 * The art with a bar showing how far in. Without TMDB art, a saved spot shows a still from the video where it stopped;
 * with neither, [label] (the title) over the gradient.
 */
function Thumb(props: { media: MediaItem; position: number; details: boolean; size: "w300" | "w780"; spotId?: string; label?: string }) {
  const tmdb = props.details ? art(props.media) : null;
  const sources = [tmdb && imageUrl(tmdb, props.size), props.spotId && spotFrameUrl(props.spotId)].filter((u): u is string => !!u);
  const [tried, setTried] = useState(0);
  const src = sources[tried];
  const d = props.media.duration;
  return (
    <span className="spot-art">
      {src ? (
        <img key={src} src={src} alt="" loading="lazy" onError={() => setTried((n) => n + 1)} />
      ) : props.label ? (
        <span className="spot-fallback">{props.label}</span>
      ) : null}
      {d ? (
        <span className="spot-bar">
          <span style={{ width: `${Math.min(100, (props.position / d) * 100)}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Home's "Pick up where you left off": where parties stopped. Hovering a card shows Start party (a new party at that
 * spot, with the rest lined up in Up next) and × (forget it); clicking the card opens the show or movie page.
 */
export function SpotRow(props: {
  spots: Spot[];
  details: boolean;
  /** "Start party", or "Play" while the host is watching alone. */
  startLabel: string;
  onStart: (s: Spot) => void;
  onRemove: (s: Spot) => void;
  onOpen: (s: Spot) => void;
}) {
  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h2>Pick up where you left off</h2>
      </div>
      <div className="spot-grid">
        {props.spots.map((s) => {
          const title = spotTitle(s.media);
          return (
            <div className="spot-card" key={s.id}>
              {/* Covers the whole card, so clicking anywhere on it opens the page. */}
              <button className="spot-open" onClick={() => props.onOpen(s)} aria-label={`Open ${title}`} />
              <div className="spot-top">
                <Thumb media={s.media} position={s.position} details={props.details} size="w780" spotId={s.id} label={s.media.meta?.show ?? s.media.episode?.show ?? s.media.meta?.title ?? s.media.title} />
                <button className="pill primary small spot-start" onClick={() => props.onStart(s)}>
                  <PlayIcon size={14} /> {props.startLabel}
                </button>
                <button className="spot-remove" onClick={() => props.onRemove(s)} title="Remove" aria-label={`Remove ${title}`}>
                  <CloseIcon size={16} />
                </button>
              </div>
              <div className="spot-body">
                <span className="spot-title">{title}</span>
                <span className="spot-meta">{[howFar(s.position), lined(s.next.length), when(s.savedAt)].filter(Boolean).join(" · ")}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** On a show page with a saved spot: the episode's picture with how far in, and "S2 E3 Who Is Alive? · 31 m in · 4 more lined up · saved Tue". */
export function SpotLine(props: { spot: Spot; details: boolean }) {
  const { spot } = props;
  const m = spot.media;
  const ep = m.episode ? episodeLabel(m.episode.season, m.episode.episode) + ((m.meta?.title ?? m.episode.title) ? ` ${m.meta?.title ?? m.episode.title}` : "") : (m.meta?.title ?? m.title);
  const saved = when(spot.savedAt);
  return (
    <div className="spot-line">
      <Thumb media={m} position={spot.position} details={props.details} size="w300" spotId={spot.id} />
      <span>
        <b>Pick up where you left off</b>
        <small>{[ep, howFar(spot.position), lined(spot.next.length), `saved ${saved === "Today" || saved === "Yesterday" ? saved.toLowerCase() : saved}`].filter(Boolean).join(" · ")}</small>
      </span>
    </div>
  );
}

/** What ending now would save: the video and how far in, or the next one when this one is at its credits. */
export function spotPreview(media: MediaItem, position: number, duration: number | null | undefined, next: MediaItem | null, upcoming: number) {
  if (nearEnd(position, duration, media.marks?.credits) && next) return { media: next, position: 0, more: upcoming - 1 };
  return { media, position, more: upcoming };
}

/**
 * Asked when the host ends a party that's partway through something: save its spot on Home, or just end it.
 * Save spot has focus, so Enter saves; Escape cancels.
 */
export function SaveSpotDialog(props: {
  media: MediaItem;
  position: number;
  more: number;
  details: boolean;
  onSave: () => void;
  onDontSave: () => void;
  onCancel: () => void;
}) {
  const save = useRef<HTMLButtonElement>(null);
  useEffect(() => save.current?.focus(), []);
  const m = props.media;
  const name = m.episode ? (m.meta?.title ?? m.episode.title ?? m.title) : (m.meta?.title ?? m.title);
  const sub = [m.episode ? `${m.meta?.show ?? m.episode.show} · ${episodeLabel(m.episode.season, m.episode.episode)}` : "", howFar(props.position), lined(props.more)];
  return (
    <div
      className="save-spot-backdrop"
      onClick={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      <div className="save-spot" role="dialog" aria-modal="true" aria-labelledby="save-spot-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="save-spot-title">Save your spot?</h2>
        <p>
          The party ends for everyone. Saving puts this on Home under <b>Pick up where you left off</b>, so you can start a new party right here later.
        </p>
        <div className="save-spot-item">
          <Thumb media={m} position={props.position} details={props.details} size="w300" />
          <span>
            <b>{name}</b>
            <small>{sub.filter(Boolean).join(" · ")}</small>
          </span>
        </div>
        <div className="save-spot-actions">
          <button className="pill text accent" onClick={props.onCancel}>
            Cancel
          </button>
          <span className="spacer" />
          <button className="pill text accent" onClick={props.onDontSave}>
            Don't save
          </button>
          <button className="pill primary" ref={save} onClick={props.onSave}>
            Save spot
          </button>
        </div>
      </div>
    </div>
  );
}
