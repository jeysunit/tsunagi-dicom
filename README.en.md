# tsunagi-dicom

[日本語](README.md)

A standalone web front end and BFF (Backend For Frontend) that uses a DICOMweb-capable image server (such as Orthanc) **as an unmodified backend**, and provides a study list, a per-patient timeline, and viewer selection designed around how images are reviewed in Japanese medical institutions.

> **Not for Diagnostic Use / 非医療機器 (not a medical device).**
> This software is for research, education, and evaluation. It has not been approved or certified as a medical device.

## Status

> **Design stage — do not use in production (clinical settings or real patient data).** The specification and foundation are still being built.

**Stage 1b (2026-10-18).** On top of the stage 1a foundation (the BFF with a screen API for search and a relay limited to WADO-RS reads so that viewers can retrieve images, the audit trail, development authentication `AUTH_MODE=dev`, the common screen, and CI with container images), application user login (`AUTH_MODE=local`) is in place: users and roles (administrator, physician, technologist, read-only), password rules (stored as argon2id hashes), two-factor authentication (TOTP), temporary login lockout, screen lock, a user inventory page, per-role permissions, and role checks on the relay.
`AUTH_MODE=local` can also be used with a real image server (not yet verified against one). `AUTH_MODE=dev` still starts only with the mock backend (`BACKEND_MOCK=true`).
The pages are: login, the number of studies and a plain study list fetched through the BFF, user administration, and personal settings. The full study list comes in stage 2.
Implementation proceeds stage by stage; each PR covers one cohesive change within a single stage (see "6. 段階" in [`docs/spec.md`](docs/spec.md)).

The user interface will be Japanese only at first. The documents are written mainly in Japanese.

## What it does

- **Study list**: quick filters by study date, modality, and status (the Japanese terms used in clinical practice: 未検像, 検像済, 未読, 既読, 緊急, bookmark). Patient names are shown split into the ideographic (kanji) name and the phonetic (kana) name; birth dates are shown with the Japanese era and age.
- **Viewer selection**: open a study in one of the configured viewers (OHIF Viewer, Stone Web Viewer, VolView, ...). Defaults can be remembered per study and per modality.
- **Per-patient timeline**, and side-by-side comparison of two studies.
- **Simple reports (簡易レポート)** (stage 3). Document import and display (PDF, etc.) and importing, correcting, splitting, and merging other institutions' data are heavier, so they were moved later (after stage 4).
- **Security and operations**: roles, two-factor authentication, audit trail, and so on (image-server monitoring and the read-only switch come after stage 4). [`docs/guideline-mapping.md`](docs/guideline-mapping.md) maps these features to the items of the Japanese Ministry of Health, Labour and Welfare guideline (version 7.0, System Operations volume). **Whether a deployment meets the guideline is for each institution to determine, including its operations; this software alone does not make a deployment compliant.**

**Example uses**: as an everyday viewing front end in front of a hospital or lab image server; and in front of a research image archive for clinical studies, where readers must not see the original patient information (a blind-reading role, planned for stage 2b).

This tool is for clinical trials, research, and system testing, and **features are cut rather than added**.

The image server and viewers are not modified. Every endpoint is configured through environment variables. Search and retrieval use DICOMweb first; Orthanc-only features are kept in separate components that are enabled only with an Orthanc backend.

## Trying it out (mock backend)

Without an image server, run it against the mock backend (synthetic samples in `tests/fixtures/orthanc`) and development authentication (`AUTH_MODE=dev`; writes are blocked):

```sh
mkdir -p secrets && openssl rand -base64 48 > secrets/session_secret.txt   # passed as SESSION_SECRET_FILE (secrets/ is not committed)
BACKEND_MOCK=true AUTH_MODE=dev docker compose up --build
# open http://127.0.0.1:3000/
```

For local development (Node version in `.nvmrc`; npm 11 `allowScripts` is enforced by `strict-allow-scripts` in `.npmrc`):

```sh
npm ci
cp .env.example .env   # set BACKEND_MOCK="true", AUTH_MODE="dev" and SESSION_SECRET (or SESSION_SECRET_FILE)
mkdir -p data && DATABASE_URL="file:./data/tsunagi.db" npm run db:migrate
DATABASE_URL="file:./data/tsunagi.db" npm run dev
```

To try application user login (`AUTH_MODE=local`): the first administrator is created at startup from a secret file, only while there are no users (see `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD_FILE` in `compose.yaml`). At the first login the administrator enrolls TOTP (when `MFA_REQUIRED=true`) and replaces the password. **Keep at least two administrators** (if the only administrator loses the authenticator app, there is no recovery path yet; see section 4 of `docs/security-and-maintenance.md`). The session cookie is `Secure`, so outside `127.0.0.1` / `localhost` put the application behind TLS (a reverse proxy).

```sh
printf '%s\n' '<initial password>' > secrets/initial_admin_password.txt   # at least 8 characters, letters and digits
# after enabling the INITIAL_ADMIN_* and initial_admin_password secret lines in compose.yaml
BACKEND_MOCK=true AUTH_MODE=local docker compose up --build
```

Tests: `npm run lint`, `npm run typecheck`, `npm test` (Vitest), `npm run build && npm run test:e2e` (Playwright, against the mock backend, with one `AUTH_MODE=dev` server and one `AUTH_MODE=local` server).

## Container image (GHCR)

For deployment, pin the GHCR image (`ghcr.io/jeysunit/tsunagi-dicom`) by version tag (`vX.Y.Z`) or digest (`TSUNAGI_IMAGE` in `compose.yaml`). Images are published only after CI passes (`.github/workflows/image.yml`).

| Tag | When it is set |
|---|---|
| `vX.Y.Z` | Only on a version tag push. **Never set by rebuilds and never deleted by cleanup.** If the version tag already exists in GHCR (for example when a run is re-run), the workflow stops without publishing |
| `sha-<short hash>` | On merges to `main`, version tags, and weekly rebuilds. Rebuilding the same commit moves it to the new image |
| `rebuild-YYYYMMDD` | Weekly (Monday 03:17 UTC) and manual rebuilds of `main` (UTC date). Picks up updates to the packages installed with apt inside the image |

**Verifying the signature.** Each published image digest carries a keyless cosign signature made with the GitHub Actions OIDC token. Before deploying, look up the digest and verify it:

```sh
docker buildx imagetools inspect ghcr.io/jeysunit/tsunagi-dicom:vX.Y.Z   # use the Digest it prints
cosign verify ghcr.io/jeysunit/tsunagi-dicom@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/jeysunit/tsunagi-dicom/\.github/workflows/image\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To accept only a release image, replace `--certificate-identity-regexp` with `--certificate-identity https://github.com/jeysunit/tsunagi-dicom/.github/workflows/image.yml@refs/tags/vX.Y.Z`, which also checks that the workflow run for that version signed it.

**Cleanup of old images** (`.github/workflows/image-cleanup.yml`, weekly, Monday 06:41 UTC):

- Kept: every image with a version tag (`v*`); the 10 newest images with other tags (`sha-*`, `rebuild-*`); every image published less than 2 days ago.
- Deleted: other tagged images, and untagged images (for example an old image after its `sha-*` tag moved to a rebuilt one).
- Signatures, SBOMs, provenance, and per-platform children are kept and deleted together with their parent image.
- **Currently a dry run** (nothing is deleted; the candidates are listed in the run log). The dry run will be turned off after the log has been reviewed.
- If you pin by digest, use the digest of a version-tagged image (other images are eventually deleted).

## Where the rules live

| Document | Contents |
|---|---|
| [`docs/spec.md`](docs/spec.md) | Specification (principles, stack, features, stages, known limitations) |
| [`docs/guideline-mapping.md`](docs/guideline-mapping.md) | Section-by-section mapping to the guideline (System Operations volume, v7.0) |
| [`docs/security-and-maintenance.md`](docs/security-and-maintenance.md) | Security and maintenance policy (system diagram, connection list, where secrets live, audit records, versioning and support period, decommissioning). In Japanese |
| [`SECURITY.md`](SECURITY.md) | How to report a vulnerability, and supported versions |
| [`docs/patient-name-test-cases.md`](docs/patient-name-test-cases.md) | Patient name test cases (machine-readable copy: `tests/fixtures/patient-names.json`) |
| [`tests/fixtures/orthanc/`](tests/fixtures/orthanc/) | Sample responses for synthetic patients used by the mock backend, and the redaction rules |
| [`AGENTS.md`](AGENTS.md) | Development rules (the same for people and for coding assistants) |
| [`.env.example`](.env.example) | Example configuration |

## License

[MIT](LICENSE). The application talks to the image server only over REST and DICOMweb and does not include its code.

## Trademarks

DICOM® is the registered trademark of the National Electrical Manufacturers Association (NEMA) for its standards publications relating to digital communications of medical information.
Other names may be trademarks of their respective owners.
