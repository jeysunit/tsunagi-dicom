import type { StudyView } from "@/lib/fields";
import { normalizeForSearch } from "@/lib/study-filter";

// 検査の一覧の列見出しでの並べ替え（docs/spec.md の 3.1）。
// 並べ替えるのは、画像サーバーから読んだ検査（上限 1000 件。STUDY_LIMIT）の中だけ。画像サーバーへは並びを求めない。
// 値の無い行（許可の一覧に載っていない項目を含む）は、昇順でも降順でも最後に置く。同じ値の行は、読んだ順（検査日の新しい順）のまま。

export const SORT_KEYS = ["date", "id", "accession", "name", "kana", "birth", "sex", "desc"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = "asc" | "desc";
export interface StudySort {
  key: SortKey;
  dir: SortDir;
}

/** 読み込み直後の並び：検査日時の新しい順（画像サーバーから読んだ順） */
export const DEFAULT_SORT: StudySort = { key: "date", dir: "desc" };

/** 列見出しを押したときの次の並び：別の列なら昇順、同じ列なら昇順と降順を入れ替える */
export function nextSort(current: StudySort, key: SortKey): StudySort {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

/** 読み込み直後の並びか（上限に届いたとき、読んだ範囲の中で並べ替えていることを添える要否の判定に使う） */
export const isDefaultSort = (sort: StudySort) => sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;

const collator = new Intl.Collator("ja", { numeric: true });

/**
 * 並べ替えの値。文字は全角半角・大文字小文字・かなをそろえる。氏名は、かなの氏名があればそれ（五十音順）、無ければ氏名。
 * 年齢の並べ替えは持たない（年齢は生年月日の列の中にある）。生年月日の列の逆向きが年齢の並びになる（昇順は年齢の降順）。読めない値は空（最後に置く）
 */
function sortValue(view: StudyView, key: SortKey): string {
  switch (key) {
    case "date":
      return view.studyDate ? `${view.studyDate}${(view.studyTime ?? "").padEnd(6, "0")}` : "";
    case "id":
      return normalizeForSearch(view.patientId ?? "");
    case "accession":
      return normalizeForSearch(view.accessionNumber ?? "");
    case "name":
      return normalizeForSearch(view.patientKana || view.patientName || "");
    case "kana":
      return normalizeForSearch(view.patientKana ?? "");
    case "birth":
      return view.patientBirthDate ?? "";
    case "sex":
      return normalizeForSearch(view.patientSex ?? "");
    case "desc":
      return normalizeForSearch([view.modalities?.join(" "), view.studyDescription].filter(Boolean).join(" "));
  }
}

/** 並べ替えた新しい配列を返す（同じ値の行は、渡された順のまま） */
export function sortStudies(studies: readonly StudyView[], sort: StudySort): StudyView[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const keyed = studies.map((view, index) => ({ view, index, value: sortValue(view, sort.key) }));
  keyed.sort((a, b) => {
    if (a.value === "" || b.value === "") {
      if (a.value === b.value) return a.index - b.index;
      return a.value === "" ? 1 : -1;
    }
    return sign * collator.compare(a.value, b.value) || a.index - b.index;
  });
  return keyed.map((k) => k.view);
}
