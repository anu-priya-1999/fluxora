import type { Job } from "@fluxora/shared-types";

export type JobHandler = (job: Job) => Promise<void>;

export type JobHandlerRegistry = Readonly<Record<string, JobHandler>>;
