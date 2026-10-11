import { useEffect, useState } from "react";
import { api, getName, setName, Unauthorized } from "./api.ts";
import { Home } from "./Home.tsx";
import { Login } from "./Login.tsx";
import { Room } from "./Room.tsx";

/** Hash routes: "#/" home, "#/room/<id>" a watch party. Hash routing keeps invite links working behind any server. */
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
  const [auth, setAuth] = useState<"checking" | "in" | "out">("checking");
  const [name, setNameState] = useState(getName());

  useEffect(() => {
    api
      .me()
      .then(() => setAuth("in"))
      .catch((err) => setAuth(err instanceof Unauthorized ? "out" : "in"));
  }, []);

  if (auth === "checking") return <div className="center muted">Loading…</div>;
  if (auth === "out" || !name) {
    return (
      <Login
        needPassword={auth === "out"}
        initialName={name}
        onDone={(n) => {
          setName(n);
          setNameState(n);
          setAuth("in");
        }}
      />
    );
  }

  const roomMatch = /^\/room\/([\w-]+)/.exec(route);
  if (roomMatch) return <Room roomId={roomMatch[1]} name={name} />;
  return <Home name={name} onRename={() => setNameState("")} onSignOut={() => api.logout().then(() => setAuth("out"))} />;
}
