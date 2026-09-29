import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { loadRootEnv } from "./env.ts";

register(
  "@opentelemetry/instrumentation/hook.mjs",
  pathToFileURL("./"),
);

loadRootEnv();

const {
  createOpenTelemetrySdk,
  loadObservabilityConfig,
  shutdownOpenTelemetrySdk,
} = await import("@fluxora/observability");

const config = loadObservabilityConfig("@fluxora/api");
const sdk = createOpenTelemetrySdk(config);

sdk.start();

console.log(
  `[observability] OpenTelemetry started for ${config.serviceName}`,
);

export async function shutdownTelemetry(): Promise<void> {
  await shutdownOpenTelemetrySdk(sdk);
}