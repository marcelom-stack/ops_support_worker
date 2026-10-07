import { runContinuousIngest } from "./continuousIngest.js";

export async function runSupportSyncTick(): Promise<void> {
  await runContinuousIngest();
}
