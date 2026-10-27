import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 開発の一式の台本（docker/dev/up.sh・refresh.sh）：docker と git を偽物に替えて流し、
// 環境変数の既定と上書き、secrets の置き場の切り替え、表示の分岐、立て直しの順番と失敗のときの止まり方を確かめる。
// 本物の Docker・ネットワークは使わない。

const repo = path.resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(path.join(repo, p), "utf8");

// 偽の docker：呼ばれた引数と、台本が渡した環境変数を記録する。FAKE_FAIL_ON を引数に含む呼び出しは失敗させる
const FAKE_DOCKER = `#!/bin/sh
echo "docker $* | secrets=$TSUNAGI_DEV_SECRETS_DIR tsunagi_secrets=$TSUNAGI_SECRETS_DIR dtg=$DTG_GIT_REF ris=$RIS_GIT_REF image=$TSUNAGI_IMAGE" >> "$FAKE_LOG"
case "$*" in
  "compose version") exit 0 ;;
  *"config --images"*) echo "tsunagi-dev-dtg:local"; echo "tsunagi-dev-ris:local"; exit 0 ;;
  "volume inspect "*) [ "$FAKE_VOLUME_EXISTS" = 1 ]; exit $? ;;
esac
if [ -n "$FAKE_FAIL_ON" ]; then
  case "$*" in *"$FAKE_FAIL_ON"*) echo "fake docker: 失敗させた" >&2; exit 1 ;; esac
fi
exit 0
`;

// 偽の git：main の commit を返す。ほかは記録だけ
const FAKE_GIT = `#!/bin/sh
echo "git $*" >> "$FAKE_LOG"
case "$*" in
  *"ls-remote"*dicom-test-generator*) printf '%s\\trefs/heads/main\\n' dddddddddddddddddddddddddddddddddddddddd ;;
  *"ls-remote"*ris-emulator*) printf '%s\\trefs/heads/main\\n' rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr ;;
  *"status --porcelain"*) [ "$FAKE_DIRTY" = 1 ] && echo " M docker/dev/up.sh" ;;
  *"symbolic-ref"*) echo "\${FAKE_BRANCH-main}" ;;
  *"rev-parse HEAD"*) echo "aaa" ;;
  *"rev-parse origin/main"*) echo "\${FAKE_ORIGIN:-aaa}" ;;
  *"rev-parse"*) echo "abc1234" ;;
esac
exit 0
`;

// compose の secrets が file: で読む全部のファイル（deploy/compose.yaml・docker/dev/compose.yaml・hl7.override.yaml）
const SECRET_FILES = [
  "session_secret.txt",
  "backend_password.txt",
  "initial_admin_password.txt",
  "orthanc-users.json",
  "dtg_web_password.txt",
  "ris_web_password.txt",
  "hl7_receiver_token.txt",
];

let work: string;
let fakeBin: string;
let log: string;

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), "dev-scripts-test-"));
  fakeBin = path.join(work, "bin");
  mkdirSync(fakeBin);
  for (const [name, body] of [
    ["docker", FAKE_DOCKER],
    ["git", FAKE_GIT],
  ] as const) {
    writeFileSync(path.join(fakeBin, name), body);
    chmodSync(path.join(fakeBin, name), 0o755);
  }
  log = path.join(work, "calls.log");
  writeFileSync(log, "");
});
afterEach(() => {
  rmSync(work, { recursive: true });
});

const run = (script: string, env: Record<string, string> = {}, cwd = work) => {
  const clean: Record<string, string> = { PATH: `${fakeBin}:${process.env.PATH ?? ""}`, HOME: work, FAKE_LOG: log };
  const r = spawnSync("sh", [path.join(repo, script)], { env: { ...clean, ...env } as NodeJS.ProcessEnv, cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
};
const find = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle));

describe("compose の既定", () => {
  it("DTG・ris-emulator は既定で main を取り、DTG_GIT_REF・RIS_GIT_REF で commit に固定できる", () => {
    const compose = read("docker/dev/compose.yaml");
    expect(compose).toContain("dicom-test-generator.git#${DTG_GIT_REF:-main}");
    expect(compose).toContain("ris-emulator.git#${RIS_GIT_REF:-main}");
  });

  it("secrets の置き場の既定は今までと同じ場所で、TSUNAGI_DEV_SECRETS_DIR で替えられる", () => {
    expect(read("docker/dev/compose.yaml")).toContain("file: ${TSUNAGI_DEV_SECRETS_DIR:-./secrets}/ris_web_password.txt");
    expect(read("docker/dev/compose.yaml")).toContain("file: ${TSUNAGI_DEV_SECRETS_DIR:-./secrets}/dtg_web_password.txt");
    expect(read("docker/dev/hl7.override.yaml")).toContain(
      "file: ${TSUNAGI_DEV_SECRETS_DIR:-../docker/dev/secrets}/hl7_receiver_token.txt",
    );
  });

  it("refresh.sh の取得元は compose の取得元と同じリポジトリ", () => {
    const compose = read("docker/dev/compose.yaml");
    const refresh = read("docker/dev/refresh.sh");
    for (const name of ["DTG_REPO", "RIS_REPO"]) {
      const url = new RegExp(`^${name}=(\\S+)$`, "m").exec(refresh)?.[1];
      expect(url).toBeTruthy();
      expect(compose).toContain(`${url}#`);
    }
  });

  it("台本の構文が通る", () => {
    for (const s of ["up.sh", "refresh.sh", "lib.sh"]) {
      expect(() => execFileSync("sh", ["-n", path.join(repo, "docker/dev", s)])).not.toThrow();
    }
  });
});

describe("up.sh：secrets の置き場", () => {
  it("TSUNAGI_DEV_SECRETS_DIR の置き場に secret を作り、compose にその置き場を渡す", () => {
    const dir = path.join(work, "outside", "secrets");
    const r = run("docker/dev/up.sh", { TSUNAGI_DEV_SECRETS_DIR: dir, TSUNAGI_IMAGE: "example/img:1" });
    expect(r.status).toBe(0);
    for (const f of ["session_secret.txt", "backend_password.txt", "initial_admin_password.txt", "dtg_web_password.txt", "ris_web_password.txt", "hl7_receiver_token.txt"]) {
      expect(readFileSync(path.join(dir, f), "utf8").length).toBeGreaterThan(8);
    }
    const up = r.calls.find((c) => c.includes(" up -d"));
    expect(up).toContain(`secrets=${dir} `);
    expect(up).toContain(`tsunagi_secrets=${dir} `);
    expect(r.out).toContain(`${dir}/dtg_web_password.txt`);
  });

  it("相対のパスは流した場所から数える", () => {
    const r = run("docker/dev/up.sh", { TSUNAGI_DEV_SECRETS_DIR: "rel/secrets", TSUNAGI_IMAGE: "example/img:1" });
    expect(r.status).toBe(0);
    const dir = path.join(work, "rel/secrets");
    expect(readFileSync(path.join(dir, "ris_web_password.txt"), "utf8").length).toBeGreaterThan(8);
    expect(r.calls.find((c) => c.includes(" up -d"))).toContain(`secrets=${dir} `);
  });

  it("あるファイルは書き換えない", () => {
    const dir = path.join(work, "keep");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "dtg_web_password.txt"), "keep-me\n");
    run("docker/dev/up.sh", { TSUNAGI_DEV_SECRETS_DIR: dir, TSUNAGI_IMAGE: "example/img:1" });
    expect(readFileSync(path.join(dir, "dtg_web_password.txt"), "utf8")).toBe("keep-me\n");
  });
});

describe("up.sh：~ で始まる置き場", () => {
  it("~ は $HOME に展開する（流した場所の下に ~ のフォルダを作らない）", () => {
    const r = run("docker/dev/up.sh", { TSUNAGI_DEV_SECRETS_DIR: "~/home-rel/secrets", TSUNAGI_IMAGE: "example/img:1" });
    expect(r.status).toBe(0);
    const dir = path.join(work, "home-rel/secrets");
    expect(readFileSync(path.join(dir, "ris_web_password.txt"), "utf8").length).toBeGreaterThan(8);
    expect(r.calls.find((c) => c.includes(" up -d"))).toContain(`secrets=${dir} `);
    expect(existsSync(path.join(work, "~"))).toBe(false);
  });
});

describe("deploy/init-secrets.sh：置き場の権限", () => {
  const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8);

  it("置き場を新しく作ったときは 0700 にする", () => {
    const dir = path.join(work, "new", "secrets");
    const r2 = spawnSync("sh", [path.join(repo, "deploy/init-secrets.sh"), dir], { encoding: "utf8" });
    expect(r2.status).toBe(0);
    expect(modeOf(dir)).toBe("700");
  });

  it("もとからある置き場の権限は変えず、0700 でなければ警告だけ出す", () => {
    const dir = path.join(work, "existing");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const r = spawnSync("sh", [path.join(repo, "deploy/init-secrets.sh"), dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(modeOf(dir)).toBe("755");
    expect(r.stderr).toContain("0700 ではない");
    expect(r.stderr).toContain(dir);
  });

  it("もとからある置き場が 0700 なら、警告を出さない", () => {
    const dir = path.join(work, "existing700");
    mkdirSync(dir);
    chmodSync(dir, 0o700);
    const r = spawnSync("sh", [path.join(repo, "deploy/init-secrets.sh"), dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("文書：置き場と dc の使い方", () => {
  it("外の置き場は専用のディレクトリを指す（~/.config そのものを指さない）", () => {
    for (const p of ["docs/round-trip-test.md", "docker/dev/up.sh", "docker/dev/lib.sh", "deploy/init-secrets.sh"]) {
      expect(read(p)).toContain("専用のディレクトリ");
    }
  });

  it("dc を直に使うときも TSUNAGI_DEV_SECRETS_DIR を同じに渡す", () => {
    expect(read("docs/round-trip-test.md")).toMatch(/`dc`[^\n]*TSUNAGI_DEV_SECRETS_DIR を同じに渡す/);
  });

  it("毎晩の立て直しは main にいる専用の作業ツリーで流す", () => {
    expect(read("docs/round-trip-test.md")).toContain("毎晩の立て直しは main にいる専用の作業ツリーで流す");
    expect(read("docker/dev/refresh.sh")).toContain("毎晩の立て直しは main にいる専用の作業ツリーで流す");
  });
});

describe("up.sh：最後の表示", () => {
  it("compose を直に使うときも TSUNAGI_DEV_SECRETS_DIR を同じに渡すと案内する", () => {
    const dir = path.join(work, "s2");
    const r = run("docker/dev/up.sh", { TSUNAGI_DEV_SECRETS_DIR: dir, TSUNAGI_IMAGE: "example/img:1" });
    expect(r.out).toContain(`TSUNAGI_DEV_SECRETS_DIR=${dir}`);
  });

  const env = (extra: Record<string, string>) => ({
    TSUNAGI_DEV_SECRETS_DIR: path.join(work, "s"),
    TSUNAGI_IMAGE: "example/img:1",
    ...extra,
  });

  it("管理者の DB（volume tsunagi-data）が無いときは、最初の管理者のパスワードの案内を出す", () => {
    const r = run("docker/dev/up.sh", env({ FAKE_VOLUME_EXISTS: "0" }));
    expect(r.out).toContain("最初の管理者は admin。パスワードは");
    expect(r.out).toContain("最初のログインで、自分のパスワード");
    expect(r.out).not.toContain("reset-admin-password");
    expect(find(r.calls, "volume inspect tsunagi-dev_tsunagi-data")).toBeGreaterThanOrEqual(0);
  });

  it("管理者の DB があるときは、最初のパスワードが使えないことと、忘れたときのコマンドを出す", () => {
    const r = run("docker/dev/up.sh", env({ FAKE_VOLUME_EXISTS: "1" }));
    expect(r.out).toContain("初回ログインでパスワードを変えていれば");
    expect(r.out).toContain("使えない");
    expect(r.out).toContain("exec tsunagi node cli/reset-admin-password.mjs --user admin");
    expect(r.out).not.toContain("最初の管理者は admin。パスワードは");
  });

  it("DB があるかは、立てる前に確かめる", () => {
    const r = run("docker/dev/up.sh", env({ FAKE_VOLUME_EXISTS: "1" }));
    expect(find(r.calls, "volume inspect")).toBeLessThan(find(r.calls, " up -d"));
  });
});

describe("refresh.sh", () => {
  const secretsDir = () => {
    const dir = path.join(work, "secrets");
    mkdirSync(dir, { recursive: true });
    for (const f of SECRET_FILES) writeFileSync(path.join(dir, f), "x\n");
    return dir;
  };
  const lastLine = (out: string) => out.trimEnd().split("\n").at(-1);

  it("secrets が無いときは、作らずに止まり、コンテナには触れない", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: path.join(work, "none") });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("up.sh");
    expect(find(r.calls, "up -d")).toBe(-1);
    expect(find(r.calls, "build")).toBe(-1);
    expect(lastLine(r.out)).toMatch(/^refresh: .*結果=失敗/);
  });

  it("main を取り込み、先に作ってから立て直す。volume と secrets は消さない", () => {
    const dir = secretsDir();
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: dir });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`git -C ${repo} merge --quiet --ff-only origin/main`);
    const order = ["fetch", "build -t tsunagi-dev-tsunagi:local", "compose -f", " up -d --build"].map((n) => find(r.calls, n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(find(r.calls, "compose -f " + path.join(repo, "docker/dev/compose.yaml") + " -p tsunagi-dev build")).toBeLessThan(
      find(r.calls, " up -d --build"),
    );
    for (const c of r.calls) {
      expect(c.split(" | ")[0]).not.toMatch(/ (down|rm|prune|--volumes|-v)( |$)/);
    }
    const up = r.calls.find((c) => c.includes(" up -d --build"))!;
    expect(up).toContain("-p tsunagi-dev");
    expect(up).toContain("dtg=dddddddddddddddddddddddddddddddddddddddd");
    expect(up).toContain("ris=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr");
    expect(up).toContain(`secrets=${dir} `);
    expect(lastLine(r.out)).toBe("refresh: tsunagi-dicom=abc1234 dtg=ddddddd ris=rrrrrrr 結果=成功");
  });

  it("DTG_GIT_REF・RIS_GIT_REF に commit を渡すと、main を引かずにそれを使う", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), DTG_GIT_REF: sha });
    expect(r.status).toBe(0);
    expect(find(r.calls, "ls-remote https://github.com/jeysunit/dicom-test-generator.git")).toBe(-1);
    expect(find(r.calls, "ls-remote https://github.com/jeysunit/ris-emulator.git")).toBeGreaterThanOrEqual(0);
    expect(r.calls.find((c) => c.includes(" up -d --build"))).toContain(`dtg=${sha} `);
    expect(lastLine(r.out)).toContain("dtg=0123456 ");
  });

  it("イメージの作成が失敗したら、立て直しに進まず、失敗を 1 行で出す", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_FAIL_ON: "-p tsunagi-dev build" });
    expect(r.status).not.toBe(0);
    expect(find(r.calls, " up -d")).toBe(-1);
    expect(lastLine(r.out)).toBe("refresh: tsunagi-dicom=abc1234 dtg=ddddddd ris=rrrrrrr 結果=失敗（段：イメージの作成。動いているコンテナはそのまま）");
  });

  it("立て直し（up）が失敗したときは、途中で止まったことと確かめ方を出す", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_FAIL_ON: " up -d" });
    expect(r.status).not.toBe(0);
    expect(lastLine(r.out)).toContain("結果=失敗（立て直しの途中で止まった。docker compose -p tsunagi-dev ps で確かめる）");
  });

  it("作業ツリーに未コミットの変更があれば、何もせずに止まる", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_DIRTY: "1" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("未コミット");
    expect(find(r.calls, "merge")).toBe(-1);
    expect(find(r.calls, "docker build")).toBe(-1);
  });

  it("ローカルの main が origin/main と一致しないときは、作らずに止まる", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_ORIGIN: "bbb" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("origin/main と一致しない");
    expect(find(r.calls, "docker build")).toBe(-1);
    expect(find(r.calls, " up -d")).toBe(-1);
  });

  it("未コミットの確かめは、追跡していないファイルも見る", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_DIRTY: "1" });
    expect(r.calls.find((c) => c.includes("status --porcelain"))).not.toContain("--untracked-files=no");
  });

  it("main でない枝にいるときは、切り替えずに止まる（枝の名前を出す）", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_BRANCH: "chore/other" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("main 以外の枝（chore/other）にいるので立て直さない。main に戻すか、専用の作業ツリーで流す");
    expect(find(r.calls, "switch")).toBe(-1);
    expect(find(r.calls, "merge")).toBe(-1);
    expect(find(r.calls, "docker build")).toBe(-1);
    expect(find(r.calls, " up -d")).toBe(-1);
    expect(lastLine(r.out)).toBe("refresh: tsunagi-dicom=- dtg=- ris=- 結果=失敗（段：枝の確かめ。動いているコンテナはそのまま）");
  });

  it("detached HEAD のときも、切り替えずに止まる", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), FAKE_BRANCH: "" });
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("main 以外の枝（detached HEAD）にいるので立て直さない");
    expect(find(r.calls, "switch")).toBe(-1);
    expect(lastLine(r.out)).toContain("段：枝の確かめ");
  });

  for (const f of SECRET_FILES) {
    it(`secrets の置き場に ${f} が無いときは、コンテナに触れずに止まる`, () => {
      const dir = secretsDir();
      rmSync(path.join(dir, f));
      const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: dir });
      expect(r.status).not.toBe(0);
      expect(r.err).toContain(`secrets の置き場（${dir}）に ${f} が無い`);
      expect(find(r.calls, "git")).toBe(-1);
      expect(find(r.calls, "docker build")).toBe(-1);
      expect(find(r.calls, " up -d")).toBe(-1);
      expect(lastLine(r.out)).toMatch(/^refresh: .*結果=失敗/);
    });
  }

  it("secrets の置き場の確かめは、中身を読まず、存在だけを見る", () => {
    expect(read("docker/dev/refresh.sh")).not.toMatch(/\bcat\b[^\n]*\$secrets|<\s*"\$secrets/);
  });

  it("secrets の置き場が ~ で始まるときは $HOME で数える", () => {
    const dir = secretsDir();
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: "~/secrets" });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.includes(" up -d --build"))).toContain(`secrets=${dir} `);
  });

  it("TSUNAGI_IMAGE を渡すと、早送りもイメージの作成もしない", () => {
    const r = run("docker/dev/refresh.sh", { TSUNAGI_DEV_SECRETS_DIR: secretsDir(), TSUNAGI_IMAGE: "example/img:9" });
    expect(r.status).toBe(0);
    expect(find(r.calls, "merge")).toBe(-1);
    expect(find(r.calls, "docker build")).toBe(-1);
    expect(lastLine(r.out)).toContain("tsunagi-dicom=example/img:9 ");
  });
});
