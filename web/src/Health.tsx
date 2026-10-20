import { useState } from "react";
import type { HealthIssue, HealthReport } from "../../shared/protocol.ts";
import { episodeLabel } from "../../shared/specials.ts";
import { imageUrl } from "./api.ts";
import type { Browse } from "./Browse.tsx";
import { CircleXIcon, FileSearchIcon, TvIcon } from "./Icons.tsx";

const SECTIONS: { kind: HealthIssue["kind"]; title: string; why: string; Icon: typeof TvIcon; bad: boolean }[] = [
  {
    kind: "broken",
    title: "Won't play",
    why: "The server can't read these. Usually a copy that never finished or a file that isn't a video. Copy them again.",
    Icon: CircleXIcon,
    bad: true,
  },
  {
    kind: "damaged",
    title: "Damaged copies",
    why: "They start fine, but part of the file is blank, so playback stops or jumps there. Copy them again.",
    Icon: FileSearchIcon,
    bad: true,
  },
  {
    kind: "lowres",
    title: "Low resolution",
    why: "Smaller than 720p. They play, but look soft on a big TV. Worth replacing if you find a better copy.",
    Icon: TvIcon,
    bad: false,
  },
];

/** Files that need fixing (won't play or damaged): the count beside Library health in the sidebar. */
export const needsFixing = (report: HealthReport | null) => report?.issues.filter((i) => i.kind !== "lowres").length ?? 0;

/**
 * Library health: files that won't play well, as the server found them after a scan (see server/src/health.ts).
 * Sections with nothing in them are left out.
 */
export function HealthPage(props: { b: Browse; report: HealthReport | null; error: string | null }) {
  const { report } = props;
  const checking = report && report.checked < report.total;
  const when = report?.checkedAt ? checkedWhen(report.checkedAt) : null;
  return (
    <>
      <div className="page-head">
        <h1>Library health</h1>
      </div>
      <p className="muted page-note">
        Files that won't play well. Checked with Rescan library and when new videos show up
        {checking ? `; checking now, ${report.checked} of ${report.total} videos so far.` : when ? `; last checked ${when}, ${report!.total} videos.` : "."}
      </p>
      {props.error && <p className="error">{props.error}</p>}
      {!report && !props.error && <p className="muted">Loading…</p>}
      {report && !checking && report.issues.length === 0 && <p className="health-fine">All {report.total} videos look fine.</p>}
      {SECTIONS.map((s) => {
        const issues = report?.issues.filter((i) => i.kind === s.kind) ?? [];
        if (!issues.length) return null;
        return (
          <section key={s.kind} className="health-section">
            <h2 className={s.bad ? "bad" : undefined}>
              <s.Icon size={18} /> {s.title} <span className="count">{issues.length}</span>
            </h2>
            <p className="health-why">{s.why}</p>
            <ul className="history-list">
              {issues.map((i) => (
                <HealthRow key={i.id} b={props.b} issue={i} bad={s.bad} />
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function HealthRow(props: { b: Browse; issue: HealthIssue; bad: boolean }) {
  const { issue } = props;
  const m = props.b.cat.byId.get(issue.id);
  const art = m && props.b.details ? (m.meta?.stillPath ?? m.meta?.backdropPath ?? null) : null;
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const ep = m?.episode;
  const title = !m
    ? issue.relPath.split("/").pop()
    : ep
      ? [m.meta?.show ?? ep.show, episodeLabel(ep.season, ep.episode), m.meta?.title ?? ep.title].filter(Boolean).join(" · ")
      : (m.meta?.title ?? m.title);
  // Shown the way the server's computer writes it (backslashes on Windows).
  const shown = issue.path.includes("\\") ? issue.relPath.replaceAll("/", "\\") : issue.relPath;
  const copy = () => {
    void navigator.clipboard?.writeText(issue.path).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <li className="history-row health-row">
      <span className="history-art">{art && !failed ? <img src={imageUrl(art, "w300")} alt="" loading="lazy" onError={() => setFailed(true)} /> : <FileSearchIcon size={20} />}</span>
      <span className="history-text">
        <span className="history-title">{title}</span>
        <button className="health-path" onClick={copy} title="Copy where this file is">
          {copied ? "Copied" : shown}
        </button>
      </span>
      <span className={props.bad ? "history-state bad" : "history-state"}>{issue.detail}</span>
    </li>
  );
}

/** "today at 9:41 PM", "yesterday at 9:41 PM", "Oct 16 at 9:41 PM". */
function checkedWhen(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  const day = days === 0 ? "today" : days === 1 ? "yesterday" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${day} at ${time}`;
}
