import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp(config);

if (!config.password) {
  console.warn("WATCH_PASSWORD is not set: anyone who can reach this server can watch. Set it before exposing the server.");
}

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
