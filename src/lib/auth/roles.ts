// 役割と、役割ごとにできる操作（docs/spec.md の 3.6、第7.0版 14.2）。
// 役割は管理者と一般の2つ（2026-10-20 に承認者が決めた。それまでは管理者・医師・技師・閲覧の4つ）。
// 一般は普段使う機能の全部、管理者は一般の全部に加えて、削除・ユーザー管理・システムの設定（接続先の住所・ビューア設定など）。
// 閲覧だけの役割は作らない。これまでの医師・技師・閲覧の利用者は、migration 20261020100000_two_roles で一般に移した。
// 操作は、この段までに道がある操作だけを並べる。後の段で道を足すときは、ここに操作を足して割り当て、試験を付ける。
// 割り当てに無い操作は「できない」側に倒れる。AUTH_MODE=dev の検証モードで選んだ役割にも、同じ割り当てを当てる。
export const ROLES = ["admin", "general"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "管理者",
  general: "一般",
};

/** 検証モードで役割を選んでいないとき（前の役割の名前を覚えた cookie を含む）は、狭いほうの「一般」にする */
export const DEFAULT_DEV_ROLE: Role = "general";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export const PERMISSIONS = [
  // 検査の検索（画面の API・検査の一覧の頁）
  "study.search",
  // ビューアが画像を取る道（BFF の中継の WADO-RS の読み取り）
  "image.retrieve",
  // すべての DICOM の値を見る（docs/spec.md 原則 8。詳細のパネルの「DICOM タグ」）
  "dicom.all_values",
  // 監査の記録のつなぎの確かめ（/api/audit/verify）
  "audit.verify",
  // 利用者の管理（一覧・作る・役割・止める・TOTP のやり直し・一時停止の解除）
  "user.manage",
  // 段 2：検査ごとの既定のビューアを覚える（ほかの利用者にも効く。BFF のデータベースだけを変える）。
  // 段 2 の検査の状態の印の操作（検像・読影の状態・緊急の印・ブックマーク）は段 3 で外した
  "viewer.remember",
  // モダリティごとの既定のビューアを変える（ビューア設定。システムの設定）
  "viewer.defaults",
  // 段 4（docs/spec.md の 3.3・3.4）
  // 受け取りの記録を見る（受信一覧。Orthanc の変更の記録から読む）
  "receive.view",
  // 機器の一覧（名前と AE タイトル。住所は許可の一覧の modality で絞る）と、つながるかの確かめ（C-ECHO）
  "modality.check",
  // 上の帯の接続の状態を見る（画像サーバー・HL7 の受け口・接続先の直近の接続確認。読むだけで、相手に何も送らない）
  "connection.view",
  // ほかの機器へ送る（書き込みの操作。docs/spec.md の 3.5 の共通の決まりを通す）
  "study.send",
  // 送った記録を見る（送信一覧。監査の記録の送信の行と Orthanc の仕事から読む。読むだけ。docs/spec.md の 3.4）
  "send.view",
  // 結果の分からない書き込みの操作を、管理者が確かめて記録に足す（照らし合わせ。docs/spec.md の 3.5）
  "pacs.reconcile",
  // 段 5：書き出し（ZIP。患者の情報を含んだまま持ち出せる形になる）
  "study.export",
  // 削除（管理者だけ。理由を必須・再認証の後）
  "study.delete",
  // 段 6：患者・検査の値の修正（一般と管理者。理由を必須・再認証の後。docs/spec.md の 3.5）
  "study.modify",
  // 段 6：インポート（DICOM のファイルを Orthanc へ入れる。一般と管理者。docs/spec.md の 3.5）
  "study.import",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export type PermissionMap = Record<Role, readonly Permission[]>;

/** 一般の操作：普段使う機能の全部（docs/spec.md の 3.6 の表） */
const GENERAL: readonly Permission[] = [
  "study.search",
  "image.retrieve",
  "dicom.all_values",
  "viewer.remember",
  "receive.view",
  // 送信一覧は受信一覧と表裏の画面なので、受信一覧と同じく一般にも許す（送信は一般の操作。ほかの利用者の送信も、
  // 同じ検査を重ねて送らないために見えるほうがよい。返す項目は許可の一覧の sent・study で絞り、開いたことを記録する）
  "send.view",
  "modality.check",
  "connection.view",
  "study.send",
  "study.export",
  "study.modify",
  "study.import",
];

export const ROLE_PERMISSIONS: PermissionMap = {
  // 管理者：一般の全部に加えて、削除・ユーザー管理・システムの設定・照らし合わせ・監査の確かめ
  admin: [...GENERAL, "audit.verify", "user.manage", "viewer.defaults", "pacs.reconcile", "study.delete"],
  general: GENERAL,
};

export function can(role: Role, permission: Permission, map: PermissionMap = ROLE_PERMISSIONS): boolean {
  return map[role]?.includes(permission) ?? false;
}
