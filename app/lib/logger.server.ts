import pino, { type LoggerOptions } from "pino";

// One JSON line per event on stdout: logger.info({ shop, quoteId }, "what happened").
// Warnings and errors are also sent to Sentry Logs (pinoIntegration in instrument.server.ts).
const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: "vendora", env: process.env.NODE_ENV ?? "development" },
  // The code logs errors as `{ error }`; serialise them like pino's own `err` (message + stack).
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  // Never log secrets or customer personal data, even by accident.
  redact: {
    paths: [
      "accessToken", "*.accessToken", "refreshToken", "*.refreshToken",
      "headers.authorization", "*.headers.authorization", "headers.cookie", "*.headers.cookie",
      "email", "*.email", "phone", "*.phone", "*.address1", "*.address2", "*.firstName", "*.lastName",
      "customer", "*.customer",
    ],
    censor: "[redacted]",
  },
};

const logger = pino(loggerOptions);

export { logger, loggerOptions };
