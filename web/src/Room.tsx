import { useEffect, useRef, useState } from "react";
import { streamUrl, subtitleUrl } from "./api.ts";
import { ChatOverlay } from "./ChatOverlay.tsx";
import { Library } from "./Library.tsx";
import { navigate } from "./nav.ts";
import { useRoom } from "./useRoom.ts";
import { VideoSync } from "./sync.ts";

export function Room(props: { roomId: string; name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncRef = useRef<VideoSync | null>(null);
  const [pinned, setPinned] = useState(false);
  const [picking, setPicking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [idle, setIdle] = useState(false);
  const [copied, setCopied] = useState(false);

  const { view, send } = useRoom(props.roomId, props.name, {
    onState: (s) => syncRef.current?.setState(s),
    onPong: (c, s) => syncRef.current?.onPong(c, s),
  });
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const sync = new VideoSync(videoRef.current!, (m) => sendRef.current(m));
    sync.onAutoplayBlocked = setBlocked;
    syncRef.current = sync;
    return () => sync.destroy();
  }, []);

  // Re-apply the room state once the new source has loaded.
  useEffect(() => {
    if (view.state) syncRef.current?.setState(view.state);
  }, [view.media?.id]);

  // Hide the top bar after a few seconds without mouse movement.
  useEffect(() => {
    let t: number | undefined;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), 3000);
    };
    const el = containerRef.current!;
    el.addEventListener("mousemove", wake);
    el.addEventListener("touchstart", wake);
    wake();
    return () => {
      window.clearTimeout(t);
      el.removeEventListener("mousemove", wake);
      el.removeEventListener("touchstart", wake);
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen?.();
  };

  const invite = async () => {
    const link = `${location.origin}${location.pathname}#/room/${props.roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this invite link", link);
    }
  };

  if (view.status === "missing") {
    return (
      <div className="center">
        <div className="card">
          <p>This watch party has ended or the code is wrong.</p>
          <button className="primary" onClick={() => navigate("/")}>
            Back to library
          </button>
        </div>
      </div>
    );
  }

  const media = view.media;

  return (
    <div className={`room ${idle && !picking ? "idle" : ""}`} ref={containerRef}>
      <video
        ref={videoRef}
        className={media ? "" : "hidden"}
        src={media ? streamUrl(media.id) : undefined}
        controls
        controlsList="nofullscreen"
        playsInline
        preload="auto"
        onDoubleClick={toggleFullscreen}
      >
        {media?.subtitles.map((s) => (
          <track key={`${media.id}-${s.index}`} kind="subtitles" label={s.label} srcLang={s.lang ?? undefined} src={subtitleUrl(media.id, s.index)} default={s.index === 0} />
        ))}
      </video>

      <div className="room-top">
        <button onClick={() => navigate("/")} title="Leave">
          ←
        </button>
        <div className="room-title">
          <strong>{media?.title ?? "Nothing playing"}</strong>
          <span className="muted">
            {view.status === "open" ? view.members.map((m) => m.name).join(", ") : view.status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={invite}>{copied ? "Link copied" : "Invite"}</button>
        <button onClick={() => setPicking(true)}>Change video</button>
        <button className={pinned ? "on" : ""} onClick={() => setPinned(!pinned)}>
          Chat
        </button>
        <button onClick={toggleFullscreen}>Fullscreen</button>
      </div>

      {!media && !picking && (
        <div className="room-empty">
          <p>Pick something to watch together.</p>
          <button className="primary" onClick={() => setPicking(true)}>
            Browse library
          </button>
        </div>
      )}

      {blocked && (
        <button className="join-overlay" onClick={() => videoRef.current?.play()}>
          ▶ Click to join playback
        </button>
      )}

      {view.error && <div className="toast">{view.error}</div>}

      <ChatOverlay chat={view.chat} me={view.me} pinned={pinned} onSend={(text) => send({ type: "chat", text })} />

      {picking && (
        <div className="modal" onClick={() => setPicking(false)}>
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Choose a video</h2>
              <button onClick={() => setPicking(false)}>Close</button>
            </div>
            <Library
              actionLabel="Play for everyone"
              onPick={(item) => {
                send({ type: "select", mediaId: item.id });
                setPicking(false);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
