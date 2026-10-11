import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientMessage, MediaItem, Member, PlaybackState, ServerMessage } from "../../shared/protocol.ts";

export interface RoomView {
  status: "connecting" | "open" | "closed" | "missing";
  me: Member | null;
  members: Member[];
  chat: ChatMessage[];
  media: MediaItem | null;
  state: PlaybackState | null;
  error: string | null;
}

export interface RoomHandlers {
  onState?: (state: PlaybackState) => void;
  onPong?: (clientTime: number, serverTime: number) => void;
}

/** Connects to a room over WebSocket, reconnecting with backoff until unmounted. */
export function useRoom(roomId: string, name: string, handlers: RoomHandlers) {
  const [view, setView] = useState<RoomView>({
    status: "connecting",
    me: null,
    members: [],
    chat: [],
    media: null,
    state: null,
    error: null,
  });
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const qs = new URLSearchParams({ room: roomId, name });
      const ws = new WebSocket(`${proto}://${location.host}/ws?${qs}`);
      wsRef.current = ws;
      setView((v) => ({ ...v, status: "connecting" }));

      const ping = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
      };

      ws.onopen = () => {
        retry = 0;
        // A burst of pings gives a good clock estimate quickly, then settle down.
        for (let i = 0; i < 4; i++) setTimeout(ping, i * 250);
        pingTimer = window.setInterval(ping, 10_000);
      };

      ws.onmessage = (ev) => {
        const msg: ServerMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case "welcome":
            setView({
              status: "open",
              me: msg.you,
              members: msg.members,
              chat: msg.chat,
              media: msg.media,
              state: msg.state,
              error: null,
            });
            handlersRef.current.onState?.(msg.state);
            break;
          case "state":
            setView((v) => ({ ...v, state: msg.state, media: msg.media }));
            handlersRef.current.onState?.(msg.state);
            break;
          case "members":
            setView((v) => ({ ...v, members: msg.members }));
            break;
          case "chat":
            setView((v) => ({ ...v, chat: [...v.chat.slice(-199), msg.message] }));
            break;
          case "pong":
            handlersRef.current.onPong?.(msg.clientTime, msg.serverTime);
            break;
          case "error":
            setView((v) => ({ ...v, error: msg.message }));
            break;
        }
      };

      ws.onclose = (ev) => {
        window.clearInterval(pingTimer);
        if (stopped) return;
        if (ev.code === 4404) {
          setView((v) => ({ ...v, status: "missing" }));
          return;
        }
        setView((v) => ({ ...v, status: "closed" }));
        retryTimer = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(pingTimer);
      wsRef.current?.close();
    };
  }, [roomId, name]);

  const send = (msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  return { view, send };
}
