import { readFileSync } from "node:fs";
import { z } from "zod";
import { isValidUsername, USERNAME_HINT } from "@/lib/auth/username";
import { parseInstanceTags } from "@/lib/instance-tags";

// 設定の読み込み（docs/spec.md の 2.1。正本は .env.example）。
// 足りない・誤った値があれば、どの変数かを並べて ConfigError を投げる。値そのものは文言に出さない（秘密を漏らさない）。

/** Orthanc 専用（docs/spec.md の 0）。汎用の DICOMweb（dicomweb）は段 3 で外した */
export type BackendKind = "orthanc";
export type AuthMode = "local" | "oidc" | "dev";

export interface AppConfig {
  backend: {
    kind: BackendKind;
    mock: boolean;
    dicomwebUrl?: string;
    orthancUrl?: string;
    username?: string;
    password?: string;
    /**
     * 書く資格情報（BACKEND_WRITE_USERNAME・BACKEND_WRITE_PASSWORD。段 4）。Orthanc への書き込みの操作（POST）に使う。
     * 無ければ読む資格情報で書く（試しの環境のため。患者の情報を置く環境では分けることが施設の必須。
     * docs/security-and-maintenance.md の 4.1）
     */
    writeUsername?: string;
    writePassword?: string;
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
    /** AUTH_MODE=dev（モックだけ）で、書き込みの操作も通すか（DEV_ALLOW_WRITE。既定は止める。docs/spec.md の 4） */
    devAllowWrite?: boolean;
  };
  /** 画面の振る舞い */
  screen: {
    /** 検査の一覧の自動更新の間隔（秒。0 で止める。docs/spec.md の 3.1） */
    studyListRefreshSeconds: number;
    /** 画像ごとの「主なタグ」に出すタグ（8 桁の大文字の 16 進。設定の順。INSTANCE_TAGS。docs/spec.md の 3.1） */
    instanceTags: string[];
    /** インポートで受ける 1 つのファイルの大きさの上限（MB。IMPORT_MAX_MB。docs/spec.md の 3.5） */
    importMaxMb: number;
  };
  /** 監査の記録（docs/adr/0001-audit-chain-mac.md） */
  audit: {
    /** 先頭の控えを追記するファイル（AUDIT_ANCHOR_FILE）。無ければコンテナのログ（標準出力）にだけ書く */
    anchorFile?: string;
    /** 前に使っていた SESSION_SECRET（SESSION_SECRET_PREVIOUS_FILE）。その鍵で書いた行を確かめるためだけに使う */
    sessionSecretPrevious: string[];
  };
  hl7ReceiverToken?: string;
  hl7PatientIdIssuer?: string;
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

/**
 * ビューアの根の URL。検査を開く道（OHIF の `/viewer`・Stone の `/index.html`）は src/lib/viewers.ts が足すので、根に書いた値は断る
 * （書くと `/ohif/viewer/viewer` を開いて 404 になる。docs/spec.md の 2.1 の表）
 */
const viewerRoot = (route: string) =>
  httpUrl.refine(
    (url) => {
      // URL でない値は httpUrl が誤りにする。zod はその後もここを呼ぶので、読めない値はここでは通す
      if (!URL.canParse(url)) return true;
      return !new URL(url).pathname.replace(/\/+$/, "").endsWith(route);
    },
    { error: `ビューアの根の URL にする（末尾の ${route} は付けない。開く時に足す）` },
  );

const envSchema = z.object({
  // 省ける（orthanc だけ）。前の設定の dicomweb は、黙って Orthanc として動かさずに断る
  HL7_RECEIVER_TOKEN_FILE: z.string().optional(),
  HL7_PATIENT_ID_ISSUER: z.string().optional(),
  BACKEND_KIND: z
    .enum(["orthanc"], { error: "orthanc だけにする（汎用の DICOMweb の dicomweb は外した）。省いてもよい" })
    .default("orthanc"),
  BACKEND_DICOMWEB_URL: httpUrl.optional(),
  BACKEND_ORTHANC_URL: httpUrl.optional(),
  BACKEND_USERNAME: z.string().optional(),
  BACKEND_PASSWORD: z.string().optional(),
  BACKEND_PASSWORD_FILE: z.string().optional(),
  BACKEND_WRITE_USERNAME: z.string().optional(),
  BACKEND_WRITE_PASSWORD: z.string().optional(),
  BACKEND_WRITE_PASSWORD_FILE: z.string().optional(),
  BACKEND_CA_FILE: z.string().optional(),
  BACKEND_MOCK: bool(false),
  VIEWER_OHIF_URL: viewerRoot("/viewer").optional(),
  VIEWER_STONE_URL: viewerRoot("/index.html").optional(),
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
  // 検査の一覧の自動更新（既定 30 秒。2026-10-21 に承認者が決めた）。0 で止める。画像サーバーへ問い合わせすぎないよう 5 秒より短くしない
  STUDY_LIST_REFRESH_SECONDS: int(30, 0, 3600).refine((v) => v === 0 || v >= 5, "0（止める）か 5〜3600 の整数にする"),
  // 画像ごとの「主なタグ」に出すタグの番号（空白で区切る）。空なら既定の一覧（src/lib/instance-tags.ts）。誤りは loadConfig で出す
  INSTANCE_TAGS: z.string().optional(),
  // インポートの 1 つのファイルの上限（MB。既定 256）。BFF はファイルを読み切ってから Orthanc へ渡すので、メモリに載る大きさにとどめる
  IMPORT_MAX_MB: int(256, 1, 1024),
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
  // 前に使っていた SESSION_SECRET（1 行に 1 つ）。監査の記録のうち、その鍵で書いた行を確かめるためだけに使う
  // （docs/adr/0001-audit-chain-mac.md）。セッションや token には使わない
  SESSION_SECRET_PREVIOUS_FILE: z.string().optional(),
  // 監査の記録の先頭（seq と hash）の控えを追記するファイル（JSON Lines）。データベースとは別の置き場にする
  AUDIT_ANCHOR_FILE: z
    .string()
    .refine((v) => v.startsWith("/"), "絶対のパスにする（例：/audit-anchors/audit-anchors.jsonl）")
    .optional(),
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

  // 片方だけの設定で、認証や発番元の確認を欠いた道を開かない（design.md §3・§6）。
  const hl7ReceiverToken = secret("HL7_RECEIVER_TOKEN", undefined, e.HL7_RECEIVER_TOKEN_FILE);
  if (hl7ReceiverToken !== undefined && [...hl7ReceiverToken].length < 32) {
    problem("HL7_RECEIVER_TOKEN_FILE", "32 文字以上の乱数にする");
  }
  const hl7PatientIdIssuer = e.HL7_PATIENT_ID_ISSUER?.trim();
  if (e.HL7_PATIENT_ID_ISSUER !== undefined && !hl7PatientIdIssuer) {
    problem("HL7_PATIENT_ID_ISSUER", "namespace ID は空にできない");
  }
  if (Boolean(e.HL7_RECEIVER_TOKEN_FILE) !== Boolean(hl7PatientIdIssuer)) {
    problem("HL7_PATIENT_ID_ISSUER", "token ファイルと発番元は両方を設定する");
  }
  if (hl7PatientIdIssuer && /[|^~\\&\s]/u.test(hl7PatientIdIssuer)) {
    problem("HL7_PATIENT_ID_ISSUER", "namespace ID を指定する");
  }
  const sessionSecret = secret("SESSION_SECRET", e.SESSION_SECRET, e.SESSION_SECRET_FILE);
  if (
    e.SESSION_SECRET_FILE !== undefined &&
    sessionSecret !== undefined &&
    Buffer.byteLength(sessionSecret, "utf8") < SESSION_SECRET_MIN_BYTES
  ) {
    problem("SESSION_SECRET_FILE", "32 バイト以上の乱数にする");
  }
  // 前の SESSION_SECRET（監査の記録の確かめだけに使う）。空の行は飛ばす。どれも 32 バイト以上
  let sessionSecretPrevious: string[] = [];
  if (e.SESSION_SECRET_PREVIOUS_FILE !== undefined) {
    try {
      sessionSecretPrevious = readFile(e.SESSION_SECRET_PREVIOUS_FILE)
        .split(/\r?\n/)
        .filter((line) => line !== "");
      if (sessionSecretPrevious.some((s) => Buffer.byteLength(s, "utf8") < SESSION_SECRET_MIN_BYTES)) {
        problem("SESSION_SECRET_PREVIOUS_FILE", "どの行も 32 バイト以上にする（前に使っていた SESSION_SECRET を 1 行に 1 つ）");
      }
    } catch {
      problem("SESSION_SECRET_PREVIOUS_FILE", "ファイルを読めない");
    }
  }
  const oidcClientSecret = secret("OIDC_CLIENT_SECRET", e.OIDC_CLIENT_SECRET, e.OIDC_CLIENT_SECRET_FILE);

  if (e.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    problem("NODE_TLS_REJECT_UNAUTHORIZED", "証明書の確かめを切る設定は使えない。自前の CA は BACKEND_CA_FILE で渡す");
  }

  if (!e.BACKEND_MOCK) {
    if (!e.BACKEND_DICOMWEB_URL) problem("BACKEND_DICOMWEB_URL", "必須（Orthanc の DICOMweb のプラグインの URL。BACKEND_MOCK=true のときだけ省ける）");
    if (!e.BACKEND_ORTHANC_URL) problem("BACKEND_ORTHANC_URL", "必須（Orthanc の REST の URL。BACKEND_MOCK=true のときだけ省ける）");
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

  // 書く資格情報（段 4。docs/security-and-maintenance.md の 4.1）。名前とパスワードは組で渡す
  const bothWritePasswords = e.BACKEND_WRITE_PASSWORD !== undefined && e.BACKEND_WRITE_PASSWORD_FILE !== undefined;
  const writePassword = secret("BACKEND_WRITE_PASSWORD", e.BACKEND_WRITE_PASSWORD, e.BACKEND_WRITE_PASSWORD_FILE);
  const writePasswordFileFailed = e.BACKEND_WRITE_PASSWORD_FILE !== undefined && writePassword === undefined;
  if (e.BACKEND_WRITE_USERNAME && !writePassword && !bothWritePasswords && !writePasswordFileFailed) {
    problem("BACKEND_WRITE_PASSWORD", "BACKEND_WRITE_USERNAME があるときは BACKEND_WRITE_PASSWORD か BACKEND_WRITE_PASSWORD_FILE が必須");
  }
  if (!e.BACKEND_WRITE_USERNAME && (writePassword || bothWritePasswords)) {
    problem("BACKEND_WRITE_USERNAME", "書く資格情報のパスワードがあるときは必須");
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

  const instanceTags = parseInstanceTags(e.INSTANCE_TAGS);
  if (!instanceTags.ok) problem("INSTANCE_TAGS", instanceTags.message);

  if (e.DEV_ALLOW_WRITE && e.AUTH_MODE !== "dev") {
    // 検証モード（モックだけ）のときだけ効く。ほかで書いても書き込みが通るように見えないよう、誤りにする
    problem("DEV_ALLOW_WRITE", "AUTH_MODE=dev のときだけ使える（ほかの認証では役割の割り当てで書き込みを決める）");
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
      writeUsername: e.BACKEND_WRITE_USERNAME,
      writePassword,
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
      devAllowWrite: e.DEV_ALLOW_WRITE,
    },
    // 誤りは上で problem にして投げている
    screen: {
      studyListRefreshSeconds: e.STUDY_LIST_REFRESH_SECONDS,
      instanceTags: instanceTags.ok ? instanceTags.tags : [],
      importMaxMb: e.IMPORT_MAX_MB,
    },
    audit: { anchorFile: e.AUDIT_ANCHOR_FILE, sessionSecretPrevious },
    hl7ReceiverToken,
    hl7PatientIdIssuer,
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
