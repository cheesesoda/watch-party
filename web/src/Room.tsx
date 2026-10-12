import { useEffect, useRef, useState } from "react";
import type { MediaInfo } from "../../shared/protocol.ts";
import { api, hlsUrl, streamUrl, subtitleUrl } from "./api.ts";
import { ChatOverlay } from "./ChatOverlay.tsx";
import { BackIcon, ChatIcon, CheckIcon, ExitFullscreenIcon, FullscreenIcon, HeadphonesIcon, ListVideoIcon, MicIcon, MicOffIcon, PowerIcon, SettingsIcon, ShareIcon } from "./Icons.tsx";
import { inviteLink } from "./Home.tsx";
import { Library } from "./Library.tsx";
import { navigate } from "./nav.ts";
import { canPlayDirect, hasMse } from "./playable.ts";
import { useRoom } from "./useRoom.ts";
import { VideoSync } from "./sync.ts";
import { Ducker, Voice, type VoiceStatus } from "./voice.ts";

/** Whether chat messages pop up over the video; remembered per browser. */
const POPUPS_KEY = "chat-popups";

/** `host` is false for viewers who joined with the code: they can't change the video or end the party. */
export function Room(props: { roomId: string; name: string; host: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncRef = useRef<VideoSync | null>(null);
  const [pinned, setPinned] = useState(false);
  const [popups, setPopups] = useState(() => {
    try {
      return localStorage.getItem(POPUPS_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const changePopups = (on: boolean) => {
    setPopups(on);
    try {
      localStorage.setItem(POPUPS_KEY, on ? "on" : "off");
    } catch {}
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [idle, setIdle] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const voiceRef = useRef<Voice | null>(null);
  const duckerRef = useRef<Ducker | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("off");
  const [muted, setMuted] = useState(false);
  const [hasMic, setHasMic] = useState(false);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<string | null>(null);
  /** What the server found in the current file; null if it couldn't tell, undefined while asking. */
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null | undefined>(undefined);
  /** Playing the server's converted copy instead of the original file. */
  const [converted, setConverted] = useState(false);

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

  const mediaId = view.media?.id;

  // Find out what is in the file, and convert it up front if this browser can't play it.
  useEffect(() => {
    setMediaInfo(undefined);
    setConverted(false);
    if (!mediaId) return;
    let cancelled = false;
    api
      .info(mediaId)
      .catch(() => null)
      .then((i) => {
        if (cancelled) return;
        setMediaInfo(i);
        setConverted(Boolean(i?.convert && !canPlayDirect(i)));
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  // Point the video at the original file or the converted stream.
  useEffect(() => {
    const video = videoRef.current!;
    if (!mediaId || mediaInfo === undefined) return;
    let destroy = () => {};
    let cancelled = false;
    if (!converted) {
      video.src = streamUrl(mediaId);
    } else if (!hasMse()) {
      // iPhones have no MediaSource for hls.js but play HLS themselves.
      video.src = hlsUrl(mediaId);
    } else {
      // hls.js even where the browser says it plays HLS itself. Newer Chrome-based browsers say so,
      // and leaving the stream to them is the likely reason Brave showed a dead player.
      void import("hls.js").catch(() => {
        setInfo("Couldn't load the player for converted video. Reload the page.");
        return null;
      }).then((mod) => {
        if (cancelled || !mod) return;
        const Hls = mod.default;
        // The server may need several seconds to start converting from a new spot, so wait for it.
        const wait = { maxTimeToFirstByteMs: 45_000, maxLoadTimeMs: 120_000, timeoutRetry: null, errorRetry: { maxNumRetry: 2, retryDelayMs: 1000, maxRetryDelayMs: 4000 } };
        const hls = new Hls({ startPosition: syncRef.current?.expected() ?? 0, fragLoadPolicy: { default: wait } });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setInfo(`The converted stream failed: ${data.details}. Check the server's console.`);
        });
        hls.loadSource(hlsUrl(mediaId));
        hls.attachMedia(video);
        destroy = () => hls.destroy();
      });
    }
    return () => {
      cancelled = true;
      destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [mediaId, mediaInfo, converted]);

  // If the original won't play after all (an error, or sound with no picture), switch to converting.
  useEffect(() => {
    const video = videoRef.current!;
    if (converted || !mediaInfo) return;
    const fallBack = () => {
      if (mediaInfo.convert) {
        setConverted(true);
        setInfo("This browser can't play the original file, so the server is converting it.");
      } else {
        setInfo("This browser can't play this file. Install ffmpeg on the server so it can convert it, or use the Android app.");
      }
    };
    const onError = () => {
      if (video.getAttribute("src")) fallBack();
    };
    const onLoaded = () => {
      if (mediaInfo.video && video.videoWidth === 0) fallBack();
    };
    video.addEventListener("error", onError);
    video.addEventListener("loadeddata", onLoaded);
    return () => {
      video.removeEventListener("error", onError);
      video.removeEventListener("loadeddata", onLoaded);
    };
  }, [mediaInfo, converted]);

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
    const link = inviteLink(props.roomId);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      prompt("Copy this invite link", link);
    }
  };

  // Once the party is gone, release the mic.
  useEffect(() => {
    if ((view.status === "ended" || view.status === "missing") && voiceRef.current) {
      voiceRef.current.stop();
      voiceRef.current = null;
      setVoiceStatus("off");
    }
  }, [view.status]);

  const endParty = () => {
    if (confirm("End this watch party for everyone?")) send({ type: "end" });
  };

  if (view.status === "missing" || view.status === "ended") {
    return (
      <div className="center">
        <div className="card">
          <p>{view.status === "ended" ? `${view.endedBy ?? "Someone"} ended the watch party.` : "This watch party has ended or the code is wrong."}</p>
          <button className="primary" onClick={() => navigate("/")}>
            Back
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
        <button className="icon" onClick={() => navigate("/")} title="Leave" aria-label="Leave">
          <BackIcon />
        </button>
        <div className="room-title">
          <strong>{media?.title ?? "Nothing playing"}</strong>
          <span className="muted">
            {view.status === "open" ? [...new Set(view.members.map((m) => m.name))].join(", ") : view.status === "connecting" ? "Connecting…" : "Reconnecting…"}
          </span>
        </div>
        <span className="spacer" />
        {props.host && (
          <button className="icon" onClick={() => setPicking(true)} title="Change video" aria-label="Change video">
            <ListVideoIcon />
          </button>
        )}
        <button
          className={voiceStatus === "off" ? "icon" : "icon on"}
          onClick={toggleVoice}
          disabled={voiceStatus === "starting" || view.status !== "open"}
          title={voiceStatus === "off" ? "Join voice" : voiceStatus === "starting" ? "Joining voice…" : "Leave voice"}
          aria-label={voiceStatus === "off" ? "Join voice" : voiceStatus === "starting" ? "Joining voice" : "Leave voice"}
          aria-pressed={voiceStatus === "on"}
        >
          <HeadphonesIcon />
        </button>
        {voiceStatus === "on" && hasMic && (
          <button className="icon" onClick={toggleMute} title={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"}>
            {muted ? <MicOffIcon /> : <MicIcon />}
          </button>
        )}
        <span className="divider" />
        <button
          className="icon"
          onClick={invite}
          title={copied ? "Invite link copied" : `Invite · party code ${props.roomId.toUpperCase()}`}
          aria-label={copied ? "Invite link copied" : "Invite"}
        >
          {copied ? <CheckIcon /> : <ShareIcon />}
        </button>
        <button className={pinned ? "icon on" : "icon"} onClick={() => setPinned(!pinned)} title="Chat" aria-label="Chat" aria-pressed={pinned}>
          <ChatIcon />
        </button>
        <button className="icon" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
          <SettingsIcon />
        </button>
        <button className="icon" onClick={toggleFullscreen} title={fullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        {props.host && (
          <button className="icon end" onClick={endParty} disabled={view.status !== "open"} title="End party for everyone" aria-label="End party">
            <PowerIcon />
          </button>
        )}
      </div>

      {!media && !picking && (
        <div className="room-empty">
          {props.host ? (
            <>
              <p>Pick something to watch together. Friends join with the code {props.roomId.toUpperCase()}.</p>
              <button className="primary" onClick={() => setPicking(true)}>
                Browse library
              </button>
            </>
          ) : (
            <p>Waiting for the host to pick something.</p>
          )}
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

      <ChatOverlay chat={view.chat} me={view.me} pinned={pinned} popups={popups} onSend={(text) => send({ type: "chat", text })} />

      {settingsOpen && (
        <div className="modal" onClick={() => setSettingsOpen(false)}>
          <div className="modal-body settings" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Settings on this device</h2>
              <button onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
            <label className="switch-row">
              <span>
                Pop up new chat messages over the video
                <small>Each device keeps its own setting, so pop-ups can be on the TV and off on your phone.</small>
              </span>
              <input type="checkbox" role="switch" checked={popups} onChange={(e) => changePopups(e.target.checked)} />
            </label>
            {mediaInfo?.convert && (
              <label className="switch-row">
                <span>
                  Play the server's converted copy
                  <small>Turns on by itself when this browser can't play the file. Turn it on if the picture or sound is missing. Only this video, on this device.</small>
                </span>
                <input type="checkbox" role="switch" checked={converted} onChange={(e) => setConverted(e.target.checked)} />
              </label>
            )}
          </div>
        </div>
      )}

      {picking && props.host && (
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
