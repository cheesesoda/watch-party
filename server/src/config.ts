import path from "node:path";

export interface Config {
  port: number;
  host: string;
  /** Absolute paths of the folders to index. */
  mediaDirs: string[];
  /** Shared password; empty disables auth (fine on a private network only). */
  password: string;
  /** Built web client to serve, if present. */
  webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dirs = (env.MEDIA_DIRS ?? env.MEDIA_DIR ?? "./media")
    .split(/[,;]/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => path.resolve(d));

  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    mediaDirs: dirs,
    password: env.WATCH_PASSWORD ?? "",
    webDir: path.resolve(env.WEB_DIR ?? new URL("../../web/dist", import.meta.url).pathname),
  };
}
