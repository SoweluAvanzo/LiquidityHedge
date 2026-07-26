/**
 * pg-copy-streams ships no type declarations. We use exactly one export:
 * `to(query)` returns a stream suitable for `client.query(...)`, which is
 * how the dataset download streams CSV straight out of Postgres (P2).
 */
declare module "pg-copy-streams" {
  import type { Readable } from "stream";
  export function to(query: string): Readable;
  export function from(query: string): NodeJS.WritableStream;
}
