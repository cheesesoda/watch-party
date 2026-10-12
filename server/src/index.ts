import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

// Without Docker, read settings from the repo's .env too (variables already set win), so they
// don't need shell-specific syntax like PowerShell's $env:.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();

if (!config.password) {
  if (!config.allowNoPassword) {
    console.error("WATCH_PASSWORD is not set. Set it, or set ALLOW_NO_PASSWORD=1 to run an open server (private networks only).");
    process.exit(1);
  }
  console.warn("Running without a password: anyone who can reach this server can browse and stream your library.");
}

if (config.password && config.password.length < 16) {
  console.warn("WATCH_PASSWORD is short. If the server is on the internet (tailscale funnel), use a long random one, such as four or five random words.");
}

const app = createApp(config);

await app.library.scan();
const count = (await app.library.list()).length;

app.server.listen(config.port, config.host, () => {
  console.log(`Popcorn Club listening on http://${config.host}:${config.port}`);
  console.log(`library: ${count} video(s) in ${config.mediaDirs.join(", ")}`);
  console.log(app.metadata.enabled ? "movie details: on (TMDB)" : "movie details: off (add TMDB_TOKEN to .env to turn them on)");
});

void app.library.list().then((items) => app.metadata.warm(items));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
