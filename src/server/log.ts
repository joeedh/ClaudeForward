import { pino } from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const log = pino(
  isDev
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : { level: process.env.LOG_LEVEL ?? "info" },
);
