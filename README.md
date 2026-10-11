# Watch Party

Self-hosted watch parties for you and your friends, a bit like Plex's Watch Together but much smaller.
Run the server on the machine that has your movies. Friends open a link, everyone sees the same library,
and whoever starts a party picks a file. Play, pause and seeking stay in sync for everyone, and there's
a chat overlay on top of the video.

**New here?** The [setup and user guide](docs/guide.md) walks through hosting, joining on web and
Android TV, voice chat, and troubleshooting.

- **Server** (`server/`): Node + TypeScript. Indexes your media folder, streams files with HTTP range
  requests, and runs watch party rooms over WebSocket.
- **Web** (`web/`): React app served by the server.
- **Android** (`android/`): one app for phones and Android TV, using ExoPlayer.

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

Or put the settings in `.env` (copy `.env.example`); the server reads it, and shell variables override it.
On Windows, see the [guide's PowerShell steps](docs/guide.md#windows-powershell).

### Settings

| Variable | Default | |
| --- | --- | --- |
| `WATCH_PASSWORD` | _(required)_ | Shared password everyone signs in with. The server won't start without it. |
| `ALLOW_NO_PASSWORD` | _(off)_ | Set to `1` to run with no password at all. Only do this on a network you trust. |
| `MEDIA_DIR` | `./media` | Folder to index. Use `MEDIA_DIRS` with commas for several. Subfolders show up as groups. |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | |
| `TRUST_PROXY` | `loopback` | Proxies whose `X-Forwarded-For` header is believed, so the login limit counts each visitor separately. The Docker setup also trusts Docker's own network. Use Express ["trust proxy"](https://expressjs.com/en/guide/behind-proxies.html) syntax. |
| `ICE_SERVERS` | Google's public STUN | JSON list of STUN/TURN servers for voice chat, e.g. `[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]`. See [Voice chat](#voice-chat). |

The library rescans every minute when someone browses it, and there's a Rescan button.

## Letting friends in

Your friends need to reach the server. The easiest options:

- **Tailscale** (recommended): install it on the server and invite friends to your tailnet, or use
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) to get a public HTTPS URL without opening ports.
- **Port forward** 8080 on your router, ideally behind a reverse proxy like Caddy for HTTPS.

Then send them the invite link from the room's **Invite** button. They sign in with the password and pick a name.

### Security

Your library is only as private as your running server. The code itself holds no secrets: the
password and media path come from your environment (`.env`, which git ignores), so anyone else running
this code gets their own empty server and can't see yours.

- Prefer Tailscale over opening a port, so strangers can't reach the server at all.
- If the server is reachable from the internet, use a long random password and HTTPS.
- After 10 wrong passwords from one address in 15 minutes, logins from that address are refused until
  the window passes. Behind a proxy on the same machine (like `tailscale serve`) the limit uses each visitor's
  real address from `X-Forwarded-For`; for a proxy on another machine, add its address to `TRUST_PROXY`.
- Changing `WATCH_PASSWORD` signs everyone out, including the Android app.

Upload speed matters: each viewer streams the file directly from your server, so a 10 Mbps 1080p file
watched by three friends needs about 30 Mbps of upload.

## Android and Android TV

CI builds an APK whenever a pull request changes `android/`. To build one on demand, open the repo's
**Actions** tab, pick **Android**, and press **Run workflow**. Download the `watch-party-apk` artifact from the run. Or build it yourself with `cd android && ./gradlew assembleRelease`
(needs JDK 17 and the Android SDK).

- **Phone:** open the APK on the phone and allow installing from that source.
- **Android TV / Google TV:** sideload it, for example with `adb install app-release.apk`, or with the
  Downloader app or Send Files to TV. It shows up on the TV home screen like any other app.

On first launch enter the server address (like `192.168.1.20:8080`, or your Tailscale name), your name,
and the password. Join a party from the list, by typing its code, or by pasting an invite link.

In a party, the D-pad or a tap shows the player controls and the top bar (Chat, Change video, Join voice,
Leave). On a TV remote, the Menu button also opens chat. New messages float over the video for a few
seconds; the full chat opens as a see-through panel along the right edge, with the movie still full size behind it.

**Phone as a chat screen:** if you're in a party on the TV and open the same party on your phone (same
name in both apps), the phone switches to chat only: no video, just the conversation, a keyboard, and the
voice buttons. Tap **Watch here** to play the video on the phone again, or **Chat only** in the phone's top
bar to switch by hand.

**Voice on Android:** press **Join voice** and allow the mic. TVs without a mic join listen-only. Voice
plays through the same speaker as the movie, so headphones help keep it out of everyone else's mic.
Leaving the app (Home button, screen off) leaves voice, because Android doesn't let background apps keep the mic.

The APK is signed with a debug key for easy sideloading. Use your own signing key before publishing it anywhere.

## Video formats

There's no transcoding yet, so files play as-is:

- **Works everywhere:** MP4 with H.264 video and AAC audio, and WebM.
- **Android app only (usually):** MKV, and HEVC/H.265 on devices with a hardware decoder. Browsers mostly
  can't play these, and the library marks them "may not play in browser". AC3/DTS audio depends on the
  device or what it's plugged into.

To convert a file for the browser: `ffmpeg -i in.mkv -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4`.

Subtitles: put `.srt` or `.vtt` files next to the video with the same name (`Movie.mp4` + `Movie.srt`,
or `Movie.en.srt` for a language tag). They're converted to WebVTT on the fly.

## How syncing works

The server keeps one playback state per room: which file, paused or playing, and the position at a
server timestamp. Anyone can play, pause, seek or change the video, and the server broadcasts the new
state. Each client estimates its clock offset from the server with pings, works out where playback
should be right now, and nudges playback speed to fix small drift or seeks to fix big drift. People who
join late land at the right spot.

## Voice chat

Press **Join voice** in a room to talk with everyone else who joined. A ring lights up around whoever is
talking, and the movie gets quieter while someone else talks.

- **Browsers only allow the mic over HTTPS** (or on `localhost`). Over plain `http://` you can still join
  voice and hear everyone, but you can't talk. With Tailscale, `tailscale serve --bg 8080` gives the server
  an HTTPS address like `https://your-pc.tail1234.ts.net`.
- **Use headphones.** Echo cancellation keeps most of the movie out of your mic, but not all of it.
- **Audio goes straight between viewers**, not through your server. Each person connects to every other
  person, which works well for small groups (around 5).
- **If someone's name has a dashed red outline,** your connection to them couldn't be set up. That happens
  on some strict home routers and mobile networks. Being on the same tailnet usually fixes it; otherwise
  run a TURN server (such as [coturn](https://github.com/coturn/coturn)) and list it in `ICE_SERVERS`.

## Development

```sh
npm ci
npm run dev -w server   # API on :8080 (set MEDIA_DIR)
npm run dev -w web      # Vite on :5173, proxies /api and /ws to :8080
npm test                # server tests
npm run typecheck
```

The wire protocol lives in `shared/protocol.ts`.
