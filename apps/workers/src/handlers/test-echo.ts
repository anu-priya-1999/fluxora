import type { Job } from "@fluxora/shared-types";

export async function testEchoHandler(job: Job): Promise<void> {
  const message = job.payload["message"];

  if (typeof message !== "string" || message.length === 0) {
    throw new Error(
      'test.echo requires payload.message to be a non-empty string',
    );
  }

  console.log(
    `[test.echo] worker processed job ${job.id}: ${message}`,
  );
}