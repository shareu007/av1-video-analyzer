import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function findCompiler() {
  for (const candidate of [process.env.CC, "cc", "gcc", "clang"].filter(Boolean)) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const compiler = findCompiler();
if (compiler === null) {
  process.stdout.write("native ABI check skipped: no C11 compiler found\n");
  process.exit(0);
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-abi-"));
try {
  const objectPath = path.join(temporary, "abi-smoke.o");
  const result = spawnSync(compiler, [
    "-std=c11",
    "-pedantic",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-I", "native/include",
    "-c", "native/abi-smoke.c",
    "-o", objectPath,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  } else {
    process.stdout.write(`native ABI v1/v2 compiled with ${compiler}\n`);
  }
  if (result.status === 0) {
    const executablePath = path.join(
      temporary,
      process.platform === "win32" ? "abi-runtime-smoke.exe" : "abi-runtime-smoke",
    );
    const linkResult = spawnSync(compiler, [
      "-std=c11",
      "-pedantic",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I", "native/include",
      "native/abi-smoke.c",
      "native/test/mock_adapters.c",
      "native/test/abi-runtime-smoke.c",
      "-o", executablePath,
    ], { encoding: "utf8" });
    if (linkResult.status !== 0) {
      process.stderr.write(linkResult.stdout);
      process.stderr.write(linkResult.stderr);
      process.exitCode = linkResult.status ?? 1;
    } else {
      const runtimeResult = spawnSync(executablePath, [], { encoding: "utf8" });
      if (runtimeResult.status !== 0) {
        process.stderr.write(runtimeResult.stdout);
        process.stderr.write(runtimeResult.stderr);
        process.exitCode = runtimeResult.status ?? 1;
      } else {
        process.stdout.write("native ABI v1/v2 runtime ownership/callback smoke passed\n");
      }
    }
  }
  if (result.status === 0) {
    const builtinProducerExecutable = path.join(
      temporary,
      process.platform === "win32" ? "libaom-builtin-inspection-smoke.exe" : "libaom-builtin-inspection-smoke",
    );
    const builtinProducerBuild = spawnSync(compiler, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      "-I", "native/test/libaom-fixture",
      "-I", "native/include",
      "native/libaom_builtin_inspection_patch.c",
      "native/test/libaom-fixture/libaom-fixture.c",
      "native/test/libaom-builtin-inspection-smoke.c",
      "-o", builtinProducerExecutable,
    ], { encoding: "utf8" });
    if (builtinProducerBuild.status !== 0) {
      process.stderr.write(builtinProducerBuild.stdout);
      process.stderr.write(builtinProducerBuild.stderr);
      process.exitCode = builtinProducerBuild.status ?? 1;
    } else {
      const builtinProducerResult = spawnSync(builtinProducerExecutable, [], { encoding: "utf8" });
      if (builtinProducerResult.status !== 0) {
        process.stderr.write(builtinProducerResult.stdout);
        process.stderr.write(builtinProducerResult.stderr);
        process.exitCode = builtinProducerResult.status ?? 1;
      } else {
        process.stdout.write("libaom CONFIG_INSPECTION producer mapping smoke passed\n");
      }
    }
  }
  if (result.status === 0) {
    const adapterExecutable = path.join(
      temporary,
      process.platform === "win32" ? "libaom-adapter-smoke.exe" : "libaom-adapter-smoke",
    );
    const adapterBuild = spawnSync(compiler, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      "-DAV1SCOPE_ADAPTER_BUILD=1",
      "-DAV1SCOPE_LIBAOM_BUILD_ID=\"test-patched-fork-build-0000000000000001\"",
      "-I", "native/include",
      "native/libaom_inspection_adapter.c",
      "native/test/libaom-patch-stub.c",
      "native/test/libaom-inspection-adapter-smoke.c",
      "-o", adapterExecutable,
    ], { encoding: "utf8" });
    if (adapterBuild.status !== 0) {
      process.stderr.write(adapterBuild.stdout);
      process.stderr.write(adapterBuild.stderr);
      process.exitCode = adapterBuild.status ?? 1;
    } else {
      const adapterResult = spawnSync(adapterExecutable, [], { encoding: "utf8" });
      if (adapterResult.status !== 0) {
        process.stderr.write(adapterResult.stdout);
        process.stderr.write(adapterResult.stderr);
        process.exitCode = adapterResult.status ?? 1;
      } else {
        process.stdout.write("libaom inspection adapter bridge contract smoke passed\n");
      }
    }
  }
  if (result.status === 0) {
    const sandboxExecutable = path.join(
      temporary,
      process.platform === "win32" ? "worker-sandbox-smoke.exe" : "worker-sandbox-smoke",
    );
    const sandboxBuild = spawnSync(compiler, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      "-I", "native/include",
      "native/worker_sandbox.c",
      "native/test/worker-sandbox-smoke.c",
      "-o", sandboxExecutable,
    ], { encoding: "utf8" });
    if (sandboxBuild.status !== 0) {
      process.stderr.write(sandboxBuild.stdout);
      process.stderr.write(sandboxBuild.stderr);
      process.exitCode = sandboxBuild.status ?? 1;
    } else {
      const sandboxResult = spawnSync(sandboxExecutable, [], { encoding: "utf8" });
      if (sandboxResult.status !== 0) {
        process.stderr.write(sandboxResult.stdout);
        process.stderr.write(sandboxResult.stderr);
        process.exitCode = sandboxResult.status ?? 1;
      } else {
        process.stdout.write(`native worker ${sandboxResult.stdout.trim()}\n`);
      }
    }
    const limitsExecutable = path.join(
      temporary,
      process.platform === "win32" ? "worker-limits-smoke.exe" : "worker-limits-smoke",
    );
    const limitsBuild = spawnSync(compiler, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      "-I", "native/include",
      "native/worker_limits.c",
      "native/test/worker-limits-smoke.c",
      "-o", limitsExecutable,
    ], { encoding: "utf8" });
    if (limitsBuild.status !== 0) {
      process.stderr.write(limitsBuild.stdout);
      process.stderr.write(limitsBuild.stderr);
      process.exitCode = limitsBuild.status ?? 1;
    } else {
      const limitsResult = spawnSync(limitsExecutable, [], { encoding: "utf8" });
      if (limitsResult.status !== 0) {
        process.stderr.write(limitsResult.stdout);
        process.stderr.write(limitsResult.stderr);
        process.exitCode = limitsResult.status ?? 1;
      } else {
        process.stdout.write(`native ${limitsResult.stdout.trim()}\n`);
      }
    }
    const parentDeathExecutable = path.join(
      temporary,
      process.platform === "win32" ? "worker-parent-death-smoke.exe" : "worker-parent-death-smoke",
    );
    const parentDeathBuild = spawnSync(compiler, [
      "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
      "-I", "native/include",
      "native/worker_sandbox.c",
      "native/test/worker-parent-death-smoke.c",
      "-o", parentDeathExecutable,
    ], { encoding: "utf8" });
    if (parentDeathBuild.status !== 0) {
      process.stderr.write(parentDeathBuild.stdout);
      process.stderr.write(parentDeathBuild.stderr);
      process.exitCode = parentDeathBuild.status ?? 1;
    } else {
      const parentDeath = spawnSync(parentDeathExecutable, [], { encoding: "utf8", timeout: 2_000 });
      if (parentDeath.status !== 0) {
        process.stderr.write(parentDeath.stdout);
        process.stderr.write(parentDeath.stderr);
        process.exitCode = parentDeath.status ?? 1;
      } else if (process.platform === "linux" && parentDeath.stdout.trim() !== "unsupported") {
        const childPid = Number(parentDeath.stdout.trim());
        let childExists = true;
        for (let attempt = 0; attempt < 100 && childExists; attempt += 1) {
          try {
            process.kill(childPid, 0);
          } catch (error) {
            if (error.code === "ESRCH") childExists = false;
            else throw error;
          }
          if (childExists) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        if (childExists) {
          try { process.kill(childPid, "SIGKILL"); } catch {}
          process.stderr.write("native worker parent-death smoke left a live child\n");
          process.exitCode = 1;
        } else {
          process.stdout.write("native worker parent-death cleanup smoke passed\n");
        }
      }
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
