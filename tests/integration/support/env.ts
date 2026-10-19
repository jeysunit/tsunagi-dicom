import path from "node:path";

// 結合の試験の値。資格情報は tests/integration/run.mjs が試験のたびに乱数で作り、環境の変数で渡す（リポジトリに置かない）。
// run.mjs を通さずに流したときは、足りない変数を並べて止める。

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} が無い。結合の試験は node tests/integration/run.mjs から流す`);
  return value;
}

export const ITEST = {
  /** BFF（tsunagi-dicom）の待ち受け */
  bffPort: 3104,
  /** Orthanc の HTTP（compose が手元に出すポート） */
  orthancPort: Number(process.env.ITEST_ORTHANC_HTTP_PORT ?? "18042"),
  /** BFF と Orthanc の REST の間の入口（tests/integration/support/gate.ts。応答が失われたときの試験に使う） */
  gatePort: 18043,
  composeFile: path.resolve("docker/test/compose.yaml"),
  /** 試験が書く dump の置き場（.e2e は .gitignore） */
  workDir: path.resolve(".e2e/itest"),
  /** Orthanc に登録した送り先（docker/test/orthanc/orthanc.json） */
  scp: { id: "itest-scp", aet: "ITEST_SCP", host: "storescp", port: 11112 },
  /** 試験の画像を Orthanc へ送る側の AE タイトル */
  scuAet: "ITEST_SCU",
  orthancAet: "ORTHANC",
} as const;

export const bffUrl = `http://127.0.0.1:${ITEST.bffPort}`;
export const orthancUrl = `http://127.0.0.1:${ITEST.orthancPort}`;
export const gateUrl = `http://127.0.0.1:${ITEST.gatePort}`;

/** Orthanc の利用者（試験だけの値） */
export const orthancUser = () => ({ username: required("ITEST_ORTHANC_USERNAME"), password: required("ITEST_ORTHANC_PASSWORD") });

/** tsunagi-dicom の最初の管理者（試験だけの値。最初のログインで changed に変える） */
export const adminUser = () => ({
  username: "itest-admin",
  initial: required("ITEST_ADMIN_INITIAL_PASSWORD"),
  changed: required("ITEST_ADMIN_PASSWORD"),
});
