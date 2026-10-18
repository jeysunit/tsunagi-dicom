// 監査の記録の接続元（docs/spec.md の 3.6）。
// X-Forwarded-For・X-Real-IP は、ブラウザ（か途中の誰か）が自由に書けるヘッダーで、
// 信じてよいのは「施設のリバースプロキシが付け直した値」だけ。それを決める設定（信じるプロキシの一覧）はまだ無い。
// そのため、確かめた接続元（sourceAddress）は空にし、ヘッダーの値は「確かめていない接続元」の欄に分けて残す。
// Next.js の route handler からは、つないできた相手の住所（ソケットの住所）を読めない。

const MAX_LENGTH = 256;

export interface SourceAddress {
  /** 確かめた接続元。信じるプロキシの設定ができるまでは、いつも null */
  sourceAddress: string | null;
  /** ヘッダーにあった接続元（X-Forwarded-For の全体、無ければ X-Real-IP）。偽れる */
  sourceAddressUnverified: string | null;
}

/** 要求のヘッダーから接続元を分ける */
export function sourceFromHeaders(headers: Pick<Headers, "get">): SourceAddress {
  const raw = headers.get("x-forwarded-for") ?? headers.get("x-real-ip");
  // 制御文字を落とし、長さを切る（記録の欄をあふれさせない）
  // eslint-disable-next-line no-control-regex
  const cleaned = raw?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_LENGTH);
  return { sourceAddress: null, sourceAddressUnverified: cleaned ? cleaned : null };
}
