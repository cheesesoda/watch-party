import { useEffect, useRef, useState } from "react";
import type { MediaItem, PartyInvite, ScheduledParty } from "../../shared/protocol.ts";
import { episodeLabel } from "../../shared/specials.ts";
import { imageUrl } from "./api.ts";
import { CalendarIcon, CalendarPlusIcon, ClockIcon } from "./Icons.tsx";

/** What Schedule would play, for the dialog: "Charade", "1963 · 1 h 54 m" and its poster. */
export type ScheduleWhat = { ids: string[]; title: string; sub: string; poster: string | null };

/** "Charade", or "Reacher · S2 E1" for an episode, as the server names it on invites. */
export const partyTitle = (m: MediaItem | null) =>
  !m ? "A watch party" : m.episode ? `${m.meta?.show ?? m.episode.show} · ${episodeLabel(m.episode.season, m.episode.episode)}` : (m.meta?.title ?? m.title);

const DAY_MS = 24 * 3600_000;
const startOfDay = (t: number) => new Date(new Date(t).toDateString()).getTime();
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Sat, Oct 24 at 8:00 PM", in this browser's time zone. */
export const whenLong = (at: number) => `${new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${time(at)}`;

/** "Today 8:00 PM", "Sat 8:00 PM" within the week, else "Oct 31, 8:00 PM": the card's badge. */
export function whenShort(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days === 0) return `Today ${time(at)}`;
  if (days === 1) return `Tomorrow ${time(at)}`;
  if (days > 1 && days < 7) return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${time(at)}`;
  return `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(at)}`;
}

/** "In 4 days", "Tomorrow", "In 3 hours", "In 20 minutes". */
export function untilLabel(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (days > 1) return `In ${days} days`;
  if (days === 1) return "Tomorrow";
  const mins = Math.max(1, Math.round((at - now) / 60_000));
  if (mins < 60) return `In ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  return `In ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** The day chips: Today, Tomorrow, then the next four days ("Thu 22"). */
function days(now: number): { label: string; day: number }[] {
  const today = startOfDay(now);
  return Array.from({ length: 6 }, (_, i) => {
    const day = startOfDay(today + i * DAY_MS + 12 * 3600_000);
    const d = new Date(day);
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.getDate()}`;
    return { label, day };
  });
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Every quarter hour, as "20:00" with its label in this browser's style ("8:00 PM"). */
const TIMES = Array.from({ length: 96 }, (_, i) => {
  const value = `${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`;
  return { value, label: new Date(2000, 0, 1, Math.floor(i / 4), (i % 4) * 15).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) };
});
const dateValue = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Schedule a party: a day, a time, and what it plays. */
export function ScheduleDialog(props: { what: ScheduleWhat; details: boolean; onCancel: () => void; onSchedule: (at: number) => Promise<void> }) {
  const [now] = useState(() => Date.now());
  const chips = days(now);
  const [day, setDay] = useState(chips[0].day);
  const [other, setOther] = useState(false);
  const [clock, setClock] = useState("20:00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dateInput = useRef<HTMLInputElement>(null);
  const schedule = useRef<HTMLButtonElement>(null);
  useEffect(() => schedule.current?.focus(), []);
  useEffect(() => {
    if (other) dateInput.current?.showPicker?.();
  }, [other]);

  useEffect(() => setError(null), [day, clock, other]);

  const [h, m] = clock.split(":").map(Number);
  const at = new Date(day).setHours(h || 0, m || 0, 0, 0);
  const submit = async () => {
    if (at <= Date.now()) return setError("That time has already passed today.");
    setBusy(true);
    setError(null);
    try {
      await props.onSchedule(at);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="save-spot-backdrop"
      onClick={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      <div className="save-spot schedule" role="dialog" aria-modal="true" aria-labelledby="schedule-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="schedule-title">Schedule a party</h2>
        <div className="save-spot-item">
          {props.details && props.what.poster && <img className="schedule-poster" src={imageUrl(props.what.poster, "w185")} alt="" />}
          <span>
            <b>{props.what.title}</b>
            <small>{props.what.sub}</small>
          </span>
        </div>
        <div className="schedule-field">
          <span className="schedule-label" id="schedule-day">
            Day
          </span>
          <div className="schedule-days" role="group" aria-labelledby="schedule-day">
            {chips.map((c) => (
              <button
                key={c.day}
                className={!other && day === c.day ? "chip on" : "chip"}
                aria-pressed={!other && day === c.day}
                onClick={() => {
                  setOther(false);
                  setDay(c.day);
                }}
              >
                {c.label}
              </button>
            ))}
            {other ? (
              <input
                ref={dateInput}
                className="chip on schedule-date"
                type="date"
                aria-label="Date"
                min={dateValue(now)}
                value={dateValue(day)}
                onChange={(e) => e.target.value && setDay(startOfDay(new Date(`${e.target.value}T12:00`).getTime()))}
              />
            ) : (
              <button
                className="chip schedule-other"
                onClick={() => {
                  setOther(true);
                  setDay(startOfDay(chips[chips.length - 1].day + DAY_MS + 12 * 3600_000));
                }}
              >
                <CalendarIcon size={14} /> Other date
              </button>
            )}
          </div>
        </div>
        <label className="schedule-field">
          <span className="schedule-label">Time</span>
          <select className="schedule-time" value={clock} onChange={(e) => setClock(e.target.value)}>
            {TIMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <p className="schedule-help">
          The party code works right away. Friends who open the invite early see the start time and can add it to their calendar. Nothing plays until
          you join, same as now.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="save-spot-actions">
          <span className="spacer" />
          <button className="pill text accent" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="pill primary" ref={schedule} disabled={busy} onClick={() => void submit()}>
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}

/** A scheduled party under Coming up: its time, what it plays, Cancel and Start now. */
export function ScheduledCard(props: { party: ScheduledParty; details: boolean; copied: boolean; onCopy: () => void; onCancel: () => void; onStart: () => void }) {
  const p = props.party;
  const m = p.media?.meta;
  const art = props.details ? (m?.backdropPath ?? m?.stillPath ?? null) : null;
  const [failed, setFailed] = useState(false);
  const title = p.media?.episode ? (m?.show ?? p.media.episode.show) : (m?.title ?? p.media?.title ?? "Nothing picked yet");
  const sub = p.media?.episode ? episodeLabel(p.media.episode.season, p.media.episode.episode) : null;
  return (
    <div className="party-card">
      <span className="party-art">
        {art && !failed && <img src={imageUrl(art, "w780")} alt="" loading="lazy" onError={() => setFailed(true)} />}
        <span className="party-state soon">
          <ClockIcon size={13} /> {whenShort(p.at)}
        </span>
        <span className="party-title">
          {title}
          {p.count > 1 && <span className="year"> · {p.count} videos</span>}
        </span>
      </span>
      <div className="party-body">
        <span className="meta">{[sub, untilLabel(p.at)].filter(Boolean).join(" · ")}</span>
        <span />
        <div className="party-actions">
          <button className="party-end" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="party-open" onClick={props.onStart} aria-label={`Start ${title} now`}>
            Start now
          </button>
        </div>
      </div>
      <button className={props.copied ? "party-card-code copied" : "party-card-code"} onClick={props.onCopy} title="Copy invite link">
        {props.copied ? "Link copied" : p.id.toUpperCase()}
      </button>
    </div>
  );
}

/** Text for one line of an .ics file: commas, semicolons and line breaks escaped. */
const icsText = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A calendar event for the party, with the invite link and a reminder 30 minutes before. */
export function calendarFile(invite: Pick<PartyInvite, "id" | "at" | "title" | "host" | "duration">, link: string): string {
  const length = invite.duration && invite.duration > 60 ? invite.duration * 1000 : 2 * 3600_000;
  const name = `${invite.title} watch party`;
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Popcorn Club//EN",
    "BEGIN:VEVENT",
    `UID:${invite.id}-${invite.at}@popcorn-club`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART:${icsTime(invite.at)}`,
    `DTEND:${icsTime(invite.at + length)}`,
    `SUMMARY:${icsText(name)}`,
    `DESCRIPTION:${icsText(`${invite.host ? `${invite.host}'s party. ` : ""}Join: ${link}\nParty code: ${invite.id.toUpperCase()}`)}`,
    `URL:${link}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(`${name} starts in 30 minutes`)}`,
    "TRIGGER:-PT30M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

/** Saves the event as an .ics file, which the phone or computer opens in its calendar. */
export function addToCalendar(invite: Pick<PartyInvite, "id" | "at" | "title" | "host" | "duration">, link: string): void {
  const a = document.createElement("a");
  a.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(calendarFile(invite, link))}`;
  a.download = `${invite.title.replace(/[^\w ]+/g, "").trim() || "Watch party"}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
}

/** The invite opened before its party opens: when it starts, and Add to calendar. */
export function InviteEarly(props: { invite: PartyInvite; link: string }) {
  const inv = props.invite;
  return (
    <div className="center">
      <div className="card login invite-early">
        <h1>{inv.title}</h1>
        {inv.host && <p className="invite-host">{inv.host}'s party</p>}
        <div className="invite-when">
          <CalendarPlusIcon size={26} />
          <div>
            <b>Starts {whenLong(inv.at)}</b>
            <span>{untilLabel(inv.at)}. Come back to this link then.</span>
          </div>
        </div>
        <button className="primary big" onClick={() => addToCalendar(inv, props.link)}>
          <CalendarPlusIcon size={18} /> Add to calendar
        </button>
        <p className="invite-note">The calendar event has this link and reminds you 30 minutes before.</p>
      </div>
    </div>
  );
}
