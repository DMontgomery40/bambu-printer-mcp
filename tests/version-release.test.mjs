import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const npmCli = process.env.npm_execpath || fs.realpathSync(path.join(path.dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));

function releaseFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bambu-release-notes-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../scripts/sync-manifest-version.mjs", import.meta.url), path.join(root, "scripts/sync-manifest-version.mjs"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "release-notes-test", version: "1.2.3", type: "module",
    scripts: { version: "node scripts/sync-manifest-version.mjs" },
  }));
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ version: "1.2.3" }));
  fs.writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## Unreleased\n\n### Fixed\n- Preserve contributor credit for @reporter.\n\n## [1.2.3] – 2026-09-01\n\n- Previous release.\n");
  return root;
}

test("npm version dates pending notes under the bumped version and preserves history", (t) => {
  const root = releaseFixture(t);
  execFileSync(process.execPath, [npmCli, "version", "patch", "--no-git-tag-version"], { cwd: root, stdio: "pipe" });
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  assert.doesNotMatch(changelog, /^## Unreleased$/m);
  assert.match(changelog, /^## \[1\.2\.4\] – \d{4}-\d{2}-\d{2}$/m);
  assert.match(changelog, /\d{4}-\d{2}-\d{2}\n\n### Fixed/);
  assert.ok(changelog.includes("### Fixed\n- Preserve contributor credit for @reporter."));
  assert.ok(changelog.endsWith("## [1.2.3] – 2026-09-01\n\n- Previous release.\n"));
  execFileSync(process.execPath, ["scripts/sync-manifest-version.mjs"], { cwd: root, stdio: "pipe" });
  assert.equal(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), changelog);
});

test("npm's version commit includes promoted release notes", (t) => {
  const root = releaseFixture(t);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
  git(["init"]);
  git(["config", "user.name", "Release Test"]);
  git(["config", "user.email", "release-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "tag.gpgsign", "false"]);
  git(["add", "."]);
  git(["commit", "-m", "Initial fixture"]);
  execFileSync(process.execPath, [npmCli, "version", "patch"], { cwd: root, stdio: "pipe" });
  assert.match(git(["show", "HEAD:CHANGELOG.md"]), /^## \[1\.2\.4\] – \d{4}-\d{2}-\d{2}$/m);
  assert.equal(JSON.parse(git(["show", "HEAD:manifest.json"])).version, "1.2.4");
  assert.equal(git(["status", "--porcelain"]).trim(), "");
});
