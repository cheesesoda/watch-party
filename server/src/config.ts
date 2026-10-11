import path from "node:path";

export interface Config {
  port: number;
  host: string;
  /** Absolute paths of the folders to index. */
  mediaDirs: string[];
  /** Shared password; empty disables auth (only allowed with ALLOW_NO_PASSWORD=1). */
  password: string;
  allowNoPassword: boolean;
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
    allowNoPassword: env.ALLOW_NO_PASSWORD === "1",
    webDir: path.resolve(env.WEB_DIR ?? new URL("../../web/dist", import.meta.url).pathname),
  };
}
