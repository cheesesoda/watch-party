# Watch Party: Setup and User Guide

## What this is

Watch Party lets you stream movies from your own computer to friends, with play, pause and seeking kept in sync for everyone, plus chat and voice. One person hosts; everyone else just joins.

- **Hosting:** read [Host the server](#host-the-server) and [Give it an HTTPS address](#give-it-an-https-address-with-tailscale). You do this once.
- **Friends:** skip to [Join on the web](#join-on-the-web) or [Install the Android app](#install-the-android-app-phone-or-tv), then [Chat, voice and phone chat mode](#chat-voice-and-phone-chat-mode).
- **Something not working:** see [Troubleshooting](#troubleshooting) at the end.

You need three things from the host before joining: the server address, the shared password, and a party code or invite link.

## Host the server

Run the server on the computer that has your movies. Docker is the easiest way; plain Node works too.

### Option A: Docker (recommended)

You need Docker with Compose and git.

1. Get the code:

   ```sh
   git clone https://github.com/cheesesoda/watch-party.git
   cd watch-party
   ```
2. Make your settings file: `cp .env.example .env`
3. Edit `.env` and set two lines:
   - `WATCH_PASSWORD=` a long password you'll share with friends. The server refuses to start without it.
   - `MEDIA_PATH=` the full path to your movie folder, like `/home/you/Movies` or `D:/Movies`.
4. Start it: `docker compose up -d --build`
5. Open http://localhost:8080, sign in with the password, and check that your movies show up.

To update later: `git pull` then `docker compose up -d --build` again. The container restarts on its own after a reboot.

### Option B: Without Docker

You need Node 20 or newer.

```sh
npm ci
npm run build
WATCH_PASSWORD=change-me MEDIA_DIR=/path/to/movies npm start
```

Note the name difference: Docker uses `MEDIA_PATH` in `.env`, plain Node uses `MEDIA_DIR`.

### Your media folder

- Subfolders show up as groups in the library. For several folders without Docker, use `MEDIA_DIRS=/a,/b`.
- New files appear within a minute, or press **Rescan** in the library.
- Subtitles: put a `.srt` or `.vtt` next to the video with the same name (`Movie.mp4` + `Movie.srt`, or `Movie.en.srt`).
- MP4 files with H.264 video and AAC audio play everywhere. See [Troubleshooting](#troubleshooting) for other formats.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `WATCH_PASSWORD` | required | Shared password for everyone. Changing it signs everyone out. |
| `MEDIA_PATH` / `MEDIA_DIR` | `./media` | Movie folder (Docker / plain Node). |
| `PORT` | `8080` | Port the server listens on. |
| `TRUST_PROXY` | `loopback` | Which proxies to believe about a visitor's real address. Leave it alone with `tailscale serve`; only change it for a proxy on another machine. |
| `ICE_SERVERS` | Google public STUN | STUN/TURN servers for voice, as JSON. Only needed if voice won't connect for someone. |
| `ALLOW_NO_PASSWORD` | off | Set to `1` to skip the password. Only on a network you fully trust. |

**Upload speed matters.** Each friend streams straight from your computer, so a 10 Mbps movie watched by three friends needs about 30 Mbps of upload.

## Give it an HTTPS address with Tailscale

Use Tailscale so friends can reach the server without opening ports, and so browsers get the HTTPS address they require before allowing the mic.

1. Install [Tailscale](https://tailscale.com/download) on the server computer and sign in.
2. Run:

   ```sh
   tailscale serve --bg 8080
   ```

   It prints an address like `https://your-pc.tail1234.ts.net`. If it asks you to turn on HTTPS certificates for your tailnet, follow the link it gives and run the command again.
3. Open that address yourself and sign in to check it works.
4. Let friends in. Pick one:
   - **Share the machine (more private):** in the Tailscale admin console, share the server machine with each friend. They install Tailscale, accept the share, and then the `https://…ts.net` address works for them.
   - **Funnel (no Tailscale for friends):** run `tailscale funnel --bg 8080` instead of `serve`. The same address becomes reachable from the whole internet, so only the password protects it. Use a long random one.
5. Send friends the `https://…ts.net` address and the password, or an invite link from a party's **Invite** button.

`--bg` keeps it running after you close the terminal and across reboots. To turn it off: `tailscale serve --https=443 off` (or `tailscale funnel --https=443 off`).

The Android app doesn't need HTTPS for voice, so friends on the same Wi-Fi can also use your local address like `192.168.1.20:8080`. Web browsers do need HTTPS to send voice.

The exact admin console wording may have changed since this was written; [Tailscale's serve docs](https://tailscale.com/kb/1312/serve) are the reference.

## Join on the web

Any modern browser on a computer or phone works; nothing to install.

1. Open the address or invite link the host sent you. Use the `https://` one if you want to talk in voice chat.
2. Enter the shared password, then pick a name. Use the same name everywhere if you also use the TV app.
3. Join a party from the list (each shows who's in it and its code), or open the invite link straight into one.
4. To start your own, pick a movie in the library and press **Start party**. Press **Invite** in the party to copy a link for others.

Anyone in a party can play, pause, seek or change the movie, and it changes for everyone. If you join late, you land at the right spot.

Movies marked "may not play in browser" usually need the Android app. See [Troubleshooting](#troubleshooting).

## Install the Android app (phone or TV)

One app works on Android phones and Android TV / Google TV. It isn't in the Play Store, so you install the APK file directly (sideloading).

### Getting the APK (host)

On GitHub, open the repo's **Actions** tab, pick **Android**, press **Run workflow**, and when it finishes download the `watch-party-apk` artifact. It downloads as a zip; the `.apk` is inside. Send that file to friends, or put it somewhere they can download it.

### On a phone

1. Open the `.apk` file on the phone (from Downloads, a chat app, or email).
2. When Android asks, allow installing apps from that source, then tap **Install**.

### On Android TV / Google TV

Pick whichever is easiest:

- **Send Files to TV:** install it on your phone and the TV, send the APK across, then open it on the TV.
- **Downloader app:** if the APK is at a web link, install Downloader on the TV and enter the link.
- **adb (for the technical):** turn on developer mode and network debugging on the TV, then `adb connect <tv-ip>` and `adb install app-release.apk`.

The TV will ask you to allow unknown apps for whichever app opened the APK; the setting usually sits under Settings, then Privacy or Security, but it varies by brand. Once installed, Watch Party shows up on the TV home screen.

### First launch

1. Enter the server address. Either the Tailscale one (`https://your-pc.tail1234.ts.net`, which needs Tailscale on that device too) or a local one on the same Wi-Fi (`192.168.1.20:8080`).
2. Enter your name and the password.
3. Join a party from the list, type its code, or paste an invite link.

On a TV, the D-pad shows the player controls and the top bar (**Chat**, **Change video**, **Join voice**, **Leave**); the remote's Menu button also opens chat. On a phone, tap the video.

## Chat, voice and phone chat mode

### Chat

New messages float over the video for a few seconds. On the TV, **Chat** (or the remote's Menu button) opens the full chat as a see-through panel on the right, with the movie still full size behind it.

### Voice

1. Press **Join voice** in a party and allow the microphone.
2. A ring lights up around whoever is talking, and the movie gets quieter while someone else talks.
3. Press it again to leave voice. You can stay in the party without voice.

Good to know:

- **Wear headphones.** Echo cancellation removes most of the movie from your mic, but not all of it.
- **In a browser you need the `https://` address to talk.** Over `http://` you can still join and hear everyone, just not speak.
- **TVs without a mic join listen-only.** Pair the TV with phone chat mode (below) to talk from your phone.
- **On Android, leaving the app leaves voice.** Pressing Home or turning the screen off drops you, because Android doesn't let background apps keep the mic.
- Voice goes directly between viewers, not through the server, so it works best for around 5 people.

### Phone chat mode (TV plus phone)

Watch on the TV and chat from your phone's keyboard.

1. Join the party on the TV.
2. On your phone, open the app with **exactly the same name** as on the TV and join the same party.
3. The phone switches to chat only: no video, just the conversation, a keyboard and the voice buttons. Join voice from the phone to talk while the TV plays the movie.

Tap **Watch here** to play the video on the phone again, or **Chat only** in the phone's top bar to switch back by hand.

The see-through TV panel and phone chat mode need an APK built after October 11, 2026. If your phone doesn't switch, ask the host for a fresh APK.

## Troubleshooting

| Problem | Why | Fix |
| --- | --- | --- |
| Movie won't play, or plays with no sound, in a browser | No transcoding yet: files play as-is. Browsers handle MP4 (H.264 + AAC) and WebM, but usually not MKV, HEVC/H.265, AC3 or DTS. | Watch it in the Android app, which plays most MKV and HEVC files. Or the host converts it once: `ffmpeg -i in.mkv -c:v libx264 -crf 20 -c:a aac -movflags +faststart out.mp4` |
| No sound in the Android app | AC3/DTS audio depends on the device or the soundbar it's plugged into. | Try another device, or convert the audio to AAC with the command above. |
| Can hear voice but can't talk (browser) | Browsers only allow the mic over HTTPS. | Use the `https://…ts.net` address from the host, not `http://`. |
| Others hear the movie or themselves echo | Your mic picks up your speakers. | Wear headphones. On a TV, talk through phone chat mode with headphones on the phone. |
| Dashed red outline around someone's name | Your voice connection to them couldn't be set up, usually a strict router or mobile network. | Both join through Tailscale. Otherwise the host runs a TURN server and lists it in `ICE_SERVERS`. |
| Phone doesn't switch to chat only | Names differ, or an older app. | Use the identical name on phone and TV; get the latest APK. |
| Voice drops when I switch apps on Android | Android stops background apps using the mic. | Keep the app open while you talk. |
| Can't sign in, even with the right password | After 10 wrong passwords in 15 minutes from one address, that address is blocked until the 15 minutes pass. It only affects that person, including behind `tailscale serve`. | Wait 15 minutes, then type carefully. |
| Everyone signed out at once | The host changed `WATCH_PASSWORD`. | Sign in with the new password. |
| Video stutters for everyone | The host's upload speed is shared by every viewer. | Fewer viewers, or a smaller file. |
| New movie doesn't show up | The library rescans about once a minute. | Press **Rescan** in the library. |
