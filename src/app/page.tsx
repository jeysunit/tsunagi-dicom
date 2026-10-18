import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pageAccess } from "@/lib/auth/page-session";
import { audit } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { formatBirthLine, formatDicomTime, formatSlashDate } from "@/lib/format/japanese-date";
import { searchAuditFields } from "@/lib/search-audit";
import { listStudies, type StudyListResult } from "@/lib/study-list";

// BFF を通した検査の件数と、検査の一覧。項目は役割の許可の一覧で絞ったもの（src/lib/fields.ts）。
// 氏名は漢字とかなに分け、生年月日は和暦・検査日の時点の年齢・性別を添える（docs/spec.md の 3.1）。

export default async function HomePage() {
  const access = await pageAccess("study.search");
  // 画面のロック中は中身を描かない（ロックの画面は layout が出す）
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        この役割では検査の一覧を開けない
      </p>
    );
  }
  const { session } = access;
  const backend = getBackend();

  let result: StudyListResult;
  try {
    result = await listStudies(backend, session.role);
  } catch (error) {
    const message = error instanceof BackendError ? error.message : "検査を読めなかった";
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <p role="alert" className="text-label">
        {message}
      </p>
    );
  }
  await audit(session, searchAuditFields("page", result.returned));
  const { count, studies } = result;

  return (
    <section className="space-y-3">
      <h1 className="flex items-baseline gap-3">
        <span className="text-label">検査</span>
        <span className="text-lg font-bold text-value" data-testid="study-count">
          {count.count}
          {count.exact ? "" : " 以上"}
        </span>
        <span className="text-label">件</span>
        {backend.mock && <span className="text-xs text-label">（モックのバックエンド）</span>}
      </h1>

      <Table data-testid="study-table">
        <TableCaption>新しい検査から {studies.length} 件</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>検査日</TableHead>
            <TableHead>患者 ID</TableHead>
            <TableHead>氏名</TableHead>
            <TableHead>生年月日</TableHead>
            <TableHead>モダリティ</TableHead>
            <TableHead>検査の記述</TableHead>
            <TableHead>受付番号</TableHead>
            <TableHead className="text-right">シリーズ</TableHead>
            <TableHead className="text-right">画像</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {studies.map((s) => (
            <TableRow key={s.studyInstanceUid} data-study-uid={s.studyInstanceUid}>
              <TableCell className="whitespace-nowrap">
                {formatSlashDate(s.studyDate)} {formatDicomTime(s.studyTime)}
              </TableCell>
              <TableCell className="font-mono">{s.patientId}</TableCell>
              <TableCell>
                {s.patientName ? (
                  <span className="block font-bold text-value" data-testid="patient-name">
                    {s.patientName}
                  </span>
                ) : (
                  <span className="block text-label">（氏名なし）</span>
                )}
                {s.patientKana && <span className="block text-xs text-label">{s.patientKana}</span>}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {formatBirthLine(s.patientBirthDate, s.patientSex, s.studyDate)}
              </TableCell>
              <TableCell>{s.modalities?.join("・")}</TableCell>
              <TableCell>{s.studyDescription}</TableCell>
              <TableCell className="font-mono">{s.accessionNumber}</TableCell>
              <TableCell className="text-right">{s.seriesCount ?? ""}</TableCell>
              <TableCell className="text-right">{s.instanceCount ?? ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
