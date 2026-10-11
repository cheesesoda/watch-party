import { useEffect, useRef, useState } from "react";
import { streamUrl, subtitleUrl } from "./api.ts";
import { ChatOverlay } from "./ChatOverlay.tsx";
import { Library } from "./Library.tsx";
import { navigate } from "./nav.ts";
import { useRoom } from "./useRoom.ts";
import { VideoSync } from "./sync.ts";
import { Ducker, Voice, type VoiceStatus } from "./voice.ts";

export function Room(props: { roomId: string; name: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncRef = useRef<VideoSync | null>(null);
  const [pinned, setPinned] = useState(false);
  const [picking, setPicking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [idle, setIdle] = useState(false);
  const [copied, setCopied] = useState(false);
  const voiceRef = useRef<Voice | null>(null);
  const duckerRef = useRef<Ducker | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [muted, setMuted] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<string | null>(null);

  const { view, send } = useRoom(props.roomId, props.name, {
    onState: (s) => syncRef.current?.setState(s),
    onPong: (c, s) => syncRef.current?.onPong(c, s),
    onWelcome: (me) => voiceRef.current?.rejoin(me.id),
    onMembers: (members) => voiceRef.current?.syncMembers(members),
    onVoicePeers: (peers) => voiceRef.current?.callAll(peers),
    onSignal: (from, data) => voiceRef.current?.onSignal(from, data).catch((e) => console.warn("voice signal", e)),
  });
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const sync = new VideoSync(videoRef.current!, (m) => sendRef.current(m));
    sync.onAutoplayBlocked = setBlocked;
    syncRef.current = sync;
    const ducker = new Ducker(videoRef.current!);
    duckerRef.current = ducker;
    return () => {
      sync.destroy();
      ducker.destroy();
      voiceRef.current?.stop();
      voiceRef.current = null;
    };
  }, []);

  // Lower the movie while anyone else is talking.
  useEffect(() => {
    duckerRef.current?.set([...speaking].some((id) => id !== view.me?.id));
  }, [speaking, view.me?.id]);

  useEffect(() => {
    if (!info) return;
    const t = window.setTimeout(() => setInfo(null), 6000);
    return () => window.clearTimeout(t);
  }, [info]);

  const toggleVoice = async () => {
    const current = voiceRef.current;
    if (current) {
      current.stop();
      voiceRef.current = null;
      setVoiceStatus("off");
      setSpeaking(new Set());
      setBroken(new Set());
      return;
    }
    if (!view.me) return;
    const voice = new Voice((m) => sendRef.current(m), view.iceServers);
    voice.onSpeaking = setSpeaking;
    voice.onPeerHealth = (id, ok) =>
      setBroken((prev) => {
        if (ok !== prev.has(id)) return prev;
        const next = new Set(prev);
        if (ok) next.delete(id);
        else next.add(id);
        return next;
      });
    voiceRef.current = voice;
    setVoiceStatus("starting");
    const problem = await voice.start(view.me.id, false);
    if (voiceRef.current !== voice) return;
    setHasMic(voice.hasMic);
    setMuted(false);
    setVoiceStatus("on");
    if (problem) setInfo(problem);
  };

  const toggleMute = () => {
    voiceRef.current?.setMuted(!muted);
    setMuted(!muted);
  };

  // Re-apply the room state once the new source has loaded.
  useEffect(() => {
    if (view.state) syncRef.current?.setState(view.state);
  }, [view.media?.id]);

  // Hide the top bar after a few seconds without mouse or remote input.
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
    window.addEventListener("keydown", wake);
    wake();
    return () => {
      window.clearTimeout(t);
      el.removeEventListener("mousemove", wake);
      el.removeEventListener("touchstart", wake);
      window.removeEventListener("keydown", wake);
    };
  }, []);

  // TV remotes and keyboards: arrows seek, media keys play and pause.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      const video = videoRef.current;
      if (!video?.src) return;
      const onButton = Boolean(target?.closest("button"));
      const key = e.key;
      const code = e.keyCode;
      if (key === "ArrowLeft" && !onButton) video.currentTime = Math.max(0, video.currentTime - 10);
      else if (key === "ArrowRight" && !onButton) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
      // webOS remotes send 415 (play), 19 (pause), 412 (rewind) and 417 (fast-forward).
      else if (key === "MediaPlayPause" || (key === " " && !onButton)) void (video.paused ? video.play() : video.pause());
      else if (key === "MediaPlay" || code === 415) void video.play();
      else if (key === "MediaPause" || code === 19) video.pause();
      else if (key === "MediaRewind" || code === 412) video.currentTime = Math.max(0, video.currentTime - 30);
      else if (key === "MediaFastForward" || code === 417) video.currentTime += 30;
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
            {view.status === "open" ? [...new Set(view.members.map((m) => m.name))].join(", ") : view.status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={invite}>{copied ? "Link copied" : "Invite"}</button>
        <button onClick={() => setPicking(true)}>Change video</button>
        <button className={voiceStatus === "off" ? "" : "on"} onClick={toggleVoice} disabled={voiceStatus === "starting" || view.status !== "open"}>
          {voiceStatus === "off" ? "Join voice" : voiceStatus === "starting" ? "Joining…" : "Leave voice"}
        </button>
        {voiceStatus === "on" && hasMic && <button onClick={toggleMute}>{muted ? "Unmute" : "Mute"}</button>}
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
      {info && !view.error && <div className="toast info">{info}</div>}

      {view.members.some((m) => m.voice) && (
        <div className="voice-strip" aria-label="Voice chat">
          {view.members
            .filter((m) => m.voice)
            .map((m) => (
              <span
                key={m.id}
                className={`voice-chip${speaking.has(m.id) ? " talking" : ""}${broken.has(m.id) ? " broken" : ""}`}
                title={broken.has(m.id) ? `Can't reach ${m.name}'s voice. Your networks may need a TURN server (see the README).` : undefined}
              >
                {m.muted && <MicOff />}
                {m.name}
                {m.id === view.me?.id && " (you)"}
              </span>
            ))}
        </div>
      )}

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

function MicOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-label="muted">
      <path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7M19 11a7 7 0 0 1-1.1 3.8M5 11a7 7 0 0 0 11.2 5.6M12 19v3M3 3l18 18" />
    </svg>
  );
}
