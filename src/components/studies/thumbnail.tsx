"use client";

import { ImageOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// 代表のサムネイル。BFF の中継（WADO-RS の thumbnail）から取る。取れなければ印だけを出す。
// UID は呼ぶ側で形を確かめたもの（数字と `.`）だけを使う（src/lib/backend/relay-path.ts と同じ形）。
const UID = /^[0-9]+(\.[0-9]+)*$/;

export function Thumbnail({
  studyUid,
  seriesUid,
  size = 48,
  className,
}: {
  studyUid: string;
  seriesUid?: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // サーバーの側で描いた img は、画面が動き出す前に読み込みに失敗していることがある（onError を取りこぼす）
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);
  const ok = UID.test(studyUid) && (seriesUid === undefined || UID.test(seriesUid));
  const src = `/api/dicom-web/studies/${studyUid}${seriesUid ? `/series/${seriesUid}` : ""}/thumbnail`;
  return (
    <span
      data-theme="dark"
      className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded bg-background", className)}
      style={{ width: size, height: size }}
    >
      {ok && !failed ? (
        // 中継の画像（認可と監査は BFF）。next/image の最適化は通さない
        <img
          ref={img}
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          data-testid="thumbnail"
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageOff aria-hidden className="size-4 text-label" data-testid="thumbnail-missing" />
      )}
    </span>
  );
}
