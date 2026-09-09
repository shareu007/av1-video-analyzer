import { performanceBudgetFailures, runBenchmark } from "./benchmark-core.mjs";

const rounds = Number(process.env.AV1SCOPE_BENCH_ROUNDS ?? 2);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 20) {
  throw new RangeError("AV1SCOPE_BENCH_ROUNDS must be an integer from 1 through 20");
}

for (let round = 1; round <= rounds; round += 1) {
  process.stdout.write(`benchmark gate round ${round}/${rounds}\n`);
  const result = runBenchmark({ isolateSamples: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const failures = performanceBudgetFailures(result);
  if (failures.length) {
    process.stderr.write(`performance budget exceeded:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
    process.exit(1);
  }
  globalThis.gc?.();
}

process.stdout.write(`performance gate passed ${rounds}/${rounds} rounds (CPU validation/buffer construction; not browser FPS)\n`);
