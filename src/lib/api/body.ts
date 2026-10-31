// 要求の本文を、決めた大きさまでだけ読む。大きすぎれば null（読みかけで止める）。
// content-length が無い（chunked の）要求でも、読んだ量で止める。

export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readLimitedBytes(request, maxBytes);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** 本文をバイトのまま読む（インポートの DICOM のファイル）。大きすぎれば null */
export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
