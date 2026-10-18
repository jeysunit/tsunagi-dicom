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
    expect(config.auth).toMatchObject({ mode: "dev", devAllowWrite: false, mfaRequired: true, loginLockThreshold: 5 });
    expect(config.databaseUrl).toBe("file:/data/tsunagi.db");
    expect(config.timeZone).toBe("Asia/Tokyo");
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

  it("いくつも誤っていれば、全部を並べる", () => {
    expect(variablesOf({ ...base, BACKEND_KIND: undefined, SESSION_SECRET: "" }).sort()).toEqual([
      "BACKEND_KIND",
      "SESSION_SECRET",
    ]);
  });

  it("モックでなければ画像サーバーの URL が要る", () => {
    const env = { ...base, BACKEND_MOCK: "false", HOSTNAME: "127.0.0.1" };
    expect(variablesOf(env).sort()).toEqual(["BACKEND_DICOMWEB_URL", "BACKEND_ORTHANC_URL"]);
    expect(variablesOf({ ...env, BACKEND_KIND: "dicomweb" })).toEqual(["BACKEND_DICOMWEB_URL"]);
  });

  describe("AUTH_MODE", () => {
    it("local と oidc は、この段ではまだ無いと示して止める", () => {
      expect(problemsOf({ ...base, AUTH_MODE: "local" })).toEqual([
        { variable: "AUTH_MODE", message: expect.stringContaining("段 1b") },
      ]);
      expect(problemsOf({ ...base, AUTH_MODE: "oidc" })).toEqual([
        { variable: "AUTH_MODE", message: expect.stringContaining("段 4") },
      ]);
    });

    it("設定しなければ local（認証が有効）を既定にし、この段では止める", () => {
      expect(variablesOf({ ...base, AUTH_MODE: undefined })).toEqual(["AUTH_MODE"]);
    });

    it("dev はモックでも手元だけでもなければ起動しない", () => {
      const real = {
        ...base,
        BACKEND_MOCK: "false",
        BACKEND_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
        BACKEND_ORTHANC_URL: "https://pacs.example.org",
      };
      expect(variablesOf({ ...real, HOSTNAME: "0.0.0.0" })).toEqual(["AUTH_MODE"]);
      expect(variablesOf({ ...real, HOSTNAME: undefined })).toEqual(["AUTH_MODE"]);
      expect(loadConfig({ ...real, HOSTNAME: "127.0.0.1" }).auth.mode).toBe("dev");
      expect(loadConfig({ ...real, HOSTNAME: "::1" }).auth.mode).toBe("dev");
    });

    it("DEV_ALLOW_WRITE は dev のときだけ効く", () => {
      expect(loadConfig({ ...base, DEV_ALLOW_WRITE: "true" }).auth.devAllowWrite).toBe(true);
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
