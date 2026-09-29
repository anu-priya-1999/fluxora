import { packageName as dbPackageName } from "@fluxora/db";
import { packageName as sharedTypesPackageName } from "@fluxora/shared-types";

void dbPackageName;
void sharedTypesPackageName;

/** Workspace package identifier. Job execution is added in a later step. */
export const packageName = "@fluxora/workers" as const;
export * from "./handlers.ts";
export * from "./handlers/test-echo.ts";
export * from "./worker.ts";
