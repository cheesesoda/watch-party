import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();

if (!config.password) {
  if (!config.allowNoPassword) {
    console.error("WATCH_PASSWORD is not set. Set it, or set ALLOW_NO_PASSWORD=1 to run an open server (private networks only).");
    process.exit(1);
  }
  console.warn("Running without a password: anyone who can reach this server can browse and stream your library.");
}

const app = createApp(config);

await app.library.scan();
const count = (await app.library.list()).length;

app.server.listen(config.port, config.host, () => {
  console.log(`watch-party listening on http://${config.host}:${config.port}`);
  console.log(`library: ${count} video(s) in ${config.mediaDirs.join(", ")}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
