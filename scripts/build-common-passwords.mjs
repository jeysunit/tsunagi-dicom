// よくあるパスワードの一覧（src/lib/auth/common-passwords.json）を作り直す。
// 元は @zxcvbn-ts/language-common（MIT）の src/passwords.json。ライセンスは src/lib/auth/common-passwords.LICENSE.txt。
//
//   npm pack @zxcvbn-ts/language-common@4.1.3 --pack-destination <空のディレクトリ>
//   tar -xzf <そのディレクトリ>/zxcvbn-ts-language-common-4.1.3.tgz -C <別の空のディレクトリ>
//   node scripts/build-common-passwords.mjs <別の空のディレクトリ>/package/src/passwords.json
//
// パスワードの規則（src/lib/auth/password-policy.ts）のほかの決まり（8 文字以上・英字と数字の混在）を
// 満たすものだけを残す（ほかの決まりで断られるものは、一覧に入れても効かないため）。順は元の順（よく使われる順）。
import { readFileSync, writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("使い方：node scripts/build-common-passwords.mjs <passwords.json>");
  process.exit(1);
}

const words = JSON.parse(readFileSync(source, "utf8"));
if (!Array.isArray(words)) {
  console.error("passwords.json が配列でない");
  process.exit(1);
}

const seen = new Set();
const kept = [];
for (const word of words) {
  if (typeof word !== "string") continue;
  // 印字できる ASCII だけ
  if (!/^[\x20-\x7e]+$/.test(word)) continue;
  if (word.length < 8 || !/[A-Za-z]/.test(word) || !/[0-9]/.test(word)) continue;
  const lower = word.toLowerCase();
  if (seen.has(lower)) continue;
  seen.add(lower);
  kept.push(lower);
}

writeFileSync("src/lib/auth/common-passwords.json", JSON.stringify(kept) + "\n");
console.info(`${kept.length} 語を書いた（元 ${words.length} 語）`);
