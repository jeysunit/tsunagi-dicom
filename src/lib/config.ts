import { readFileSync } from "node:fs";
import { z } from "zod";

// 設定の読み込み（docs/spec.md の 2.1。正本は .env.example）。
// 足りない・誤った値があれば、どの変数かを並べて ConfigError を投げる。値そのものは文言に出さない（秘密を漏らさない）。

export type BackendKind = "orthanc" | "dicomweb";
export type AuthMode = "local" | "oidc" | "dev";

export interface AppConfig {
  backend: {
    kind: BackendKind;
    mock: boolean;
    dicomwebUrl?: string;
    orthancUrl?: string;
    username?: string;
    password?: string;
    /** BACKEND_CA_FILE の中身（PEM）。無ければ Node の既定の CA だけを使う */
    caPem?: string;
  };
  viewers: {
    ohifUrl?: string;
    stoneUrl?: string;
    volviewUrl?: string;
    weasisEnabled: boolean;
    publicDicomwebUrl?: string;
  };
  auth: {
    mode: AuthMode;
    devAllowWrite: boolean;
    mfaRequired: boolean;
    loginLockThreshold: number;
    loginLockMinutes: number;
    screenLockMinutes: number;
    oidc: { issuer?: string; clientId?: string; clientSecret?: string };
  };
  databaseUrl: string;
  sessionSecret: string;
  timeZone: string;
}

export interface ConfigProblem {
  variable: string;
  message: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: ConfigProblem[]) {
    super(
      ["設定に誤りがあるため起動しない（.env.example と docs/spec.md の 2.1 を見る）:"]
        .concat(problems.map((p) => `  - ${p.variable}: ${p.message}`))
        .join("\n"),
    );
    this.name = "ConfigError";
  }
}

/** 待ち受けの住所がこれらなら「接続元が手元だけ」とみなす（docs/spec.md の 4） */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"], { error: "true か false にする" })
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true");

const int = (fallback: number, min: number) =>
  z
    .string()
    .default(String(fallback))
    .refine((v) => /^\d+$/.test(v) && Number(v) >= min, `${min} 以上の整数にする`)
    .transform(Number);

const httpUrl = z.url({ protocol: /^https?$/, error: "http:// か https:// で始まる URL にする" });

const envSchema = z.object({
  BACKEND_KIND: z.enum(["orthanc", "dicomweb"], { error: "orthanc か dicomweb にする" }),
  BACKEND_DICOMWEB_URL: httpUrl.optional(),
  BACKEND_ORTHANC_URL: httpUrl.optional(),
  BACKEND_USERNAME: z.string().optional(),
  BACKEND_PASSWORD: z.string().optional(),
  BACKEND_PASSWORD_FILE: z.string().optional(),
  BACKEND_CA_FILE: z.string().optional(),
  BACKEND_MOCK: bool(false),
  VIEWER_OHIF_URL: httpUrl.optional(),
  VIEWER_STONE_URL: httpUrl.optional(),
  VIEWER_VOLVIEW_URL: httpUrl.optional(),
  VIEWER_WEASIS_ENABLED: bool(false),
  PUBLIC_DICOMWEB_URL: httpUrl.optional(),
  AUTH_MODE: z.enum(["local", "oidc", "dev"], { error: "local・oidc・dev のどれかにする" }).default("local"),
  MFA_REQUIRED: bool(true),
  LOGIN_LOCK_THRESHOLD: int(5, 1),
  LOGIN_LOCK_MINUTES: int(15, 1),
  SCREEN_LOCK_MINUTES: int(15, 0),
  OIDC_ISSUER: httpUrl.optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  DEV_ALLOW_WRITE: bool(false),
  DATABASE_URL: z
    .string()
    .default("file:/data/tsunagi.db")
    .refine((v) => v.startsWith("file:"), "SQLite の file: で始まる値にする（PostgreSQL への切り替えは後の段）"),
  SESSION_SECRET: z
    .string({ error: "32 バイト以上の乱数を入れる（例：openssl rand -base64 48）" })
    .refine((v) => Buffer.byteLength(v, "utf8") >= 32, "32 バイト以上の乱数にする"),
  TZ: z
    .string()
    .default("Asia/Tokyo")
    .refine((v) => {
      try {
        new Intl.DateTimeFormat("ja-JP", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "IANA の時間帯の名前にする（例：Asia/Tokyo）"),
  // Next.js の待ち受けの住所。AUTH_MODE=dev の起動の条件に使う
  HOSTNAME: z.string().optional(),
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
});

type Env = Record<string, string | undefined>;

export interface LoadConfigOptions {
  /** 試験で差し替える。既定は node:fs の readFileSync */
  readFile?: (path: string) => string;
}

export function loadConfig(env: Env = process.env, options: LoadConfigOptions = {}): AppConfig {
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  // .env.example の `VAR=""` は「設定しない」と同じに扱う
  const raw: Env = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key];
    raw[key] = value === undefined || value.trim() === "" ? undefined : value;
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({
      variable: String(issue.path[0] ?? "(不明)"),
      message: raw[String(issue.path[0])] === undefined ? `必須。${issue.message}` : issue.message,
    }));
    throw new ConfigError(dedupe(problems));
  }
  const e = parsed.data;
  const problems: ConfigProblem[] = [];
  const problem = (variable: string, message: string) => problems.push({ variable, message });

  if (e.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    problem("NODE_TLS_REJECT_UNAUTHORIZED", "証明書の確かめを切る設定は使えない。自前の CA は BACKEND_CA_FILE で渡す");
  }

  if (!e.BACKEND_MOCK) {
    if (!e.BACKEND_DICOMWEB_URL) problem("BACKEND_DICOMWEB_URL", "必須（BACKEND_MOCK=true のときだけ省ける）");
    if (e.BACKEND_KIND === "orthanc" && !e.BACKEND_ORTHANC_URL) {
      problem("BACKEND_ORTHANC_URL", "BACKEND_KIND=orthanc のときは必須");
    }
  }

  let password = e.BACKEND_PASSWORD;
  if (e.BACKEND_PASSWORD && e.BACKEND_PASSWORD_FILE) {
    problem("BACKEND_PASSWORD_FILE", "BACKEND_PASSWORD と同時には使えない。どちらか1つにする");
  } else if (e.BACKEND_PASSWORD_FILE) {
    try {
      password = readFile(e.BACKEND_PASSWORD_FILE).replace(/\r?\n$/, "");
      if (password === "") problem("BACKEND_PASSWORD_FILE", "ファイルが空");
    } catch {
      problem("BACKEND_PASSWORD_FILE", "ファイルを読めない");
    }
  }
  if (e.BACKEND_USERNAME && !password) {
    problem("BACKEND_PASSWORD", "BACKEND_USERNAME があるときは BACKEND_PASSWORD か BACKEND_PASSWORD_FILE が必須");
  }
  if (!e.BACKEND_USERNAME && password) {
    problem("BACKEND_USERNAME", "パスワードがあるときは必須");
  }

  let caPem: string | undefined;
  if (e.BACKEND_CA_FILE) {
    try {
      caPem = readFile(e.BACKEND_CA_FILE);
      if (!caPem.includes("-----BEGIN CERTIFICATE-----")) problem("BACKEND_CA_FILE", "PEM の証明書が入っていない");
    } catch {
      problem("BACKEND_CA_FILE", "ファイルを読めない");
    }
  }

  if (e.AUTH_MODE === "local") {
    problem("AUTH_MODE", "local はまだ無い（段 1b で作る）。いまは開発用の dev だけ動く");
  } else if (e.AUTH_MODE === "oidc") {
    problem("AUTH_MODE", "oidc はまだ無い（段 4 で作る）。いまは開発用の dev だけ動く");
  } else if (e.AUTH_MODE === "dev") {
    const loopbackOnly = e.HOSTNAME !== undefined && LOOPBACK_HOSTS.has(e.HOSTNAME);
    if (!e.BACKEND_MOCK && !loopbackOnly) {
      problem(
        "AUTH_MODE",
        "dev は BACKEND_MOCK=true か、待ち受けを手元だけ（HOSTNAME=127.0.0.1・::1・localhost）にしたときだけ起動する",
      );
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    backend: {
      kind: e.BACKEND_KIND,
      mock: e.BACKEND_MOCK,
      dicomwebUrl: e.BACKEND_DICOMWEB_URL,
      orthancUrl: e.BACKEND_ORTHANC_URL,
      username: e.BACKEND_USERNAME,
      password,
      caPem,
    },
    viewers: {
      ohifUrl: e.VIEWER_OHIF_URL,
      stoneUrl: e.VIEWER_STONE_URL,
      volviewUrl: e.VIEWER_VOLVIEW_URL,
      weasisEnabled: e.VIEWER_WEASIS_ENABLED,
      publicDicomwebUrl: e.PUBLIC_DICOMWEB_URL,
    },
    auth: {
      mode: e.AUTH_MODE,
      devAllowWrite: e.AUTH_MODE === "dev" && e.DEV_ALLOW_WRITE,
      mfaRequired: e.MFA_REQUIRED,
      loginLockThreshold: e.LOGIN_LOCK_THRESHOLD,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
      screenLockMinutes: e.SCREEN_LOCK_MINUTES,
      oidc: { issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID, clientSecret: e.OIDC_CLIENT_SECRET },
    },
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    timeZone: e.TZ,
  };
}

function dedupe(problems: ConfigProblem[]): ConfigProblem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.variable}\u0000${p.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

let cached: AppConfig | undefined;

/** process.env から一度だけ読む。起動の時の確かめは src/instrumentation.ts */
export function getConfig(): AppConfig {
  cached ??= loadConfig();
  return cached;
}
