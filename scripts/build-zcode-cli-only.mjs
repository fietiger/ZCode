// CLI-only distribution packager.
//
// The upstream `build:zcode` target ships the whole Agentic Development
// Environment: web client, HTTP/WS backend, TUI runtime and the CLI agent.
// This script ships only what `zcode` (TUI) and `zcode --version` need:
//
//   bin/zcode.mjs        runner (TUI dispatch; `--web` intentionally unsupported)
//   agent/zcode.cjs      esbuild agent bundle
//   agent/provider/      builtin provider config
//   agent/node_modules/  TUI runtime closure + playwright-core
//
// The web client, the server entry and the 16 server-side runtime packages
// (hono, ssh2, node-pty, undici, axios, yauzl, node-forge, ...) are dropped.
//
// Usage:
//   node scripts/build-zcode-cli-only.mjs [--target linux-x64] [--out-dir dist/zcode-cli]
//
// Requires the source-only workspace packages (@zcode/shared and friends) to
// already have a dist/ directory: run `pnpm exec tsc -b packages/shared ...`
// first, they have no `build` script so turbo never emits them.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import {
  collectSeaTuiAssets,
  seaTuiAssetPrefix,
} from "../apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs";
import { supportedTargets } from "../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";
import { installScriptSource } from "./zcode-distribution/installer.mjs";

const root = resolve(import.meta.dirname, "..");
const packageDirName = "zcode";
const defaultOutDir = resolve(root, "dist", "zcode-cli");

const usage = `Usage:
  node scripts/build-zcode-cli-only.mjs
  node scripts/build-zcode-cli-only.mjs --target linux-x64
  node scripts/build-zcode-cli-only.mjs --out-dir dist/zcode-cli
  node scripts/build-zcode-cli-only.mjs --base-url http://host/zcode/cli/

Options:
  --target <name>    Runtime target to bundle TUI assets for. One of:
                     ${supportedTargets.join(", ")}
                     Default: linux-x64
  --out-dir <path>   Output directory. Defaults to dist/zcode-cli.
  --skip-build       Reuse an existing agent bundle instead of rebuilding.
  --base-url <url>   Base URL baked into install.sh.
  --help, -h         Show this help.
`;

function readArgValue(argv, arg, index) {
  if (arg.includes("=")) {
    return { nextValue: arg.slice(arg.indexOf("=") + 1), nextIndex: index + 1 };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${arg}`);
  }
  return { nextValue: value, nextIndex: index + 2 };
}

function parseArgs(argv) {
  const options = {
    baseUrl: "",
    help: false,
    outDir: defaultOutDir,
    skipBuild: false,
    target: "linux-x64",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }
    if (arg === "--target" || arg.startsWith("--target=")) {
      const { nextValue, nextIndex } = readArgValue(argv, arg, index);
      if (!supportedTargets.includes(nextValue)) {
        throw new Error(`Unknown --target ${nextValue}. Supported: ${supportedTargets.join(", ")}`);
      }
      options.target = nextValue;
      index = nextIndex - 1;
      continue;
    }
    if (arg === "--out-dir" || arg.startsWith("--out-dir=")) {
      const { nextValue, nextIndex } = readArgValue(argv, arg, index);
      options.outDir = resolve(root, nextValue);
      index = nextIndex - 1;
      continue;
    }
    if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const { nextValue, nextIndex } = readArgValue(argv, arg, index);
      options.baseUrl = nextValue.endsWith("/") ? nextValue : `${nextValue}/`;
      index = nextIndex - 1;
      continue;
    }
    throw new Error(`Unknown option "${arg}".\n${usage}`);
  }

  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`, { cause: result.error });
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status}`);
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return false;
    throw error;
  }
}

async function existsDir(path) {
  try {
    const entries = await readdir(path);
    return entries !== undefined;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function assertFile(path, label) {
  if (!(await exists(path))) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

async function assertDirectory(path, label) {
  if (!(await existsDir(path))) {
    throw new Error(`Missing ${label}: ${path}`);
  }
}

// playwright-core is the CLI's browser automation runtime. It is the only
// external dependency the agent bundle keeps out (see resolveBuildExternal in
// apps/zcode-cli/packages/cli/scripts/build.mjs), so it must be copied next to
// the bundle even in a CLI-only distribution.
async function copyPackageTree({ packageName, packageRoot, requireFrom, seen }) {
  if (seen.has(packageName)) return;
  seen.add(packageName);

  let packageJsonPath;
  try {
    packageJsonPath = requireFrom.resolve(`${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    let current = dirname(requireFrom.resolve(packageName));
    for (;;) {
      const candidate = resolve(current, "package.json");
      if (await exists(candidate)) {
        const parsed = await readJson(candidate).catch(() => null);
        if (parsed?.name === packageName) {
          packageJsonPath = candidate;
          break;
        }
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }

  const packageDirectory = dirname(packageJsonPath);
  const destination = resolve(packageRoot, "node_modules", ...packageName.split("/"));
  await mkdir(dirname(destination), { recursive: true });
  await cp(packageDirectory, destination, {
    dereference: true,
    force: true,
    recursive: true,
    filter: (source) => {
      const rel = relative(packageDirectory, source);
      if (!rel) return true;
      const parts = rel.split(sep);
      return !parts.includes("node_modules") && !parts.includes(".git");
    },
  });

  const packageJson = await readJson(packageJsonPath);
  const requireFromPackage = createRequire(packageJsonPath);
  for (const dependencyName of Object.keys({
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  })) {
    try {
      await copyPackageTree({
        packageName: dependencyName,
        packageRoot,
        requireFrom: requireFromPackage,
        seen,
      });
    } catch (error) {
      if (!Object.hasOwn(packageJson.optionalDependencies ?? {}, dependencyName)) throw error;
      console.warn(`[zcode-cli] optional package ${dependencyName} unavailable; skipping`);
    }
  }
}

async function stageAgent({ packageRoot, target, version }) {
  const agentBundle = resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  const agentProvider = resolve(root, "apps/zcode-cli/packages/cli/dist/provider");
  const notices = resolve(root, "apps/zcode-cli/packages/cli/dist/THIRD-PARTY-NOTICES.md");

  await assertFile(agentBundle, "agent bundle (run the build step first)");
  await assertFile(resolve(agentProvider, "zcode-builtin.json"), "agent provider config");

  const agentRoot = resolve(packageRoot, "agent");
  await mkdir(agentRoot, { recursive: true });
  await cp(agentBundle, resolve(agentRoot, "zcode.cjs"));
  // TUI locates its companion config through the real CLI path; copying only
  // the JS breaks startup outside the repository.
  await cp(agentProvider, resolve(agentRoot, "provider"), { recursive: true });
  if (await exists(notices)) {
    await cp(notices, resolve(agentRoot, "THIRD-PARTY-NOTICES.md"));
  }
  await chmod(resolve(agentRoot, "zcode.cjs"), 0o755);

  // TUI runtime closure for the requested target only. Upstream stages all six
  // targets into one package; a single-target CLI build stays an order of
  // magnitude smaller.
  const stagingDirectory = resolve(root, "dist", ".tui-staging-cli");
  try {
    const { assets, manifest } = await collectSeaTuiAssets({
      root: resolve(root, "apps/zcode-cli"),
      stagingDirectory,
      target,
    });
    for (const file of manifest.files) {
      const destination = resolve(agentRoot, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(assets[`${seaTuiAssetPrefix}${file.path}`], destination);
      await chmod(destination, file.mode);
    }
    console.log(`[zcode-cli] staged ${manifest.files.length} TUI asset files for ${target}`);
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }

  await copyPackageTree({
    packageName: "playwright-core",
    packageRoot: agentRoot,
    requireFrom: createRequire(
      resolve(root, "apps/zcode-cli/packages/cli/package.json"),
    ),
    seen: new Set(),
  });

  await writeFile(
    resolve(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "zcode-cli-runtime",
        private: true,
        type: "module",
        version,
      },
      null,
      2,
    )}\n`,
  );

  await mkdir(resolve(packageRoot, "bin"), { recursive: true });
  const runner = resolve(packageRoot, "bin", "zcode.mjs");
  await cp(resolve(root, "scripts/zcode-distribution/runner.mjs"), runner);
  await chmod(runner, 0o755);
}

async function createTarball({ packageParent, releaseDir, tarballName }) {
  await mkdir(releaseDir, { recursive: true });
  const tarball = resolve(releaseDir, tarballName);
  await rm(tarball, { force: true });
  run("tar", ["-czf", tarball, "-C", packageParent, packageDirName]);
  return tarball;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.baseUrl) {
    console.warn(
      "[zcode-cli] no --base-url given; install.sh will require ZCODE_DIST_BASE_URL",
    );
  }

  const rootPackageJson = await readJson(resolve(root, "package.json"));
  const version = rootPackageJson.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("Root package.json must define a non-empty string version.");
  }

  if (!options.skipBuild) {
    run("pnpm", ["--filter", "@zcode/cli...", "build"]);
  }

  const packageParent = resolve(options.outDir, "work");
  const packageRoot = resolve(packageParent, packageDirName);
  await rm(packageParent, { force: true, recursive: true });
  await mkdir(packageRoot, { recursive: true });

  await stageAgent({ packageRoot, target: options.target, version });

  const tarballName = `zcode-cli-${version}-${options.target}.tar.gz`;
  const releaseDir = resolve(options.outDir, "releases", version);
  const tarball = await createTarball({ packageParent, releaseDir, tarballName });
  const sha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await writeFile(resolve(releaseDir, "sha256.txt"), `${sha256}  ${tarballName}\n`);

  await writeFile(
    resolve(options.outDir, "latest.json"),
    `${JSON.stringify(
      {
        version,
        target: options.target,
        tarball: tarballName,
        sha256,
        channel: "cli",
      },
      null,
      2,
    )}\n`,
  );

  const installScript = resolve(options.outDir, "install.sh");
  await writeFile(installScript, installScriptSource(options.baseUrl));
  await chmod(installScript, 0o755);

  await rm(packageParent, { force: true, recursive: true });

  console.log(`[zcode-cli] version:  ${version}`);
  console.log(`[zcode-cli] target:   ${options.target}`);
  console.log(`[zcode-cli] tarball:  ${tarball}`);
  console.log(`[zcode-cli] sha256:   ${sha256}`);
}

await main();