import { performanceBudgetFailures, runBenchmark } from "./benchmark-core.mjs";

const result = runBenchmark();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (process.argv.includes("--assert")) {
  const failures = performanceBudgetFailures(result);
  if (failures.length) {
    process.stderr.write(`performance budget exceeded:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write("performance budgets passed (CPU validation/buffer construction; not browser FPS)\n");
  }
}
