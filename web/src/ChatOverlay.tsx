import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage, Member } from "../../shared/protocol.ts";

const FADE_MS = 10_000;

/**
 * Chat drawn over the video. Recent messages float in and fade out unless pop-ups are off; focusing
 * the input (press Enter anywhere) or pinning shows the full history.
 */
export function ChatOverlay(props: {
  chat: ChatMessage[];
  me: Member | null;
  pinned: boolean;
  popups: boolean;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const expanded = props.pinned || focused;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "Enter" && !["INPUT", "TEXTAREA", "BUTTON"].includes(target.tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [props.chat.length, expanded]);

  const visible = expanded
    ? props.chat.slice(-100)
    : props.popups
      ? props.chat.slice(-6).filter((m) => now - m.ts < FADE_MS)
      : [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    props.onSend(t);
    setText("");
  };

  return (
    <div className={`chat ${expanded ? "expanded" : ""} ${props.popups ? "" : "quiet"}`}>
      <div className="chat-list" ref={listRef}>
        {visible.map((m) => (
          <div
            key={m.id}
            className={`chat-msg ${m.system ? "system" : ""} ${m.from === props.me?.name ? "mine" : ""}`}
            style={!expanded ? { opacity: Math.min(1, (FADE_MS - (now - m.ts)) / 2000) } : undefined}
          >
            {!m.system && <span className="from">{m.from}</span>}
            <span className="text">{m.text}</span>
          </div>
        ))}
      </div>
      <form onSubmit={submit}>
        <input
          ref={inputRef}
          value={text}
          maxLength={500}
          placeholder={focused ? "Say something…" : "Press Enter to chat"}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") inputRef.current?.blur();
          }}
        />
      </form>
    </div>
  );
}
