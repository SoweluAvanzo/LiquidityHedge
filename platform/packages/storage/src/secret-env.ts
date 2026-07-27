/**
 * Read a credential from a mounted secret file, falling back to the
 * environment.
 *
 * Environment variables are the wrong place for a password: they appear in
 * `docker inspect`, in `/proc/<pid>/environ`, in crash dumps, and they are
 * inherited by every child process. Docker mounts secrets as files under
 * `/run/secrets/<name>` instead, readable only by the container user.
 *
 * The convention here is the same one the official Postgres, MySQL and
 * Redis images use: for any variable `X`, if `X_FILE` is set, the value is
 * the trimmed contents of that file. That keeps a plain `X` working for
 * local development while production injects a file and never puts the
 * secret in the process environment at all.
 *
 * `DATABASE_URL` embeds a password, so it also supports being assembled
 * from parts (`PGHOST`, `PGUSER`, `PGPASSWORD_FILE`, …) — otherwise the
 * secret would have to be interpolated into a URL by the shell, which puts
 * it right back into the environment.
 */

import { readFileSync } from "fs";

/**
 * Resolve `name` from `${name}_FILE` if present, else from the
 * environment. Returns undefined when neither is set.
 */
export function secretEnv(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file && file.trim() !== "") {
    try {
      const value = readFileSync(file.trim(), "utf8").trim();
      if (value === "") {
        throw new Error(`secret file ${file} is empty`);
      }
      return value;
    } catch (error) {
      // Loud: a misconfigured secret must not silently fall through to an
      // env var that may hold a stale or weaker value.
      throw new Error(
        `failed to read ${name} from ${file}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  const direct = process.env[name];
  return direct && direct.trim() !== "" ? direct.trim() : undefined;
}

/** `secretEnv`, but throws when the credential is absent. */
export function requireSecret(name: string): string {
  const value = secretEnv(name);
  if (!value) {
    throw new Error(
      `${name} is not configured — set ${name} or mount ${name}_FILE ` +
        `(e.g. a Docker secret at /run/secrets/...)`,
    );
  }
  return value;
}

/**
 * The Postgres DSN, preferring a secret-file password over an interpolated
 * URL.
 *
 * Order: `DATABASE_URL_FILE` → assembled from `PG*` parts when
 * `PGPASSWORD_FILE` is mounted → plain `DATABASE_URL`.
 */
export function databaseUrl(): string | undefined {
  const fromFile = secretEnv("DATABASE_URL");
  if (process.env.DATABASE_URL_FILE) return fromFile;

  const pwd = secretEnv("PGPASSWORD");
  if (process.env.PGPASSWORD_FILE && pwd) {
    const host = process.env.PGHOST ?? "postgres";
    const port = process.env.PGPORT ?? "5432";
    const user = process.env.PGUSER ?? "lh_writer";
    const db = process.env.PGDATABASE ?? "lh";
    // encodeURIComponent so a password containing @ / : / ? cannot break
    // the URL or, worse, silently redirect the connection elsewhere.
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pwd)}@${host}:${port}/${db}`;
  }
  return fromFile;
}
