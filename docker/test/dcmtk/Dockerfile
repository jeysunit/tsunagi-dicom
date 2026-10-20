# 結合の試験だけで使う DCMTK のイメージ（tests/integration）。配布しない。
#
# DCMTK を作っている側が出す公式のイメージは無いので、Debian の公式のイメージ（版と digest を固定）に、
# Debian の署名つきの包み（dcmtk）を入れて作る。知らない人が作ったイメージより、中身の出どころを辿りやすい。
# - 土台：debian:trixie-20260918-slim（multi-arch の digest で固定。Dependabot が更新の PR を出す）
# - DCMTK：3.6.9（Debian 13 の版。Debian の安全の直し（+deb13uN）は受ける）
#   包みの版を完全に固定すると、Debian の直しが出た時点で古い版が配られなくなり作れなくなるので、上流の版（3.6.9）までを固定する。
#   入った版は作るときの記録に出す（dpkg-query の行）。
FROM debian:trixie-20260918-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update \
  && apt-get install -y --no-install-recommends 'dcmtk=3.6.9-*' \
  && rm -rf /var/lib/apt/lists/* \
  && dpkg-query -W dcmtk \
  && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin itest \
  && mkdir /received \
  && chown itest /received

COPY send-dumps.sh /usr/local/bin/send-dumps
RUN chmod 0755 /usr/local/bin/send-dumps

USER 10001
WORKDIR /tmp
