import { useEffect, useState } from "react";
import { api, getName, setName, Unauthorized, type Me } from "./api.ts";
import { Home } from "./Home.tsx";
import { Join, Landing, Login } from "./Login.tsx";
import { navigate } from "./nav.ts";
import { Pair } from "./Pair.tsx";
import { Room } from "./Room.tsx";

/**
 * Hash routes: "#/" start or join, "#/start" host sign-in, "#/join/<code>" join a party,
 * "#/room/<code>" a watch party, "#/pair/<id>" sign in a TV from its QR code. Hash routing keeps invite links working behind any server.
 */
function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

export function App() {
  const route = useHashRoute();
  /** null while checking; "out" when neither the host nor a guest. */
  const [me, setMe] = useState<Me | "out" | null>(null);
  const [name, setNameState] = useState(getName());

  // Re-check on every route change: a guest pass stops working when its party ends.
  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((err) => setMe(err instanceof Unauthorized ? "out" : { role: "host" }));
  }, [route]);

  const saveName = (n: string) => {
    setName(n);
    setNameState(n);
  };

  if (me === null) return <div className="center muted">Loading…</div>;
  const host = me !== "out" && me.role === "host";
  const guestRoom = me !== "out" && me.role === "guest" ? me.room : null;

  const pairId = /^\/pair\/([\w-]+)/.exec(route)?.[1];
  if (pairId) return <Pair id={pairId} host={host} initialName={name} />;

  const code = /^\/(?:room|join)\/([\w-]*)/.exec(route)?.[1]?.toLowerCase();
  if (code !== undefined) {
    if (code && (host || guestRoom === code) && name) return <Room roomId={code} name={name} host={host} />;
    return (
      <Join
        initialName={name}
        initialCode={code}
        onDone={(n, roomId) => {
          saveName(n);
          if (!host) setMe({ role: "guest", room: roomId });
          navigate(`/room/${roomId}`);
        }}
      />
    );
  }

  if (route === "/start" || (host && !name)) {
    return (
      <Login
        needPassword={!host}
        initialName={name}
        onDone={(n) => {
          saveName(n);
          setMe({ role: "host" });
          navigate("/");
        }}
      />
    );
  }

  if (host) {
    return <Home route={route} name={name} onRename={() => saveName("")} onSignOut={() => api.logout().then(() => setMe("out"))} />;
  }
  return <Landing />;
}
