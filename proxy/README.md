# Popcorn Club proxy

Runs on Railway in front of the host's PC, so the web app lives at `app.tv.chzsda.com` and invites at `tv.chzsda.com/join/CODE`. See "Your own address" in [docs/guide.md](../docs/guide.md).

| Variable | Default | |
|---|---|---|
| `UPSTREAM` | `https://omnipotent.tail3b2bb0.ts.net` | The Popcorn Club server (its Tailscale Funnel address). |
| `APP_HOST` | `app.tv.chzsda.com` | Passed through to the server: pages, API, party connection. |
| `INVITE_HOST` | `tv.chzsda.com` | `/join/CODE` forwards to the app; `/.well-known/` comes from the server. |
| `PROXY_KEY` | empty | Shared with the server's `PROXY_KEY` so sign-in limits count per visitor. |

No dependencies. `npm start` runs it, `npm test` tests it.
