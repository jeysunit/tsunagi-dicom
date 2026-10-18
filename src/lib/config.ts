import { readFileSync } from "node:fs";
import { z } from "zod";
import { isValidUsername, USERNAME_HINT } from "@/lib/auth/username";

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
    mfaRequired: boolean;
    loginLockThreshold: number;
    loginLockMinutes: number;
    screenLockMinutes: number;
    /** 画面のロックを解くときに TOTP も求めるか（既定 false：パスワードだけ。docs/spec.md の 3.6） */
    screenUnlockRequireTotp: boolean;
    /** ログインの試みを遅らせ始める回数（1 分あたり）。利用者名ごと・全体 */
    rateLimitPerUserPerMinute: number;
    rateLimitGlobalPerMinute: number;
    /** パスワードのハッシュ（argon2id）をログインの枠で同時に回す数と、待たせる数（src/lib/auth/hash-limiter.ts） */
    passwordHashConcurrency: number;
    passwordHashQueue: number;
    /** ログインの途中のセッションの長さ（分）・ログインしたセッションの長さ（時間）・再認証が効く時間（分） */
    pendingSessionMinutes: number;
    sessionMaxHours: number;
    reauthMinutes: number;
    oidc: { issuer?: string; clientId?: string; clientSecret?: string };
    /**
     * 最初の管理者（AUTH_MODE=local で利用者が1人もいないときだけ使う。src/lib/auth/bootstrap.ts）。
     * パスワードはファイルで受け、ここにはファイルの場所だけを持つ（中身は使う時に読む）
     */
    initialAdmin?: { username: string; passwordFile: string };
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

const SESSION_SECRET_HINT = "32 バイト以上の乱数を入れる（例：openssl rand -base64 48）。ファイルで渡すときは SESSION_SECRET_FILE";
const SESSION_SECRET_MIN_BYTES = 32;

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"], { error: "true か false にする" })
    .default(fallback ? "true" : "false")
    .transform((v) => v === "true");

const int = (fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .default(String(fallback))
    .refine(
      (v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max,
      max === Number.MAX_SAFE_INTEGER ? `${min} 以上の整数にする` : `${min}〜${max} の整数にする`,
    )
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
  SCREEN_UNLOCK_REQUIRE_TOTP: bool(false),
  LOGIN_RATE_LIMIT_PER_MINUTE: int(10, 1),
  LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE: int(300, 1),
  // libuv のスレッドの溜め（既定 4 本）を、ログインした人の枠の1本とほかの仕事のために残す
  PASSWORD_HASH_CONCURRENCY: int(2, 1, 8),
  PASSWORD_HASH_QUEUE: int(32, 0, 1024),
  // セッションの長さ（既定の値。2026-10-18 に承認者が決めた。運用に合わせて変える）
  LOGIN_PENDING_MINUTES: int(10, 1, 60),
  SESSION_MAX_HOURS: int(12, 1, 24),
  REAUTH_MINUTES: int(5, 1, 60),
  OIDC_ISSUER: httpUrl.optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_CLIENT_SECRET_FILE: z.string().optional(),
  DEV_ALLOW_WRITE: bool(false),
  INITIAL_ADMIN_USERNAME: z.string().optional(),
  INITIAL_ADMIN_PASSWORD_FILE: z.string().optional(),
  DATABASE_URL: z
    .string()
    .default("file:/data/tsunagi.db")
    .refine((v) => v.startsWith("file:"), "SQLite の file: で始まる値にする（PostgreSQL への切り替えは後の段）"),
  // 無いとき（SESSION_SECRET_FILE も無いとき）の誤りは loadConfig で出す
  SESSION_SECRET: z
    .string()
    .refine((v) => Buffer.byteLength(v, "utf8") >= SESSION_SECRET_MIN_BYTES, "32 バイト以上の乱数にする")
    .optional(),
  SESSION_SECRET_FILE: z.string().optional(),
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

  // SESSION_SECRET はファイルでも渡せるので、どちらも無いことは型の確かめの外で見る（型の誤りと一緒に並べる）
  const sessionSecretMissing: ConfigProblem[] =
    raw.SESSION_SECRET === undefined && raw.SESSION_SECRET_FILE === undefined
      ? [{ variable: "SESSION_SECRET", message: `必須。${SESSION_SECRET_HINT}` }]
      : [];

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => ({
      variable: String(issue.path[0] ?? "(不明)"),
      message: raw[String(issue.path[0])] === undefined ? `必須。${issue.message}` : issue.message,
    }));
    throw new ConfigError(dedupe([...problems, ...sessionSecretMissing]));
  }
  const e = parsed.data;
  const problems: ConfigProblem[] = [...sessionSecretMissing];
  const problem = (variable: string, message: string) => problems.push({ variable, message });

  /** 秘密を値か `<名前>_FILE` のファイルで受ける。両方は誤り。ファイルの末尾の改行は落とす */
  const secret = (name: string, value: string | undefined, file: string | undefined): string | undefined => {
    if (value !== undefined && file !== undefined) {
      problem(`${name}_FILE`, `${name} と同時には使えない。どちらか1つにする`);
      return undefined;
    }
    if (file === undefined) return value;
    try {
      const fromFile = readFile(file).replace(/\r?\n$/, "");
      if (fromFile === "") problem(`${name}_FILE`, "ファイルが空");
      return fromFile === "" ? undefined : fromFile;
    } catch {
      problem(`${name}_FILE`, "ファイルを読めない");
      return undefined;
    }
  };

  const sessionSecret = secret("SESSION_SECRET", e.SESSION_SECRET, e.SESSION_SECRET_FILE);
  if (
    e.SESSION_SECRET_FILE !== undefined &&
    sessionSecret !== undefined &&
    Buffer.byteLength(sessionSecret, "utf8") < SESSION_SECRET_MIN_BYTES
  ) {
    problem("SESSION_SECRET_FILE", "32 バイト以上の乱数にする");
  }
  const oidcClientSecret = secret("OIDC_CLIENT_SECRET", e.OIDC_CLIENT_SECRET, e.OIDC_CLIENT_SECRET_FILE);

  if (e.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    problem("NODE_TLS_REJECT_UNAUTHORIZED", "証明書の確かめを切る設定は使えない。自前の CA は BACKEND_CA_FILE で渡す");
  }

  if (!e.BACKEND_MOCK) {
    if (!e.BACKEND_DICOMWEB_URL) problem("BACKEND_DICOMWEB_URL", "必須（BACKEND_MOCK=true のときだけ省ける）");
    if (e.BACKEND_KIND === "orthanc" && !e.BACKEND_ORTHANC_URL) {
      problem("BACKEND_ORTHANC_URL", "BACKEND_KIND=orthanc のときは必須");
    }
  }

  const bothPasswords = e.BACKEND_PASSWORD !== undefined && e.BACKEND_PASSWORD_FILE !== undefined;
  const password = secret("BACKEND_PASSWORD", e.BACKEND_PASSWORD, e.BACKEND_PASSWORD_FILE);
  const passwordFileFailed = e.BACKEND_PASSWORD_FILE !== undefined && password === undefined;
  if (e.BACKEND_USERNAME && !password && !bothPasswords && !passwordFileFailed) {
    problem("BACKEND_PASSWORD", "BACKEND_USERNAME があるときは BACKEND_PASSWORD か BACKEND_PASSWORD_FILE が必須");
  }
  if (!e.BACKEND_USERNAME && (password || bothPasswords)) {
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

  if (e.AUTH_MODE === "oidc") {
    problem("AUTH_MODE", "oidc はまだ無い（段 4 で作る）。いまは local（アプリの利用者）と開発用の dev（モックだけ）が動く");
  } else if (e.AUTH_MODE === "dev" && !e.BACKEND_MOCK) {
    // 段 1a〜1b の決まり（docs/spec.md の 4）。実の画像サーバーには local を使う
    problem("AUTH_MODE", "dev は BACKEND_MOCK=true のときだけ起動する。実の画像サーバーには local を使う");
  }

  let initialAdmin: { username: string; passwordFile: string } | undefined;
  if (e.INITIAL_ADMIN_USERNAME !== undefined || e.INITIAL_ADMIN_PASSWORD_FILE !== undefined) {
    if (e.AUTH_MODE !== "local") {
      problem("INITIAL_ADMIN_USERNAME", "AUTH_MODE=local のときだけ使える");
    } else if (e.INITIAL_ADMIN_USERNAME === undefined) {
      problem("INITIAL_ADMIN_USERNAME", "INITIAL_ADMIN_PASSWORD_FILE があるときは必須");
    } else if (e.INITIAL_ADMIN_PASSWORD_FILE === undefined) {
      problem("INITIAL_ADMIN_PASSWORD_FILE", "INITIAL_ADMIN_USERNAME があるときは必須（パスワードはファイルで渡す）");
    } else if (!isValidUsername(e.INITIAL_ADMIN_USERNAME)) {
      problem("INITIAL_ADMIN_USERNAME", USERNAME_HINT);
    } else {
      initialAdmin = { username: e.INITIAL_ADMIN_USERNAME, passwordFile: e.INITIAL_ADMIN_PASSWORD_FILE };
    }
  }

  if (e.DEV_ALLOW_WRITE) {
    // 書き込みの道（中継の STOW-RS など）は段 4 まで作らない（docs/spec.md の 3.2・4）
    problem("DEV_ALLOW_WRITE", "書き込みの道は段 4 まで無い（中継は WADO-RS の読み取りだけ）。true は段 4 から使える");
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
      mfaRequired: e.MFA_REQUIRED,
      loginLockThreshold: e.LOGIN_LOCK_THRESHOLD,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
      screenLockMinutes: e.SCREEN_LOCK_MINUTES,
      screenUnlockRequireTotp: e.SCREEN_UNLOCK_REQUIRE_TOTP,
      rateLimitPerUserPerMinute: e.LOGIN_RATE_LIMIT_PER_MINUTE,
      rateLimitGlobalPerMinute: e.LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE,
      passwordHashConcurrency: e.PASSWORD_HASH_CONCURRENCY,
      passwordHashQueue: e.PASSWORD_HASH_QUEUE,
      pendingSessionMinutes: e.LOGIN_PENDING_MINUTES,
      sessionMaxHours: e.SESSION_MAX_HOURS,
      reauthMinutes: e.REAUTH_MINUTES,
      oidc: { issuer: e.OIDC_ISSUER, clientId: e.OIDC_CLIENT_ID, clientSecret: oidcClientSecret },
      initialAdmin,
    },
    databaseUrl: e.DATABASE_URL,
    // 無いときは上で problem にして投げている
    sessionSecret: sessionSecret!,
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
