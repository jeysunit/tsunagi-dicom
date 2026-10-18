# tsunagi-dicom

[日本語](README.md)

A standalone web front end and BFF (Backend For Frontend) that uses a DICOMweb-capable image server (such as Orthanc) **as an unmodified backend**, and provides a study list, a per-patient timeline, and viewer selection designed around how images are reviewed in Japanese medical institutions.

> **Not for Diagnostic Use / 非医療機器 (not a medical device).**
> This software is for research, education, and evaluation. It has not been approved or certified as a medical device.

## Status

**Stage 1a (2026-10-18).** The foundation, the BFF relay, the audit trail, development authentication (`AUTH_MODE=dev`), the common screen, and CI with container images are in place.
The only page shows the number of studies and a plain study list, fetched through the BFF. Application user login (`AUTH_MODE=local`) comes in stage 1b; until then the application starts only with `AUTH_MODE=dev`.
Implementation proceeds stage by stage; each PR covers one cohesive change within a single stage (see "6. 段階" in [`docs/spec.md`](docs/spec.md)).

The user interface will be Japanese only at first. The documents are written mainly in Japanese.

## What it does

- **Study list**: quick filters by study date, modality, and status (the Japanese terms used in clinical practice: 未検像, 検像済, 未読, 既読, 緊急, bookmark). Patient names are shown split into the ideographic (kanji) name and the phonetic (kana) name; birth dates are shown with the Japanese era and age.
- **Viewer selection**: open a study in one of the configured viewers (OHIF Viewer, Stone Web Viewer, VolView, ...). Defaults can be remembered per study and per modality.
- **Per-patient timeline**, and side-by-side comparison of two studies.
- **Simple reports (簡易レポート)** and import of documents such as PDF.
- **Security and operations**: roles, two-factor authentication, audit trail, and so on. [`docs/guideline-mapping.md`](docs/guideline-mapping.md) maps these features to the items of the Japanese Ministry of Health, Labour and Welfare guideline (version 7.0, System Operations volume). **Whether a deployment meets the guideline is for each institution to determine, including its operations; this software alone does not make a deployment compliant.**

The image server and viewers are not modified. Every endpoint is configured through environment variables. Search and retrieval use DICOMweb first; Orthanc-only features are kept in separate components that are enabled only with an Orthanc backend.

## Trying it out (mock backend)

Without an image server, run it against the mock backend (synthetic samples in `tests/fixtures/orthanc`) and development authentication (`AUTH_MODE=dev`; writes are blocked):

```sh
SESSION_SECRET="$(openssl rand -base64 48)" BACKEND_MOCK=true AUTH_MODE=dev docker compose up --build
# open http://127.0.0.1:3000/
```

For local development (Node version in `.nvmrc`):

```sh
npm ci
cp .env.example .env   # set BACKEND_MOCK="true", AUTH_MODE="dev" and SESSION_SECRET
mkdir -p data && DATABASE_URL="file:./data/tsunagi.db" npm run db:migrate
DATABASE_URL="file:./data/tsunagi.db" npm run dev
```

Tests: `npm run lint`, `npm run typecheck`, `npm test` (Vitest), `npm run build && npm run test:e2e` (Playwright, against the mock backend).

For deployment, pin the GHCR image (`ghcr.io/jeysunit/tsunagi-dicom`) by version tag (`vX.Y.Z`) or digest (`TSUNAGI_IMAGE` in `compose.yaml`).

## Where the rules live

| Document | Contents |
|---|---|
| [`docs/spec.md`](docs/spec.md) | Specification (principles, stack, features, stages, known limitations) |
| [`docs/guideline-mapping.md`](docs/guideline-mapping.md) | Section-by-section mapping to the guideline (System Operations volume, v7.0) |
| [`docs/patient-name-test-cases.md`](docs/patient-name-test-cases.md) | Patient name test cases (machine-readable copy: `tests/fixtures/patient-names.json`) |
| [`tests/fixtures/orthanc/`](tests/fixtures/orthanc/) | Sample responses for synthetic patients used by the mock backend, and the redaction rules |
| [`AGENTS.md`](AGENTS.md) | Development rules (the same for people and for coding assistants) |
| [`.env.example`](.env.example) | Example configuration |

## License

[MIT](LICENSE). The application talks to the image server only over REST and DICOMweb and does not include its code.

## Trademarks

DICOM® is the registered trademark of the National Electrical Manufacturers Association (NEMA) for its standards publications relating to digital communications of medical information.
Other names may be trademarks of their respective owners.
