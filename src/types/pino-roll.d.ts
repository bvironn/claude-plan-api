// Minimal ambient declaration for `pino-roll`.
// Covers ONLY the surface consumed by `src/observability/logger.ts`:
// default import called as `pinoRoll({ file, frequency, size, mkdir })`
// and awaited to yield a Node writable stream.
declare module "pino-roll" {
  interface PinoRollOptions {
    file: string;
    frequency?: "daily" | "hourly" | number;
    size?: string | number;
    mkdir?: boolean;
    limit?: { count?: number };
    extension?: string;
    dateFormat?: string;
    symlink?: boolean;
  }

  const pinoRoll: (options: PinoRollOptions) => Promise<NodeJS.WritableStream>;
  export default pinoRoll;
}
