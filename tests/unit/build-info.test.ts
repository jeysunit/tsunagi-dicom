import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readBuildInfo } from "@/lib/build-info";

// 「バージョン情報」の頁の値（docs/spec.md の 2.3）：版は APP_VERSION（scripts/app-version.sh が git から作る）、
// ビルドの commit は BUILD_COMMIT（16 進の 7〜40 文字だけ）。

describe("ビルドの情報", () => {
  it("版が渡されていなければ、何から作ったか分からない印の 0.0.0+unknown を出す", () => {
    expect(readBuildInfo({}).version).toBe("0.0.0+unknown");
  });

  it("APP_VERSION が版の形（X.Y.Z、またはビルドの印つき）ならそのまま出す", () => {
    expect(readBuildInfo({ APP_VERSION: "0.2.0" }).version).toBe("0.2.0");
    expect(readBuildInfo({ APP_VERSION: " 0.2.0+37.g60970f9 " }).version).toBe("0.2.0+37.g60970f9");
  });

  it("版の形でない値は unknown にする（v 付き・桁が足りない・記号）", () => {
    for (const bad of ["v0.2.0", "0.2", "0.2.0+", "0.2.0 rm", "0.2.0+a;b"]) {
      expect(readBuildInfo({ APP_VERSION: bad }).version).toBe("0.0.0+unknown");
    }
  });

  it("BUILD_COMMIT が無ければ commit は出さない", () => {
    expect(readBuildInfo({}).commit).toBeUndefined();
  });

  it("BUILD_COMMIT が 16 進の 7〜40 文字なら、小文字にして出す", () => {
    expect(readBuildInfo({ BUILD_COMMIT: " D986FD7 " }).commit).toBe("d986fd7");
    expect(readBuildInfo({ BUILD_COMMIT: "a".repeat(40) }).commit).toBe("a".repeat(40));
  });

  it("形が違う値は出さない（空・短すぎる・長すぎる・16 進でない）", () => {
    for (const bad of ["", "abc123", "a".repeat(41), "zzzzzzz", "d986fd7; rm"]) {
      expect(readBuildInfo({ BUILD_COMMIT: bad }).commit).toBeUndefined();
    }
  });
});

// scripts/app-version.sh：タグの上・タグより後・タグ無し・git の情報が無い、の 4 通り
describe("scripts/app-version.sh", () => {
  const script = path.resolve(__dirname, "../../scripts/app-version.sh");
  const dirs: string[] = [];
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdio: "pipe",
    })
      .toString()
      .trim();
  // 作業用の一時フォルダの親（/tmp など）より上の git を見に行かせない
  const run = (cwd: string) =>
    execFileSync("sh", [script], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    }).trim();
  const commit = (cwd: string, name: string) => {
    writeFileSync(path.join(cwd, name), name);
    git(cwd, "add", name);
    git(cwd, "commit", "-q", "-m", name);
  };
  const newDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "app-version-"));
    dirs.push(dir);
    return dir;
  };
  const newRepo = () => {
    const dir = newDir();
    git(dir, "init", "-q");
    return dir;
  };

  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true });
  });

  it("タグの上は X.Y.Z", () => {
    const dir = newRepo();
    commit(dir, "a");
    git(dir, "tag", "v0.2.0");
    expect(run(dir)).toBe("0.2.0");
  });

  it("タグより後は X.Y.Z+<commit の数>.g<短い commit>", () => {
    const dir = newRepo();
    commit(dir, "a");
    git(dir, "tag", "v0.2.0");
    commit(dir, "b");
    commit(dir, "c");
    expect(run(dir)).toBe(`0.2.0+2.g${git(dir, "rev-parse", "--short", "HEAD")}`);
  });

  it("タグが 1 つも無ければ 0.0.0+<commit の数>.g<短い commit>", () => {
    const dir = newRepo();
    commit(dir, "a");
    commit(dir, "b");
    expect(run(dir)).toBe(`0.0.0+2.g${git(dir, "rev-parse", "--short", "HEAD")}`);
  });

  it("git の情報が無ければ 0.0.0+unknown", () => {
    expect(run(newDir())).toBe("0.0.0+unknown");
  });
});
