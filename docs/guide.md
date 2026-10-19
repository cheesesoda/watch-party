# Popcorn Club: Setup and User Guide

## What this is

Popcorn Club lets you stream movies from your own computer to friends, with play, pause and seeking kept in sync for everyone, plus chat and voice. One person hosts; everyone else just joins.

- **Hosting:** read [Host the server](#host-the-server) and [Give it an HTTPS address](#give-it-an-https-address-with-tailscale). You do this once. On Windows, start at [Windows (PowerShell)](#windows-powershell) and skip Options A and B.
- **Friends:** skip to [Join on the web](#join-on-the-web) or [Install the Android app](#install-the-android-app-phone-or-tv), then [Chat, voice and phone chat mode](#chat-voice-and-phone-chat-mode).
- **Something not working:** see [Troubleshooting](#troubleshooting) at the end.

Friends only need an invite link from the host, or the server address plus a party code. The server password is just for the host, who uses it to start parties.

## Host the server

Run the server on the computer that has your movies. On Linux or macOS, Docker is the easiest way. On Windows, use plain Node in PowerShell.

### Option A: Docker (recommended on Linux and macOS)

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

You need Node 20 or newer. On Windows, follow [Windows (PowerShell)](#windows-powershell) instead.

```sh
npm ci
npm run build
cp .env.example .env   # set WATCH_PASSWORD and MEDIA_PATH, as above
npm start
```

The server reads `.env` itself. Variables set in your shell override it, and `MEDIA_DIR` works as another name for `MEDIA_PATH`.

### Windows (PowerShell)

Run the server straight on Windows with Node. You don't need Docker or WSL: Docker Desktop on Windows runs inside WSL2 anyway, and reading movies from Windows drives through WSL is slow.

1. Install Node, Git, Tailscale and FFmpeg (skip any you already have). FFmpeg is optional: it lets the server convert movies browsers can't play.

   ```powershell
   winget install -e --id OpenJS.NodeJS.LTS
   winget install -e --id Git.Git
   winget install -e --id Tailscale.Tailscale
   winget install -e --id Gyan.FFmpeg
   ```
2. Close PowerShell and open a new window so it finds the new programs, then check them:

   ```powershell
   node --version     # v20 or newer
   npm --version
   git --version
   tailscale version
   ffmpeg -version
   ```

   If `npm` says running scripts is disabled, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again.
3. Get the code and build it:

   ```powershell
   git clone https://github.com/cheesesoda/watch-party.git
   cd watch-party
   npm ci
   npm run build
   ```
4. Make your settings file and open it:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

   Set `WATCH_PASSWORD=` to a long password and `MEDIA_PATH=` to your movie folder, like `MEDIA_PATH=D:/Movies`. Forward slashes are easiest; for several folders use `MEDIA_DIRS=D:/Movies;E:/Shows`.
5. Start it: `npm start`. It prints how many videos it found. Leave that window open; closing it stops the server. After a reboot, run `npm start` again.
6. Open http://localhost:8080 and sign in. Then set up Tailscale as below.

If Windows Firewall asks about Node, allow **Private networks** if friends on your Wi-Fi will use your local address. With `tailscale serve` alone it isn't needed.

To update later: `git pull`, `npm ci`, `npm run build`, then `npm start` again.

### Windows tray app

Instead of a PowerShell window, the server can run from an icon by the clock, like Plex. It starts the server hidden, opens the app and installs updates when you choose. Nothing checks for updates by itself.

1. Install the .NET 8 SDK once: `winget install Microsoft.DotNet.SDK.8`. Open a new PowerShell window after it finishes.
2. Close the PowerShell window that runs `npm start`, if one is open.
3. In the watch-party folder, run `windows\install.cmd`. It builds the tray app into `%LOCALAPPDATA%\Popcorn Club\app` and starts it. If it can't find your watch-party folder, it asks for it.

Click the icon to open Popcorn Club in your browser. Right-click it for the menu:

- **Start server**, **Stop server**, **Restart server**, and **Show log** for the server's output. Its first line names the update the server is running ("Popcorn Club server: #121 (abc1234, 2026-10-15)": the last merged change, its commit and date), so you can tell whether **Update now** took. The icon is gray while the server is stopped.
- **Update now** stops the server, gets the latest code (`git pull`), runs `npm ci` and `npm run build`, rebuilds the tray app if it changed, and starts everything again. A notification lists what's new, and the log has the full list.
- **Settings**: **Start with Windows**, **Edit server settings (.env)**, **Open server folder** and **Choose server folder**.
- **Quit** stops the server too.

The log is also saved to `%APPDATA%\Popcorn Club\server.log`.

### Your media folder

- Subfolders show up as groups in the library. For several folders without Docker, use `MEDIA_DIRS=/a,/b` (on Windows, `D:/Movies;E:/Shows`).
- New files appear within a minute, or press **Rescan** in the library. Their details and skip times are looked up by themselves when they appear.
- Subtitles: put a `.srt` or `.vtt` next to the video with the same name (`Movie.mp4` + `Movie.srt`, or `Movie.en.srt`). Text subtitles inside the file (common in `.mkv`) show up too; picture-based ones (Blu-ray PGS, DVD) only on Android when it plays the original file. Subtitles always start off: turn them on with the subtitles button on Android, or in **Settings** in the browser. Each device picks its own.
- MP4 files with H.264 video and AAC audio play everywhere. See [Troubleshooting](#troubleshooting) for other formats.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `WATCH_PASSWORD` | required | The host's password for starting parties. Friends join with a party code instead. Changing it signs the host out everywhere. |
| `MEDIA_PATH` | `./media` | Movie folder. `MEDIA_DIR` also works without Docker; `MEDIA_DIRS` takes several. |
| `PORT` | `8080` | Port the server listens on. |
| `ICE_SERVERS` | Google public STUN | STUN/TURN servers for voice, as JSON. Only needed if voice won't connect for someone. |
| `TRUST_PROXY` | `loopback` | Which proxies to believe about a visitor's real address. Leave it alone with `tailscale serve`; only change it for a proxy on another machine. |
| `TRANSCODE_ENCODER` | `auto` | How the server converts movies browsers can't play. `auto` uses an NVIDIA GPU (NVENC) if there is one, otherwise the CPU (`libx264`). `off` turns converting off. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Where FFmpeg is, if it isn't on your PATH. |
| `TRANSCODE_DIR` | system temp folder | Where converted pieces go while a movie plays. They're deleted a few minutes after everyone stops watching. |
| `ANDROID_CERT_SHA256` | empty | The app's signing fingerprint, so phones open the TV's QR link in the app instead of the browser. Copy the SHA-256 from Play Console, under Test and release, App integrity, App signing key certificate. Several are allowed, separated by commas. |
| `INVITE_URL` | empty | Your own address for invite links, such as `https://tv.chzsda.com`. That address must forward `/join/CODE` to this server (the Railway proxy below does). Empty: invite links use the ts.net address. |
| `OUTSIDE_URL` | empty | Where the tray app checks, every 2 minutes, that friends can still reach the server from the internet. Empty: `app.` in front of the `INVITE_URL` host (so `https://app.tv.chzsda.com`); with no `INVITE_URL` either, there is no check. |
| `MEDIA_URL` | empty | This server's own public address (the `https://…ts.net` one) when the pages come through the Railway proxy, so video, subtitles and posters still load straight from your PC. |
| `PROXY_KEY` | empty | A long random string shared with the Railway proxy. It lets the proxy say which friend each request is from, so a wrong password only locks out that friend. Must match the proxy's `PROXY_KEY`. |
| `TMDB_TOKEN` | empty | Turns on movie and episode details (episode names, posters, background art, ratings, summaries) from TMDB. Make a free account at themoviedb.org, then under Settings, API, copy the **API Read Access Token** (the long one, not the API Key). The server keeps what it finds in `data/metadata.json`, so each movie and season is looked up once. |
| `TMDB_LANGUAGE` | `en-US` | Language for TMDB titles and summaries. |
| `ALLOW_NO_PASSWORD` | off | Set to `1` to skip the password. Only on a network you fully trust. |

**Upload speed matters.** Each friend streams straight from your computer, so a 10 Mbps movie watched by three friends needs about 30 Mbps of upload.

## Give it an HTTPS address with Tailscale

Use Tailscale so friends can reach the server without opening ports, and so browsers get the HTTPS address they require before allowing the mic.

1. Install [Tailscale](https://tailscale.com/download) on the server computer and sign in.
2. In the admin console's [DNS page](https://login.tailscale.com/admin/dns), check that **MagicDNS** is on and press **Enable HTTPS** under HTTPS Certificates. You only do this once.
3. With the server running, run this in another terminal (8080 is the server's default `PORT`):

   ```sh
   tailscale serve --bg 8080
   ```

   It prints an address like `https://your-pc.tail1234.ts.net`. If it asks you to turn on HTTPS certificates, follow the link it gives and run the command again. On Windows, if it says access denied, run PowerShell as Administrator.
4. Open that address yourself and sign in to check it works. The first load can take a few seconds while the certificate is issued.
5. Let friends in. Pick one:
   - **Share the machine (more private):** in the Tailscale admin console, share the server machine with each friend. They install Tailscale, accept the share, and then the `https://…ts.net` address works for them.
   - **Funnel (no Tailscale for friends):** run `tailscale funnel --bg 8080` instead of `serve`. The same address becomes reachable from the whole internet, so only the password protects it. Use a long random one: wrong guesses are blocked after 10 tries per visitor, which slows guessing but doesn't stop it.
6. Start a party and send friends its invite link (it holds the address and the party code). They don't need the password.

`--bg` keeps the HTTPS address set up after you close the terminal and across reboots, but the server itself still needs starting after a reboot. On Windows, turn on **Run unattended** in the Tailscale tray menu's preferences so it stays connected while you're signed out.

To turn the HTTPS address off: `tailscale serve --https=443 off` (or `tailscale funnel --https=443 off`).

The Android app doesn't need HTTPS for voice, so friends on the same Wi-Fi can also use your local address like `192.168.1.20:8080`. Web browsers do need HTTPS to send voice.

The exact admin console wording may have changed since this was written; [Tailscale's serve docs](https://tailscale.com/kb/1312/serve) are the reference.

## Your own address (app.tv.chzsda.com)

Optional. Friends open the dashboard at `https://app.tv.chzsda.com`, and invite links look like `https://tv.chzsda.com/join/ABC123`. A small proxy on Railway (the `proxy/` folder) passes pages, sign-in, chat and sync to your PC over the ts.net address. Video, subtitles and posters still load straight from your PC, so Railway never carries the heavy traffic. When your PC is off, those addresses show a short "the party server is off" page.

1. **Railway:** the `popcorn-proxy` service runs `proxy/` with these variables: `UPSTREAM` (your `https://…ts.net` address), `APP_HOST=app.tv.chzsda.com`, `INVITE_HOST=tv.chzsda.com` and `PROXY_KEY` (a long random string).
2. **DNS** (DreamHost, for chzsda.com): add the records Railway shows for each address: a CNAME for `app.tv` and `tv`, and a TXT for `_railway-verify.app.tv` and `_railway-verify.tv`. If `tv.chzsda.com` is set up as a hosted site, remove that first, since a CNAME can't sit next to the site's own records. Email and the rest of the domain are untouched.
3. **`.env` on your PC**, then restart (or **Update now**):
   ```
   INVITE_URL=https://tv.chzsda.com
   MEDIA_URL=https://your-pc.tail1234.ts.net
   PROXY_KEY=the same string as on Railway
   ```

The Android app keeps talking to the ts.net address directly. Version 0.2.34 and later open tv.chzsda.com invites in the app.

## Join on the web

Any modern browser on a computer or phone works; nothing to install. The app opens on two choices: **Join a party** and **Start a party**.

**Joining (friends):**

1. Open the invite link the host sent you. Use the `https://` one if you want to talk in voice chat.
2. The party code is already filled in. Pick a name and press **Join**. Use the same name everywhere if you also use the TV app.
3. Without a link, open the server address, press **Join a party**, and type the code.

A party code only gets you into that one party. It stops working when the host ends the party, or 30 minutes after everyone has left. Viewers can't browse the library or start parties.

**Starting (host):**

1. Press **Start a party**, enter your name and the server password. You stay signed in on that browser.
2. Find something to watch. The sidebar has **Home** (new titles, running parties, and rows of Movies and TV Shows), **Movies**, **TV Shows**, **Watch Parties** and **Has subtitles**, and the search box at the top looks through everything. Click a poster to open its page. A movie's page has **Start party**; a show's page has **Binge season N**, **Binge all seasons**, and a **Start party** button on each episode. You can also hover a movie poster and press its play button. Wrong poster or summary? Use **Fix match** in the ⋮ menu on the page. Specials are season 0: name them like `Letterkenny S00E13 St. Perfect's Day.mkv`, in the show's folder or a `Specials` folder in it. The special's name after the number is matched to TMDB's, so any numbering works; without a name, the number has to be TMDB's. An episode TMDB counts as a special but you number into a season (like `Schitts Creek S04E13 Merry Christmas, Johnny Rose`) keeps your number and gets TMDB's details by its name. They get their own **Specials** tab, and each one also shows in the season it aired in, marked **Special**, so **Binge season N** and **Binge all seasons** play it where it first aired (by TMDB's air dates; one without a date plays at the end of Binge all). Each tab binges what it shows: **Binge specials** on the Specials tab, **Binge extras** on the Extras tab.
3. You get a party code, a **Copy invite link** button and a **Join party** button. Nothing plays yet, and you stay on the dashboard. To join someone else's party, type its code in **Party code** at the top right.
4. Send the link, then press **Join party** when you're ready to watch. **Change video** (the list icon in the party's top bar) picks something else. The **Invite** button in the party also shows the code.

**Skip intro.** While an episode's intro (or a recap) plays, **Skip intro** (or **Skip recap**) shows in the bottom-right corner; on a TV the remote is already on it, so one press of OK skips. Anyone can press it: it jumps everyone past it, and the others see "Jake skipped the intro". The server finds intros and credits by itself, the way Plex does: episodes of a season share their theme music, so it compares the sound of the first quarter of each episode (up to ten minutes) and the last fifth (up to eight minutes) with its neighbors' using FFmpeg's chromaprint (most FFmpeg builds have it; `ffmpeg -hide_banner -muxers` lists it). It looks at every season it hasn't seen yet in the background after the server starts, after **Rescan**, and whenever the library picks up new or replaced videos (within a minute of opening it), one file at a time, and keeps what it found in `data/markers.json`; the server log says which season it is on and which episode it is checking for a recap, and notes each season when it is done ("Severance season 1: intros in 9 of 9, recaps in 8, credits in 9"). When only some episodes of a season have credits, the line names the ones without, like "(none found in E03, E07)", and each start of the server lists them again for seasons already looked at, so you can watch the end of one and see what differs. A show needs at least two episodes in a season, and a new episode is ready once it has been looked at. Recaps are found by sound too: a recap is clips from earlier episodes, so the server checks the start of each episode against the whole episode before it and the openings and endings of the ones before that. The recap runs from the first reused clip to the last, however long that is; sound every episode opens with (a studio logo, the theme) doesn't count. Sound only two episodes share isn't taken for an intro either, since a theme plays in most of them (that's how a recap reusing the last episode's opening scene was being called an intro). Chapter names in the file ("Recap", "Previously on…", "Intro", "Opening", "Credits") win over what the sound says, except that a recap runs on as long as the reused clips do; chapters are the only way a movie's credits are found. Back-to-back chapters join up ("Title Sequence" then "Opening Credits" is one intro), and an intro or recap too short to press gets no button. An episode where no credits turned up is searched once more for the outro of the season's episodes that have them; that finds an outro cut short, or one encoded differently. Only a match on the start of the outro counts: when just the logos at its very end match (credits played over a song, as in some Archer episodes), the server walks back from the logos through the dark credit cards to where they begin. When an episode's credits play a different song every time, so the sound doesn't match, the server looks at the picture instead: the credits start where the screen turns to white text on black and stays that way to the end, or to a studio logo in the last half minute (Reacher's Skydance logo). It looks at keyframes first, then at two frames a second around where the credits seem to start, for the exact second. A party that ends in the credits of its last video doesn't save its spot.

**Up next** is the list of what plays after the current video. In the browser, open **Change video** (the list icon): the **Up next** tab shows what's playing now and what comes after it. Drag the dots to reorder, press **×** to take one out, **Play now** to jump to it, or **Clear Up next** to empty it. To add videos, use **Add to Up next**: it's on a movie poster when you hover it (beside the play button), beside each episode's **Play for everyone**, on movie pages and in the Details window, and **Add season N to Up next** sits next to **Binge season N**. A short note at the bottom lets you **Undo**. **Binge** replaces Up next and starts right away, and playing something else keeps Up next for after it. When the credits start (or the video ends, if the server hasn't found its credits), a small **Up next** card shows in the bottom-right corner with the next video and a 10-second countdown, then it starts. The card has **Play now** (it fills up as the countdown runs) and **Stay here**, which keeps watching the credits; anyone in the party can press them. With nothing lined up after it, no card shows and the credits play. Only the host changes Up next; guests can see it with the list icon in their top bar, and party cards on the dashboard show what's next.

Everyone can play, pause and seek, and it changes for everyone. If you join late, you land at the right spot. Only the host can change the movie or end the party. To end a party without joining it, press **End** on its card under **Watch Parties** (web or app). Clicking a party's code copies its invite link.

To end a party for everyone, press **End party** (the coral power icon in the top bar; in the Android app it's under **Leave**). Everyone is sent out and the code stops working. On the web, leaving a party (or pressing Back after it ends) returns to the page it was started or joined from, such as the show's page. Otherwise a party ends on its own 30 minutes after the last person leaves, or when the server restarts.

**Pick up where you left off.** If the party is partway through something (past the first minute and not at the credits, or with more in Up next), End party asks **Save your spot?**: **Save spot** keeps the video, how far in you were and the rest of Up next; **Don't save** just ends it; **Cancel** keeps the party going. A party that closes by itself after 30 minutes empty saves its spot without asking, and so does one that ends because the server stopped or restarted (the server notes where each party is every 15 seconds). Saved spots show on Home under **Pick up where you left off** (newest first, up to 6, kept for 30 days). A video without TMDB art shows a still from the video at the spot (the server grabs it with ffmpeg); if the file can't be read, its title. On the web, hover a card for **Start party** or **×** to forget it, and click it to open the show or movie. On a TV, press OK on a card for **Start party here**, **Go to show** or **Remove**; on a phone, tap **Start** or **×**, or the card for the show. Starting from a spot opens a new party at that point with the rest lined up in Up next, and the spot is used up. A show with a saved spot also shows it on its page, with **Continue binge** as the first button. If you end a party at the credits with more lined up, the spot is the start of the next video. Spots are kept in `data/spots.json`.

**Watch alone.** The host can also watch on their own. Flip the **Together / Alone** switch (in the web dashboard's top bar, **Watch alone** with its switch, last in the TV's side menu, or **Watch alone** in the phone's ⋮ menu). The choice is remembered on that device. On Alone, **Start party** reads **Play**, and playing goes straight to the player: no party code, it doesn't show under Watch parties, and nobody can join it. The video starts by itself as soon as it loads. The player says **Watching alone** and has no Chat, voice or End party. **Leave** saves your spot under Pick up where you left off without asking. Leaving the player any other way (Home on the remote, switching apps, closing the browser tab) pauses it where you were. To bring friends in partway, press **Invite** (the person-plus icon): it asks first, then turns it into a regular party with a code (the web copies the invite link; the app shows the code and a QR code). On a phone, a small orange **Watching alone** line sits under the name on Home, and show and movie pages say **Watching alone** at the top; tap it there to switch back.

Movies browsers can't play as-is (HEVC/H.265, AC3 or DTS audio, and some MKVs) are converted by the server while you watch, like Plex does, if the host has FFmpeg installed. This happens on its own: the browser checks the file and asks for the converted copy when it needs it. A **Convert** switch in Settings (the gear icon) shows when it's on and lets you switch by hand if the picture or sound is missing. Converted video is 1080p H.264 with stereo sound. Each viewer's browser decides for itself, and the Android app still plays the original file. Files with more than one audio language play the English track (the main one, not a commentary) when there is one, otherwise the file's default. Browsers can only play a file's first audio track, so when English isn't first the browser uses the converted copy; the Android app switches tracks itself, and its Settings can pick another.

## Install the Android app (phone or TV)

One app works on Android phones, Android TV / Google TV and Amazon Fire TV.

### Phones and Android TV / Google TV

The app is on Google Play as an internal test, so the host adds each friend's Google account as a tester in Play Console (Test and release, Internal testing, Testers) and sends them the opt-in link. After they accept, Popcorn Club installs and updates from the Play Store like any app.

### Fire TV

Popcorn Club is on the Amazon Appstore: on the Fire TV, search for **Popcorn Club** and install it. It updates by itself like any app. This works on Fire TV models that run Fire OS (for example the Fire TV Stick 4K Plus, 4K Max and Cube). It doesn't work on the newer Vega OS models (the Fire TV Stick 4K Select, and the 2026 Fire TV Stick 4K and Fire TV Stick HD), because they can't run Android apps. To check, look at Settings, My Fire TV, About.

Each Appstore update waits for Amazon's review, so the Appstore version can be a few days behind. To get the newest build right away, install the APK file from GitHub instead:

1. On the Fire TV home screen, search for **Downloader** (the orange app by AFTVnews) and install it.
2. Turn on developer options: go to Settings, My Fire TV, About, and press the select button on your Fire TV's name seven times until it says you're a developer.
3. Go back to My Fire TV, then Developer options, then **Install unknown apps**, and turn it on for **Downloader**.
4. Open Downloader and enter `tv.chzsda.com/apk` (the host's own address, if they set one up), or the full link:
   `https://github.com/cheesesoda/watch-party/releases/latest/download/popcorn-club.apk`
5. Press **Install**. When it's done, Downloader offers to delete the file; say yes. Popcorn Club is now under Your Apps & Channels.

To update, repeat step 4; your sign-in and settings stay. The phone side works the same as with any TV: scan the Fire TV's QR code with your phone to sign it in or to chat from your phone. Menu names can differ a little between Fire OS versions.

The Appstore copy and the APK are signed differently and can't update each other, so uninstall one before installing the other. The APK is only for Fire TV; on a phone or Google TV, use the Play Store version.

### First launch

The app opens on **Join a party** and **Start a party**.

- **Join a party (friends):** tap the invite link the host sent and it opens in the app with the code filled in; enter your name and press **Join**. Or type the party code yourself. The app already knows the host's server; press **Other server** only if the host gave you a different address.
- **Start a party (host):** enter your name and the password. The app's home looks like the web dashboard: on a TV, a menu on the left (Search, Home, Movies, TV Shows, Watch Parties, Join with code, then Refresh library, Settings and the Watch alone switch) opens on the page you're on (TV Shows while you browse shows) when you move into it; Right or Back leaves it for the card you were on; on a phone, the bar at the bottom has Home, Movies, TV Shows and Parties, with search and the ⋮ menu (Watch alone, Join with code, Scan TV code, Refresh library, Settings) at the top. On a TV, Back closes the side menu. **TV Shows** sorts **A–Z** or **Recently added** (and the app also has **Has subtitles**). **Settings** shows your name (press it to change it), the server you're on, and **Sign out**, which asks first. Back on a sign-in screen returns to the first screen. Open a movie or show and press **Start party** (or **Binge season N**) to get its code and a **Join party** button.
- **Sign in with your phone (TV only):** the TV shows a QR code. Scan it with your phone's camera, enter the party code and a name for the TV, and the TV joins by itself. The host can tap **I'm the host** instead to sign the TV in as host; if the phone isn't signed in yet, the password you type signs in the phone too. On a phone with the app installed the link opens in the app, otherwise in the browser; both work.
- **Watch on the TV, chat on the phone:** join the party on your phone, then pick **Sign in with your phone** on the TV and scan its QR code. The phone fills in the party code and your name, so press **Join on the TV**. When a TV joins under the same name as your phone, the phone switches to chat only.

The app comes with the host's server built in. **Other server** takes the host's `https://` address, or a local one on the same Wi-Fi like `192.168.1.20:8080`.

On a TV, any D-pad press shows the player controls: the title at the top left, the seek bar (each left or right press moves 10 seconds), and one row of round buttons under it (play/pause and, in a binge, previous and next on the left; **Chat**, **Join voice**, subtitles, **Change video** for the host, **Settings** and **Leave** on the right). The remote's Menu button also opens chat. On a phone, tap the video: what's on is at the top left, the buttons (**Chat**, **Join voice**, subtitles, **Change video** for the host, **Settings** and **Leave**) are icons at the top right (a long press shows their names), play/pause is in the middle with previous and next beside it in a binge, and the seek bar is along the bottom. When anyone pauses or plays, the TV and phone show **Paused at 13:33** or **Playing** at the top for a moment, so you know the press reached the party. The remote's play/pause button follows the party: while the TV is still loading a spot the party is playing, so a press pauses it. Double-tap the left or right side of the video to jump 10 seconds back or ahead for everyone; keep tapping to jump further. After anyone jumps, everyone pauses for a moment until every screen has loaded the new spot (at most about 4 seconds), then all play together. If no screen has loaded it by then (watching alone, say), it waits for the first one that does, up to 30 seconds. The server log notes who paused, pressed play or jumped, and from which screen ("Jake (tv) paused at 13:33"), and for each jump how long each screen took and whether it plays the converted copy, and for a screen that took longer than the wait, when it caught up. For the host, **Leave** asks whether to just leave or to end the party for everyone.

## Chat, voice and phone chat mode

### Chat

New messages float over the video for a few seconds. On the TV, **Chat** (or the remote's Menu button) opens the full chat as a see-through panel on the right, with the movie still full size behind it. To stop messages popping up over the movie, open **Settings** in the player (web, phone and TV) and turn off **Chat pop-ups**. Each device remembers its own setting, so you can have pop-ups on the TV and not on your phone, or the other way round. The full chat still opens as usual.

### Voice

1. Press **Join voice** in a party (the headphones icon in the top bar on the web) and allow the microphone.
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

Tap **Watch here** to play the video on the phone again, or **Chat only** in the phone player's **Settings** to switch back by hand.

The see-through TV panel and phone chat mode need an APK built after October 11, 2026. If your phone doesn't switch, ask the host for a fresh APK.

## Troubleshooting

| Problem | Why | Fix |
| --- | --- | --- |
| Movie won't play in a browser, or has sound but no picture, or picture but no sound | The browser can't decode the file's video (often HEVC) or audio (AC3/DTS), and the server isn't converting it. | Press **Convert** in the top bar. If there's no Convert button, the host installs FFmpeg and restarts the server; its console says "transcode: converting with …" when it's ready. Or watch in the Android app. |
| Converted movie stutters or keeps buffering | The server converts slower than real time, usually because it's using the CPU. | The server console says which encoder it picked. With an NVIDIA card it should say `h264_nvenc`. If it says `libx264`, the line above it (`h264_nvenc isn't usable: …`) says why; usually the NVIDIA driver is older than that FFmpeg build needs, and updating it fixes it. |
| No sound in the Android app | AC3/DTS audio depends on the device or the soundbar it's plugged into. | Try another device, or convert the audio to AAC as below. |
| A file always needs converting for its sound (AC3 / DTS, often 5.1 MKVs) | Most browsers and many phones can't decode AC3 or DTS. | Convert just the audio once, which takes seconds and leaves the picture untouched: `ffmpeg -i in.mkv -map 0 -c copy -c:a aac -b:a 384k out.mkv`. Save it as `.mp4` instead (and add `-movflags +faststart`) if it should also play in browsers without converting. |
| Can hear voice but can't talk (browser) | Browsers only allow the mic over HTTPS. | Use the `https://…ts.net` address from the host, not `http://`. |
| Others hear the movie or themselves echo | Your mic picks up your speakers. | Wear headphones. On a TV, talk through phone chat mode with headphones on the phone. |
| Dashed red outline around someone's name | Your voice connection to them couldn't be set up, usually a strict router or mobile network. | Both join through Tailscale. Otherwise the host runs a TURN server and lists it in `ICE_SERVERS`. |
| Phone doesn't switch to chat only | Names differ, or an older app. | Use the identical name on phone and TV; get the latest APK. |
| Voice drops when I switch apps on Android | Android stops background apps using the mic. | Keep the app open while you talk. |
| "No party with that code" | The party ended, or it sat empty for 30 minutes, or the code has a typo. | Ask the host for a new code. After 10 wrong codes in 15 minutes, that address has to wait out the 15 minutes. |
| Can't sign in, even with the right password | After 10 wrong passwords in 15 minutes from one address, that address is blocked until the 15 minutes pass. It only affects that person, including behind `tailscale serve`. | Wait 15 minutes, then type carefully. |
| Host signed out on every device | The host changed `WATCH_PASSWORD`. | Sign in with the new password. Viewers aren't affected. |
| Video stutters for everyone | The host's upload speed is shared by every viewer. | Fewer viewers, or a smaller file. |
| New movie doesn't show up | The library rescans about once a minute. | Press **Rescan** in the library. |
