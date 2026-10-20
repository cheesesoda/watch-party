import { useEffect, useRef, useState } from "react";
import type { MediaItem, SubtitleSearch } from "../../shared/protocol.ts";
import { api, imageUrl, type LibraryResponse } from "./api.ts";
import { CaptionsIcon, CheckIcon, DownloadIcon } from "./Icons.tsx";

/** Whether a video has English subtitles beside it (or ones with no language, which are usually English). */
export const hasEnglish = (item: MediaItem) => item.subtitles.some((t) => !/forced/i.test(t.label) && (!t.lang || /^(en|eng)\b/i.test(t.lang)));

/**
 * Find subtitles (⋮ on a movie or episode without English ones): English subtitles from OpenSubtitles, the ones made
 * for this very file first. The server saves the pick in its data folder, so every player gets it.
 */
export function FindSubtitlesDialog(props: {
  item: MediaItem;
  title: string;
  sub: string;
  poster: string | null;
  onCancel: () => void;
  onAdded: (r: LibraryResponse) => void;
}) {
  const [found, setFound] = useState<SubtitleSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const download = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    api.findSubtitles(props.item.id).then(
      (r) => {
        setFound(r);
        setPicked(r.results[0]?.fileId ?? null);
      },
      (e) => setError((e as Error).message),
    );
  }, [props.item.id]);
  useEffect(() => {
    if (found?.results.length) download.current?.focus();
  }, [found]);

  const submit = async () => {
    if (picked === null) return;
    setBusy(true);
    setError(null);
    try {
      props.onAdded(await api.downloadSubtitles(props.item.id, picked));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const remaining = found?.remaining;
  return (
    <div
      className="save-spot-backdrop"
      onClick={props.onCancel}
      onKeyDown={(e) => {
        if (e.key === "Escape") props.onCancel();
      }}
    >
      <div className="save-spot find-subs" role="dialog" aria-modal="true" aria-labelledby="find-subs-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="find-subs-title">Find subtitles</h2>
        <div className="save-spot-item">
          {props.poster && <img className="schedule-poster" src={imageUrl(props.poster, "w185")} alt="" />}
          <span>
            <b>{props.title}</b>
            <small>{[props.sub, "No English subtitles"].filter(Boolean).join(" · ")}</small>
          </span>
        </div>
        {!found && !error && <p className="find-subs-help">Looking on OpenSubtitles…</p>}
        {found && !found.configured && (
          <p className="find-subs-help">
            Find subtitles needs a free OpenSubtitles account. Add <b>OPENSUBTITLES_API_KEY</b>, <b>OPENSUBTITLES_USERNAME</b> and{" "}
            <b>OPENSUBTITLES_PASSWORD</b> to the server's .env, then restart it (the guide says how).
          </p>
        )}
        {found?.inside && <p className="find-subs-help">This video already has English subtitles inside the file. You can still add these.</p>}
        {found?.error && <p className="error">{found.error}</p>}
        {found?.configured && !found.error && found.results.length === 0 && <p className="find-subs-help">OpenSubtitles has no English subtitles for this one.</p>}
        {found && found.results.length > 0 && (
          <>
            <p className="find-subs-help">English subtitles from OpenSubtitles, best match first.</p>
            <div className="find-subs-list" role="radiogroup" aria-label="Subtitles">
              {found.results.map((r) => (
                <button
                  key={r.fileId}
                  role="radio"
                  aria-checked={picked === r.fileId}
                  className={picked === r.fileId ? "find-subs-row on" : "find-subs-row"}
                  onClick={() => setPicked(r.fileId)}
                >
                  <span className="find-subs-radio" />
                  <span className="find-subs-text">
                    <span className="find-subs-release">{r.release}</span>
                    <span className="find-subs-meta">
                      {r.hashMatch && (
                        <span className="find-subs-match">
                          <CheckIcon size={14} /> Made for this file
                        </span>
                      )}
                      {r.hearingImpaired && (
                        <span>
                          <CaptionsIcon size={14} /> Includes sound descriptions
                        </span>
                      )}
                      <span>
                        <DownloadIcon size={14} /> {r.downloads.toLocaleString()} downloads
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="save-spot-actions">
          {remaining != null && <span className="find-subs-left">{remaining === 1 ? "1 download" : `${remaining} downloads`} left today</span>}
          <span className="spacer" />
          <button className="pill text accent" onClick={props.onCancel}>
            Cancel
          </button>
          {found && found.results.length > 0 && (
            <button className="pill primary" ref={download} disabled={busy || picked === null} onClick={() => void submit()}>
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
