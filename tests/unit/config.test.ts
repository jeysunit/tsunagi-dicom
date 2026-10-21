import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";

const SECRET = "x".repeat(48);

/** モックと検証モードで起動できる最小の設定 */
const base = {
  BACKEND_KIND: "orthanc",
  BACKEND_MOCK: "true",
  AUTH_MODE: "dev",
  SESSION_SECRET: SECRET,
};

function problemsOf(env: Record<string, string | undefined>, files: Record<string, string> = {}) {
  try {
    loadConfig(env, {
      readFile: (p) => {
        if (p in files) return files[p]!;
        throw new Error("ENOENT");
      },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error("ConfigError が投げられなかった");
}

function variablesOf(env: Record<string, string | undefined>, files?: Record<string, string>) {
  return problemsOf(env, files).map((p) => p.variable);
}

describe("設定の読み込み", () => {
  it("モックと検証モードの最小の設定を型つきで読む", () => {
    const config = loadConfig(base);
    expect(config.backend).toMatchObject({ kind: "orthanc", mock: true });
    expect(config.auth).toMatchObject({ mode: "dev", mfaRequired: true, loginLockThreshold: 5 });
    expect(config.databaseUrl).toBe("file:/data/tsunagi.db");
    expect(config.timeZone).toBe("Asia/Tokyo");
  });

  it("監査の記録：前の SESSION_SECRET（1 行に 1 つ）と、先頭の控えのファイル（絶対のパス）を読む", () => {
    expect(loadConfig(base).audit).toEqual({ anchorFile: undefined, sessionSecretPrevious: [] });
    const config = loadConfig(
      { ...base, SESSION_SECRET_PREVIOUS_FILE: "/run/secrets/previous", AUDIT_ANCHOR_FILE: "/audit-anchors/a.jsonl" },
      { readFile: () => `${"p".repeat(40)}\n\n${"q".repeat(40)}\n` },
    );
    expect(config.audit).toEqual({ anchorFile: "/audit-anchors/a.jsonl", sessionSecretPrevious: ["p".repeat(40), "q".repeat(40)] });
    // 短い値・読めないファイル・相対のパスは起動しない
    expect(variablesOf({ ...base, SESSION_SECRET_PREVIOUS_FILE: "/p" }, { "/p": "short\n" })).toEqual(["SESSION_SECRET_PREVIOUS_FILE"]);
    expect(variablesOf({ ...base, SESSION_SECRET_PREVIOUS_FILE: "/missing" })).toEqual(["SESSION_SECRET_PREVIOUS_FILE"]);
    expect(variablesOf({ ...base, AUDIT_ANCHOR_FILE: "anchors.jsonl" })).toEqual(["AUDIT_ANCHOR_FILE"]);
  });

  it(".env.example の空の値は、設定しないのと同じに扱う", () => {
    const config = loadConfig({ ...base, BACKEND_USERNAME: "", BACKEND_CA_FILE: "", VIEWER_OHIF_URL: "" });
    expect(config.backend.username).toBeUndefined();
    expect(config.viewers.ohifUrl).toBeUndefined();
  });

  it("SESSION_SECRET が空なら起動しない", () => {
    expect(variablesOf({ ...base, SESSION_SECRET: "" })).toEqual(["SESSION_SECRET"]);
    expect(variablesOf({ ...base, SESSION_SECRET: undefined })).toEqual(["SESSION_SECRET"]);
  });

  it("SESSION_SECRET が 32 バイトより短ければ起動しない", () => {
    expect(variablesOf({ ...base, SESSION_SECRET: "short" })).toEqual(["SESSION_SECRET"]);
  });

  it("文言に秘密の値を出さない", () => {
    const secret = "leak-me-please";
    const problems = problemsOf({ ...base, SESSION_SECRET: secret, BACKEND_PASSWORD: "pw-should-not-appear" });
    expect(JSON.stringify(problems)).not.toContain(secret);
    expect(JSON.stringify(problems)).not.toContain("pw-should-not-appear");
  });

  it("誤った値は、どの変数かを示す", () => {
    expect(variablesOf({ ...base, BACKEND_KIND: "pacs" })).toEqual(["BACKEND_KIND"]);
    expect(variablesOf({ ...base, BACKEND_MOCK: "yes" })).toEqual(["BACKEND_MOCK"]);
    expect(variablesOf({ ...base, LOGIN_LOCK_THRESHOLD: "0" })).toEqual(["LOGIN_LOCK_THRESHOLD"]);
    expect(variablesOf({ ...base, SCREEN_LOCK_MINUTES: "-1" })).toEqual(["SCREEN_LOCK_MINUTES"]);
    expect(variablesOf({ ...base, VIEWER_OHIF_URL: "ftp://pacs.example.org/" })).toEqual(["VIEWER_OHIF_URL"]);
    expect(variablesOf({ ...base, DATABASE_URL: "postgresql://db.example.org/x" })).toEqual(["DATABASE_URL"]);
    expect(variablesOf({ ...base, TZ: "Mars/Olympus" })).toEqual(["TZ"]);
  });

  it("パスワードのハッシュを同時に回す数と待たせる数（既定 2・32。範囲の外は起動しない）", () => {
    expect(loadConfig(base).auth).toMatchObject({ passwordHashConcurrency: 2, passwordHashQueue: 32 });
    expect(loadConfig({ ...base, PASSWORD_HASH_CONCURRENCY: "4", PASSWORD_HASH_QUEUE: "0" }).auth).toMatchObject({
      passwordHashConcurrency: 4,
      passwordHashQueue: 0,
    });
    expect(variablesOf({ ...base, PASSWORD_HASH_CONCURRENCY: "0" })).toEqual(["PASSWORD_HASH_CONCURRENCY"]);
    expect(variablesOf({ ...base, PASSWORD_HASH_CONCURRENCY: "9" })).toEqual(["PASSWORD_HASH_CONCURRENCY"]);
    expect(variablesOf({ ...base, PASSWORD_HASH_QUEUE: "1025" })).toEqual(["PASSWORD_HASH_QUEUE"]);
  });

  it("検査の一覧の自動更新の間隔（既定 30 秒。0 で止める。1〜4 秒と 3600 秒より長い値・数でない値は起動しない）", () => {
    expect(loadConfig(base).screen).toEqual({ studyListRefreshSeconds: 30 });
    expect(loadConfig({ ...base, STUDY_LIST_REFRESH_SECONDS: "0" }).screen.studyListRefreshSeconds).toBe(0);
    expect(loadConfig({ ...base, STUDY_LIST_REFRESH_SECONDS: "5" }).screen.studyListRefreshSeconds).toBe(5);
    expect(loadConfig({ ...base, STUDY_LIST_REFRESH_SECONDS: "3600" }).screen.studyListRefreshSeconds).toBe(3600);
    for (const bad of ["1", "4", "3601", "-1", "30s", "1.5"]) {
      expect(variablesOf({ ...base, STUDY_LIST_REFRESH_SECONDS: bad })).toEqual(["STUDY_LIST_REFRESH_SECONDS"]);
    }
  });

  it("セッションの長さと再認証の時間（既定 10 分・12 時間・5 分。範囲の外は起動しない）", () => {
    expect(loadConfig(base).auth).toMatchObject({ pendingSessionMinutes: 10, sessionMaxHours: 12, reauthMinutes: 5 });
    expect(
      loadConfig({ ...base, LOGIN_PENDING_MINUTES: "5", SESSION_MAX_HOURS: "8", REAUTH_MINUTES: "15" }).auth,
    ).toMatchObject({ pendingSessionMinutes: 5, sessionMaxHours: 8, reauthMinutes: 15 });
    expect(variablesOf({ ...base, LOGIN_PENDING_MINUTES: "0" })).toEqual(["LOGIN_PENDING_MINUTES"]);
    expect(variablesOf({ ...base, LOGIN_PENDING_MINUTES: "61" })).toEqual(["LOGIN_PENDING_MINUTES"]);
    expect(variablesOf({ ...base, SESSION_MAX_HOURS: "0" })).toEqual(["SESSION_MAX_HOURS"]);
    expect(variablesOf({ ...base, SESSION_MAX_HOURS: "25" })).toEqual(["SESSION_MAX_HOURS"]);
    expect(variablesOf({ ...base, REAUTH_MINUTES: "0" })).toEqual(["REAUTH_MINUTES"]);
    expect(variablesOf({ ...base, REAUTH_MINUTES: "61" })).toEqual(["REAUTH_MINUTES"]);
  });

  it("画面のロックを解くときの TOTP（SCREEN_UNLOCK_REQUIRE_TOTP。既定 false。true か false だけ）", () => {
    expect(loadConfig(base).auth.screenUnlockRequireTotp).toBe(false);
    expect(loadConfig({ ...base, SCREEN_UNLOCK_REQUIRE_TOTP: "" }).auth.screenUnlockRequireTotp).toBe(false);
    expect(loadConfig({ ...base, SCREEN_UNLOCK_REQUIRE_TOTP: "false" }).auth.screenUnlockRequireTotp).toBe(false);
    expect(loadConfig({ ...base, SCREEN_UNLOCK_REQUIRE_TOTP: "true" }).auth.screenUnlockRequireTotp).toBe(true);
    expect(variablesOf({ ...base, SCREEN_UNLOCK_REQUIRE_TOTP: "yes" })).toEqual(["SCREEN_UNLOCK_REQUIRE_TOTP"]);
  });

  it("いくつも誤っていれば、全部を並べる", () => {
    expect(variablesOf({ ...base, BACKEND_KIND: "pacs", SESSION_SECRET: "" }).sort()).toEqual([
      "BACKEND_KIND",
      "SESSION_SECRET",
    ]);
  });

  it("段 3：BACKEND_KIND は省ける（orthanc）。汎用の DICOMweb（dicomweb）は断る", () => {
    expect(loadConfig({ ...base, BACKEND_KIND: undefined }).backend.kind).toBe("orthanc");
    expect(loadConfig({ ...base, BACKEND_KIND: "" }).backend.kind).toBe("orthanc");
    expect(problemsOf({ ...base, BACKEND_KIND: "dicomweb" })).toEqual([
      { variable: "BACKEND_KIND", message: expect.stringContaining("dicomweb は外した") },
    ]);
  });

  it("モックでなければ Orthanc の URL が2つとも要る", () => {
    // dev はモックのときだけなので、AUTH_MODE の誤りも一緒に並ぶ
    const env = { ...base, BACKEND_MOCK: "false" };
    expect(variablesOf(env).sort()).toEqual(["AUTH_MODE", "BACKEND_DICOMWEB_URL", "BACKEND_ORTHANC_URL"]);
    expect(variablesOf({ ...env, BACKEND_DICOMWEB_URL: "https://pacs.example.org/dicom-web" }).sort()).toEqual([
      "AUTH_MODE",
      "BACKEND_ORTHANC_URL",
    ]);
  });

  describe("AUTH_MODE", () => {
    it("oidc は、この段ではまだ無いと示して止める", () => {
      expect(problemsOf({ ...base, AUTH_MODE: "oidc" })).toEqual([
        { variable: "AUTH_MODE", message: expect.stringContaining("段 4") },
      ]);
    });

    it("設定しなければ local（認証が有効）を既定にする", () => {
      expect(loadConfig({ ...base, AUTH_MODE: undefined }).auth.mode).toBe("local");
    });

    it("local はモックでも実の画像サーバーでも起動する（段 1b）", () => {
      expect(loadConfig({ ...base, AUTH_MODE: "local" }).auth.mode).toBe("local");
      const real = {
        ...base,
        AUTH_MODE: "local",
        BACKEND_MOCK: "false",
        BACKEND_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
        BACKEND_ORTHANC_URL: "https://pacs.example.org",
      };
      expect(loadConfig(real).auth).toMatchObject({ mode: "local", mfaRequired: true, initialAdmin: undefined });
    });

    it("ログインを遅らせ始める回数は、既定で利用者名ごと 10・全体 300（1 分あたり）。0 は誤り", () => {
      expect(loadConfig({ ...base, AUTH_MODE: "local" }).auth).toMatchObject({
        rateLimitPerUserPerMinute: 10,
        rateLimitGlobalPerMinute: 300,
      });
      expect(
        loadConfig({ ...base, LOGIN_RATE_LIMIT_PER_MINUTE: "5", LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE: "50" }).auth,
      ).toMatchObject({ rateLimitPerUserPerMinute: 5, rateLimitGlobalPerMinute: 50 });
      expect(variablesOf({ ...base, LOGIN_RATE_LIMIT_PER_MINUTE: "0" })).toEqual(["LOGIN_RATE_LIMIT_PER_MINUTE"]);
      expect(variablesOf({ ...base, LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE: "x" })).toEqual(["LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE"]);
    });

    it("最初の管理者は、利用者名とパスワードのファイルを両方そろえ、local のときだけ使える", () => {
      const local = { ...base, AUTH_MODE: "local" };
      expect(
        loadConfig({ ...local, INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD_FILE: "/run/secrets/admin" }).auth
          .initialAdmin,
      ).toEqual({ username: "admin", passwordFile: "/run/secrets/admin" });
      expect(variablesOf({ ...local, INITIAL_ADMIN_USERNAME: "admin" })).toEqual(["INITIAL_ADMIN_PASSWORD_FILE"]);
      expect(variablesOf({ ...local, INITIAL_ADMIN_PASSWORD_FILE: "/run/secrets/admin" })).toEqual([
        "INITIAL_ADMIN_USERNAME",
      ]);
      expect(
        variablesOf({ ...local, INITIAL_ADMIN_USERNAME: "Admin User", INITIAL_ADMIN_PASSWORD_FILE: "/run/secrets/admin" }),
      ).toEqual(["INITIAL_ADMIN_USERNAME"]);
      expect(
        variablesOf({ ...base, INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD_FILE: "/run/secrets/admin" }),
      ).toEqual(["INITIAL_ADMIN_USERNAME"]);
    });

    it("dev はモックでなければ起動しない（待ち受けの住所が手元だけでも）", () => {
      const real = {
        ...base,
        BACKEND_MOCK: "false",
        BACKEND_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
        BACKEND_ORTHANC_URL: "https://pacs.example.org",
      };
      expect(problemsOf(real)).toEqual([{ variable: "AUTH_MODE", message: expect.stringContaining("BACKEND_MOCK=true") }]);
      for (const HOSTNAME of ["127.0.0.1", "::1", "localhost", "0.0.0.0"]) {
        expect(variablesOf({ ...real, HOSTNAME })).toEqual(["AUTH_MODE"]);
      }
      expect(loadConfig(base).auth.mode).toBe("dev");
    });

    it("段 4：DEV_ALLOW_WRITE は検証モード（モックだけ）でだけ使え、既定は書き込みを止める", () => {
      // 段 4 で書き込みの操作（送る）ができたので、検証モードでは true を受ける（前は段 4 まで起動しなかった）
      expect(loadConfig({ ...base, DEV_ALLOW_WRITE: "true" }).auth.devAllowWrite).toBe(true);
      expect(loadConfig({ ...base, DEV_ALLOW_WRITE: "false" }).auth).toMatchObject({ mode: "dev", devAllowWrite: false });
      expect(loadConfig(base).auth.devAllowWrite).toBe(false);
      // 検証モードのほか（実の画像サーバーにつなぐ local）では使えない
      expect(problemsOf({ ...base, AUTH_MODE: "local", BACKEND_MOCK: "true", DEV_ALLOW_WRITE: "true" })).toEqual([
        { variable: "DEV_ALLOW_WRITE", message: expect.stringContaining("AUTH_MODE=dev のときだけ") },
      ]);
    });

    it("段 4：書く資格情報は名前とパスワードの組で渡し、無ければ読む資格情報で書く", () => {
      expect(loadConfig(base).backend.writeUsername).toBeUndefined();
      expect(loadConfig({ ...base, BACKEND_WRITE_USERNAME: "writer", BACKEND_WRITE_PASSWORD: "w" }).backend).toMatchObject({
        writeUsername: "writer",
        writePassword: "w",
      });
      expect(variablesOf({ ...base, BACKEND_WRITE_USERNAME: "writer" })).toEqual(["BACKEND_WRITE_PASSWORD"]);
      expect(variablesOf({ ...base, BACKEND_WRITE_PASSWORD: "w" })).toEqual(["BACKEND_WRITE_USERNAME"]);
      expect(variablesOf({ ...base, BACKEND_WRITE_USERNAME: "writer", BACKEND_WRITE_PASSWORD: "w", BACKEND_WRITE_PASSWORD_FILE: "/x" })).toEqual([
        "BACKEND_WRITE_PASSWORD_FILE",
      ]);
    });
  });

  describe("秘密のファイル（*_FILE）", () => {
    const files = { "/run/secrets/session_secret": `${SECRET}\n`, "/run/secrets/oidc": "oidc-from-file\n" };

    it("SESSION_SECRET_FILE を読み、末尾の改行を落とす", () => {
      const config = loadConfig(
        { ...base, SESSION_SECRET: undefined, SESSION_SECRET_FILE: "/run/secrets/session_secret" },
        { readFile: (p) => files[p as keyof typeof files] },
      );
      expect(config.sessionSecret).toBe(SECRET);
    });

    it("OIDC_CLIENT_SECRET_FILE を読む", () => {
      const config = loadConfig(
        { ...base, OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc" },
        { readFile: (p) => files[p as keyof typeof files] },
      );
      expect(config.auth.oidc.clientSecret).toBe("oidc-from-file");
    });

    it("値とファイルを同時に指定したら誤り", () => {
      expect(variablesOf({ ...base, SESSION_SECRET_FILE: "/run/secrets/session_secret" }, files)).toEqual([
        "SESSION_SECRET_FILE",
      ]);
      expect(
        variablesOf({ ...base, OIDC_CLIENT_SECRET: "inline", OIDC_CLIENT_SECRET_FILE: "/run/secrets/oidc" }, files),
      ).toEqual(["OIDC_CLIENT_SECRET_FILE"]);
    });

    it("SESSION_SECRET_FILE が読めない・空・短いなら起動しない", () => {
      const env = { ...base, SESSION_SECRET: undefined };
      expect(variablesOf({ ...env, SESSION_SECRET_FILE: "/nope" })).toEqual(["SESSION_SECRET_FILE"]);
      expect(variablesOf({ ...env, SESSION_SECRET_FILE: "/empty" }, { "/empty": "\n" })).toEqual(["SESSION_SECRET_FILE"]);
      expect(variablesOf({ ...env, SESSION_SECRET_FILE: "/short" }, { "/short": "short\n" })).toEqual([
        "SESSION_SECRET_FILE",
      ]);
    });

    it("ファイルの中身を文言に出さない", () => {
      const problems = problemsOf(
        { ...base, SESSION_SECRET: undefined, SESSION_SECRET_FILE: "/short" },
        { "/short": "leak-me-please" },
      );
      expect(JSON.stringify(problems)).not.toContain("leak-me-please");
    });
  });

  describe("画像サーバーの資格情報", () => {
    it("BACKEND_PASSWORD_FILE を読み、末尾の改行を落とす", () => {
      const config = loadConfig(
        { ...base, BACKEND_USERNAME: "tsunagi", BACKEND_PASSWORD_FILE: "/run/secrets/backend_password" },
        { readFile: () => "from-file\n" },
      );
      expect(config.backend.password).toBe("from-file");
    });

    it("読めない・空のファイルは止める", () => {
      expect(variablesOf({ ...base, BACKEND_USERNAME: "u", BACKEND_PASSWORD_FILE: "/nope" })).toContain(
        "BACKEND_PASSWORD_FILE",
      );
      expect(
        variablesOf({ ...base, BACKEND_USERNAME: "u", BACKEND_PASSWORD_FILE: "/empty" }, { "/empty": "\n" }),
      ).toContain("BACKEND_PASSWORD_FILE");
    });

    it("BACKEND_PASSWORD と BACKEND_PASSWORD_FILE を同時には使えない", () => {
      expect(
        variablesOf(
          { ...base, BACKEND_USERNAME: "u", BACKEND_PASSWORD: "p", BACKEND_PASSWORD_FILE: "/f" },
          { "/f": "p" },
        ),
      ).toEqual(["BACKEND_PASSWORD_FILE"]);
    });

    it("利用者名とパスワードは揃えて渡す", () => {
      expect(variablesOf({ ...base, BACKEND_USERNAME: "u" })).toEqual(["BACKEND_PASSWORD"]);
      expect(variablesOf({ ...base, BACKEND_PASSWORD: "p" })).toEqual(["BACKEND_USERNAME"]);
    });
  });

  describe("証明書", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

    it("BACKEND_CA_FILE の PEM を読む", () => {
      expect(loadConfig({ ...base, BACKEND_CA_FILE: "/ca.pem" }, { readFile: () => pem }).backend.caPem).toBe(pem);
    });

    it("読めない・PEM でない BACKEND_CA_FILE は止める", () => {
      expect(variablesOf({ ...base, BACKEND_CA_FILE: "/missing.pem" })).toEqual(["BACKEND_CA_FILE"]);
      expect(variablesOf({ ...base, BACKEND_CA_FILE: "/x" }, { "/x": "not a cert" })).toEqual(["BACKEND_CA_FILE"]);
    });

    it("証明書の確かめを切る NODE_TLS_REJECT_UNAUTHORIZED=0 では起動しない", () => {
      expect(variablesOf({ ...base, NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toEqual(["NODE_TLS_REJECT_UNAUTHORIZED"]);
    });
  });
});
