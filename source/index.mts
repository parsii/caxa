import process from "process";
import path from "path";
import os from "os";
import fs from "fs-extra";
import execa from "execa";
import archiver from "archiver";
import cryptoRandomString from "crypto-random-string";
import commander from "commander";
import { globby } from "globby";
import bash from "dedent";

export default async function caxa({
  input,
  output,
  command,
  force = true,
  exclude = [],
  filter = (() => {
    const pathsToExclude = globby
      .sync(exclude, {
        expandDirectories: false,
        onlyFiles: false,
      })
      .map((pathToExclude: string) => path.join(pathToExclude));
    return (pathToCopy: string) =>
      !pathsToExclude.includes(path.join(pathToCopy));
  })(),
  dedupe = true,
  prepareCommand,
  prepare = async (buildDirectory: string) => {
    if (prepareCommand === undefined) return;
    await execa.command(prepareCommand, { cwd: buildDirectory, shell: true });
  },
  includeNode = true,
  stub = path.join(
    __dirname,
    `../stubs/stub--${process.platform}--${process.arch}`
  ),
  identifier = path.join(
    path.basename(path.basename(path.basename(output, ".app"), ".exe"), ".sh"),
    cryptoRandomString({ length: 10, type: "alphanumeric" }).toLowerCase()
  ),
  removeBuildDirectory = true,
  uncompressionMessage,
}: {
  input: string;
  output: string;
  command: string[];
  force?: boolean;
  exclude?: string[];
  filter?: fs.CopyFilterSync | fs.CopyFilterAsync;
  dedupe?: boolean;
  prepareCommand?: string;
  prepare?: (buildDirectory: string) => Promise<void>;
  includeNode?: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory?: boolean;
  uncompressionMessage?: string;
}): Promise<void> {
  if (!(await fs.pathExists(input)) || !(await fs.lstat(input)).isDirectory())
    throw new Error(
      `The path to your application isn’t a directory: ‘${input}’.`
    );
  if ((await fs.pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("An Windows executable must end in ‘.exe’.");

  const buildDirectory = path.join(
    os.tmpdir(),
    "caxa/builds",
    cryptoRandomString({ length: 10, type: "alphanumeric" }).toLowerCase()
  );
  await fs.copy(input, buildDirectory, { filter });
  if (dedupe)
    await execa("npm", ["dedupe", "--production"], { cwd: buildDirectory });
  await prepare(buildDirectory);
  if (includeNode) {
    const node = path.join(
      buildDirectory,
      "node_modules/.bin",
      path.basename(process.execPath)
    );
    await fs.ensureDir(path.dirname(node));
    await fs.copyFile(process.execPath, node);
  }

  await fs.ensureDir(path.dirname(output));
  await fs.remove(output);

  if (output.endsWith(".app")) {
    if (process.platform !== "darwin")
      throw new Error(
        "macOS Application Bundles (.app) are supported in macOS only."
      );
    await fs.ensureDir(path.join(output, "Contents/Resources"));
    await fs.move(
      buildDirectory,
      path.join(output, "Contents/Resources/application")
    );
    await fs.ensureDir(path.join(output, "Contents/MacOS"));
    const name = path.basename(output, ".app");
    await fs.writeFile(
      path.join(output, "Contents/MacOS", name),
      `#!/usr/bin/env sh\nopen "$(dirname "$0")/../Resources/${name}"`,
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(output, "Contents/Resources", name),
      `#!/usr/bin/env sh\n${command
        .map(
          (part) =>
            `"${part.replace(
              /\{\{\s*caxa\s*\}\}/g,
              `$(dirname "$0")/application`
            )}"`
        )
        .join(" ")}`,
      { mode: 0o755 }
    );
  } else if (output.endsWith(".sh")) {
    if (process.platform === "win32")
      throw new Error("The Shell Stub (.sh) isn’t supported in Windows.");
    let stub =
      bash`
        #!/usr/bin/env sh
        export CAXA_TEMPORARY_DIRECTORY="$(dirname $(mktemp))/caxa"
        export CAXA_EXTRACTION_ATTEMPT=-1
        while true
        do
          export CAXA_EXTRACTION_ATTEMPT=$(( CAXA_EXTRACTION_ATTEMPT + 1 ))
          export CAXA_LOCK="$CAXA_TEMPORARY_DIRECTORY/locks/${identifier}/$CAXA_EXTRACTION_ATTEMPT"
          export CAXA_APPLICATION_DIRECTORY="$CAXA_TEMPORARY_DIRECTORY/applications/${identifier}/$CAXA_EXTRACTION_ATTEMPT"
          if [ -d "$CAXA_APPLICATION_DIRECTORY" ] 
          then
            if [ -d "$CAXA_LOCK" ] 
            then
              continue
            else
              break
            fi
          else
            ${
              uncompressionMessage === undefined
                ? bash``
                : bash`echo "${uncompressionMessage}" >&2`
            }
            mkdir -p "$CAXA_LOCK"
            mkdir -p "$CAXA_APPLICATION_DIRECTORY"
            tail -n+{{caxa-number-of-lines}} "$0" | tar -xz -C "$CAXA_APPLICATION_DIRECTORY"
            rmdir "$CAXA_LOCK"
            break
          fi
        done
        exec ${command
          .map(
            (commandPart) =>
              `"${commandPart.replace(
                /\{\{\s*caxa\s*\}\}/g,
                `"$CAXA_APPLICATION_DIRECTORY"`
              )}"`
          )
          .join(" ")} "$@"
      ` + "\n";
    stub = stub.replace(
      "{{caxa-number-of-lines}}",
      String(stub.split("\n").length)
    );
    await fs.writeFile(output, stub, { mode: 0o755 });
    await appendTarballOfBuildDirectoryToOutput();
  } else {
    if (!(await fs.pathExists(stub)))
      throw new Error(
        `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`
      );
    await fs.copyFile(stub, output);
    await fs.chmod(output, 0o755);
    await appendTarballOfBuildDirectoryToOutput();
    await fs.appendFile(
      output,
      "\n" + JSON.stringify({ identifier, command, uncompressionMessage })
    );
  }

  if (removeBuildDirectory) await fs.remove(buildDirectory);

  async function appendTarballOfBuildDirectoryToOutput(): Promise<void> {
    const archive = archiver("tar", { gzip: true });
    const archiveStream = fs.createWriteStream(output, { flags: "a" });
    archive.pipe(archiveStream);
    archive.directory(buildDirectory, false);
    await archive.finalize();
    // FIXME: Use ‘stream/promises’ when Node.js 16 lands, because then an LTS version will have the feature: await stream.finished(archiveStream);
    await new Promise((resolve, reject) => {
      archiveStream.on("finish", resolve);
      archiveStream.on("error", reject);
    });
  }
}

if (require.main === module) (async () => {})();

/*
import { jest, beforeAll, test, expect } from "@jest/globals";
import os from "os";
import path from "path";
import fs from "fs-extra";
import execa from "execa";

jest.setTimeout(300_000);

const caxaDirectory = path.join(os.tmpdir(), "caxa");
const testsDirectory = path.join(caxaDirectory, "tests");
beforeAll(async () => {
  await fs.remove(caxaDirectory);
});

test("echo-command-line-parameters", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters${process.platform === "win32" ? ".exe" : ""}`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
    "some",
    "embedded arguments",
    "--an-option-thats-part-of-the-command",
  ]);
  expect(
    (
      await execa(output, ["and", "some arguments passed on the call"], {
        all: true,
      })
    ).all
  ).toMatchInlineSnapshot(`
    "[
      \\"some\\",
      \\"embedded arguments\\",
      \\"--an-option-thats-part-of-the-command\\",
      \\"and\\",
      \\"some arguments passed on the call\\"
    ]"
  `);
});

if (process.platform === "darwin")
  test("Echo Command Line Parameters.app", async () => {
    const output = path.join(
      testsDirectory,
      "Echo Command Line Parameters.app"
    );
    await execa("ts-node", [
      "source/index.ts",
      "--input",
      "examples/echo-command-line-parameters",
      "--output",
      output,
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
      "some",
      "embedded arguments",
    ]);
    console.log(
      `Test the macOS Application Bundle (.app) manually:\n$ open -a "${output}"`
    );
    expect(
      (
        await execa(
          path.join(output, "/Contents/Resources/Echo Command Line Parameters"),
          { all: true }
        )
      ).all
    ).toMatchInlineSnapshot(`
      "[
        \\"some\\",
        \\"embedded arguments\\"
      ]"
    `);
  });

if (process.platform !== "win32")
  test("echo-command-line-parameters.sh", async () => {
    const output = path.join(testsDirectory, "echo-command-line-parameters.sh");
    await execa("ts-node", [
      "source/index.ts",
      "--input",
      "examples/echo-command-line-parameters",
      "--output",
      output,
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
      "some",
      "embedded arguments",
      "--an-option-thats-part-of-the-command",
    ]);
    expect(
      (
        await execa(output, ["and", "some arguments passed on the call"], {
          all: true,
        })
      ).all
    ).toMatchInlineSnapshot(`
      "[
        \\"some\\",
        \\"embedded arguments\\",
        \\"--an-option-thats-part-of-the-command\\",
        \\"and\\",
        \\"some arguments passed on the call\\"
      ]"
    `);
  });

test("native-modules", async () => {
  const output = path.join(
    testsDirectory,
    `native-modules${process.platform === "win32" ? ".exe" : ""}`
  );
  await execa("npm", ["ci"], { cwd: "examples/native-modules" });
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/native-modules",
    "--output",
    output,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(`
          "@leafac/sqlite: {
            \\"example\\": \\"caxa native modules\\"
          }
          sharp: 48"
      `);
});

test("false", async () => {
  const output = path.join(
    testsDirectory,
    `false${process.platform === "win32" ? ".exe" : ""}`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/false",
    "--output",
    output,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
  ]);
  await expect(execa(output)).rejects.toThrowError(
    "Command failed with exit code 1"
  );
});

test("--force", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--force${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
    "some",
    "embedded arguments",
    "--an-option-thats-part-of-the-command",
  ]);
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
    "some",
    "embedded arguments",
    "--an-option-thats-part-of-the-command",
  ]);
  await expect(
    execa("ts-node", [
      "source/index.ts",
      "--input",
      "examples/echo-command-line-parameters",
      "--output",
      output,
      "--no-force",
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
      "some",
      "embedded arguments",
      "--an-option-thats-part-of-the-command",
    ])
  ).rejects.toThrowError();
});

test("--exclude", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--exclude${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--exclude",
    "examples/echo-command-line-parameters/index.js",
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "--print",
    'JSON.stringify(require("fs").existsSync(require("path").join(String.raw`{{caxa}}`, "index.js")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"false"`
  );
});

test("--dedupe", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--dedupe${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--no-dedupe",
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "--print",
    'JSON.stringify(require("fs").existsSync(require("path").join(String.raw`{{caxa}}`, "package-lock.json")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"false"`
  );
});

test("--prepare-command", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--prepare-command${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--prepare-command",
    `"${process.execPath}" --eval "require('fs').writeFileSync('prepare-output.txt', '')"`,
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "--print",
    'JSON.stringify(require("fs").existsSync(require("path").join(String.raw`{{caxa}}`, "prepare-output.txt")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"true"`
  );
});

test("--include-node", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--include-node${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--no-include-node",
    "--",
    process.execPath,
    "--print",
    'JSON.stringify(require("fs").existsSync(require("path").join(String.raw`{{caxa}}`, "node_modules/.bin/node")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"false"`
  );
});

test("--stub", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--stub${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await expect(
    execa("ts-node", [
      "source/index.ts",
      "--input",
      "examples/echo-command-line-parameters",
      "--output",
      output,
      "--stub",
      "/a-path-that-doesnt-exist",
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
      "some",
      "embedded arguments",
      "--an-option-thats-part-of-the-command",
    ])
  ).rejects.toThrowError();
});

test("--identifier", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--identifier${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--identifier",
    "identifier",
    "--",
    process.execPath,
    "--print",
    'JSON.stringify(require("fs").existsSync(require("path").join(require("os").tmpdir(), "caxa/applications/identifier")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"true"`
  );
});

test("--remove-build-directory", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--remove-build-directory${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--no-remove-build-directory",
    "--prepare-command",
    `"${process.execPath}" --eval "require('fs').writeFileSync('build-directory.txt', process.cwd())"`,
    "--",
    process.execPath,
    "--print",
    'JSON.stringify(require("fs").existsSync(require("fs").readFileSync(require("path").join(String.raw`{{caxa}}`, "build-directory.txt"), "utf8")))',
  ]);
  expect((await execa(output, { all: true })).all).toMatchInlineSnapshot(
    `"true"`
  );
});

test("--uncompression-message", async () => {
  const output = path.join(
    testsDirectory,
    `echo-command-line-parameters--uncompression-message${
      process.platform === "win32" ? ".exe" : ""
    }`
  );
  await execa("ts-node", [
    "source/index.ts",
    "--input",
    "examples/echo-command-line-parameters",
    "--output",
    output,
    "--uncompression-message",
    "This may take a while to run the first time, please wait...",
    "--",
    "{{caxa}}/node_modules/.bin/node",
    "{{caxa}}/index.js",
    "some",
    "embedded arguments",
    "--an-option-thats-part-of-the-command",
  ]);
  expect((await execa(output, { all: true })).all).toMatch(
    "This may take a while to run the first time, please wait..."
  );
});

  */