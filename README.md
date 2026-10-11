# Watch Party

Self-hosted watch parties for you and your friends, a bit like Plex's Watch Together but much smaller.
Run the server on the machine that has your movies. Friends open a link, everyone sees the same library,
and whoever starts a party picks a file. Play, pause and seeking stay in sync for everyone, and there's
a chat overlay on top of the video.

- **Server** (`server/`): Node + TypeScript. Indexes your media folder, streams files with HTTP range
  requests, and runs watch party rooms over WebSocket.
- **Web** (`web/`): React app served by the server.
- **Android** (`android/`): phone and Android TV app (coming in a follow-up PR).

## Run it

### With Docker

```sh
cp .env.example .env        # set WATCH_PASSWORD and MEDIA_PATH
docker compose up -d --build
```

Open http://localhost:8080.

### Without Docker

Needs Node 20 or newer.

```sh
npm ci
npm run build
WATCH_PASSWORD=change-me MEDIA_DIR=/path/to/movies npm start
```

### Settings

| Variable | Default | |
| --- | --- | --- |
| `WATCH_PASSWORD` | _(none)_ | Shared password everyone signs in with. Without it the server is open to anyone who can reach it. |
| `MEDIA_DIR` | `./media` | Folder to index. Use `MEDIA_DIRS` with commas for several. Subfolders show up as groups. |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |

The library rescans every minute when someone browses it, and there's a Rescan button.

## Letting friends in

Your friends need to reach the server. The easiest options:

- **Tailscale** (recommended): install it on the server and invite friends to your tailnet, or use
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) to get a public HTTPS URL without opening ports.
- **Port forward** 8080 on your router, ideally behind a reverse proxy like Caddy for HTTPS.

Then send them the invite link from the room's **Invite** button. They sign in with the password and pick a name.

Upload speed matters: each viewer streams the file directly from your server, so a 10 Mbps 1080p file
watched by three friends needs about 30 Mbps of upload.

## Video formats

There's no transcoding yet, so files play as-is:

- **Works everywhere:** MP4 with H.264 video and AAC audio, and WebM.
- **Android app only (usually):** MKV, HEVC/H.265, AC3/DTS audio. Browsers mostly can't play these, and the
  library marks them "may not play in browser".

To convert a file for the browser: `ffmpeg -i in.mkv -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4`.

Subtitles: put `.srt` or `.vtt` files next to the video with the same name (`Movie.mp4` + `Movie.srt`,
or `Movie.en.srt` for a language tag). They're converted to WebVTT on the fly.

## How syncing works

The server keeps one playback state per room: which file, paused or playing, and the position at a
server timestamp. Anyone can play, pause, seek or change the video, and the server broadcasts the new
state. Each client estimates its clock offset from the server with pings, works out where playback
should be right now, and nudges playback speed to fix small drift or seeks to fix big drift. People who
join late land at the right spot.

## Development

```sh
npm ci
npm run dev -w server   # API on :8080 (set MEDIA_DIR)
npm run dev -w web      # Vite on :5173, proxies /api and /ws to :8080
npm test                # server tests
npm run typecheck
```

The wire protocol lives in `shared/protocol.ts`.
