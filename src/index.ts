#!/usr/bin/env node

import process from "process";
import path from "path";
import os from "os";
import fs from "fs-extra";
import execa from "execa";
import archiver from "archiver";
import cryptoRandomString from "crypto-random-string";
import commander from "commander";

export default async function caxa({
  directory,
  command,
  output,
}: {
  directory: string;
  command: string[];
  output: string;
}): Promise<void> {
  if (
    !(await fs.pathExists(directory)) ||
    !(await fs.lstat(directory)).isDirectory()
  )
    throw new Error(`The path to package isn’t a directory: ‘${directory}’`);

  const buildDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), `caxa-build-`)
  );
  await fs.copy(directory, buildDirectory);
  await execa("npm", ["prune", "--production"], { cwd: buildDirectory });
  await execa("npm", ["dedupe"], { cwd: buildDirectory });
  await fs.ensureDir(path.join(buildDirectory, "node_modules/.bin"));
  await fs.copyFile(
    process.execPath,
    path.join(
      buildDirectory,
      "node_modules/.bin",
      path.basename(process.execPath)
    )
  );

  await fs.ensureDir(path.dirname(output));

  if (output.endsWith(".app")) {
    if (process.platform !== "darwin")
      throw new Error(
        "macOS Application Bundles (.app) are supported in macOS only."
      );
    await fs.remove(output);
    await fs.ensureDir(path.join(output, "Contents/Resources"));
    await fs.move(buildDirectory, path.join(output, "Contents/Resources/app"));
    await fs.ensureDir(path.join(output, "Contents/MacOS"));
    await fs.writeFile(
      path.join(output, "Contents/MacOS", path.basename(output, ".app")),
      `#!/usr/bin/env sh\nopen "$(dirname "$0")/../Resources/start"`,
      { mode: 0o755 }
    );
    await fs.writeFile(
      path.join(output, "Contents/Resources/start"),
      `#!/usr/bin/env sh\n${command
        .map(
          (part) =>
            `"${part.replaceAll(/\{\{\s*caxa\s*\}\}/g, `$(dirname "$0")/app`)}"`
        )
        .join(" ")}`,
      { mode: 0o755 }
    );
  } else {
    if (process.platform === "win32" && !output.endsWith(".exe"))
      throw new Error("An Windows executable must end in ‘.exe’");
    await fs.copyFile(
      path.join(
        __dirname,
        "../stubs",
        ({
          win32: "windows",
          darwin: "macos",
          linux: "linux",
        } as { [platform: string]: string })[process.platform] ??
          (() => {
            throw new Error("caxa isn’t supported on this platform.");
          })()
      ),
      output
    );
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
    await fs.appendFile(
      output,
      "\n" +
        JSON.stringify({
          identifier: cryptoRandomString({
            length: 10,
            type: "alphanumeric",
          }).toLowerCase(),
          command,
        })
    );
  }
}

if (require.main === module)
  (async () => {
    await commander.program
      .requiredOption("-d, --directory <directory>")
      .requiredOption("-c, --command <command-and-arguments...>")
      .requiredOption("-o, --output <output>")
      .version(require("../package.json").version)
      .addHelpText(
        "after",
        `
Examples:

npx ts-node src/index.ts --directory "examples/echo-command-line-parameters" --command "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.js" "some" "embedded arguments" --output "echo-command-line-parameters"

npx ts-node src/index.ts --directory "examples/echo-command-line-parameters" --command "{{caxa}}/node_modules/.bin/node" "{{caxa}}/index.js" "some" "embedded arguments" --output "Echo Command Line Parameters.app"
`
      )
      .action(
        async ({
          directory,
          command,
          output,
        }: {
          directory: string;
          command: string[];
          output: string;
        }) => {
          try {
            await caxa({ directory, command, output });
          } catch (error) {
            console.error(error.message);
            process.exit(1);
          }
        }
      )
      .parseAsync();
  })();
