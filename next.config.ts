import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 1つのコンテナにまとめる（docs/spec.md の 2）
  output: "standalone",
  poweredByHeader: false,
  // next dev が AGENTS.md に英語の決まりを書き足さないようにする（開発の決まりは AGENTS.md に1つだけ置く）
  agentRules: false,
  // モックのバックエンド（BACKEND_MOCK=true）が読む合成の見本を、standalone の出力に含める
  outputFileTracingIncludes: {
    "/**": ["./tests/fixtures/orthanc/**/*"],
  },
};

export default nextConfig;
