# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-24

### Fixed

- Reader: drop UI-chrome element content (nav, buttons, controls) from the readable text extracted for `.html` OKF-HTML sources.

## [0.1.0] - 2026-11-24

### Added

- OKF-format knowledge catalog as a pi extension: index skills, docs, and agents (OKF v0.2), with `okf_search`, `okf_read`, `okf_links`, and `okf_list` tools.
- Requirement-based lazy loading: resources load on demand with usage display instead of being preloaded into context.
- Trust and lifecycle surfaced: `type`, `resource`, `status`, `stale_after`, `generated.at`, and derived trust tiers (`unverified` / `machine-confirmed` / `human-reviewed`).
- OKF-HTML v0.1: index `.html` documents alongside markdown, with metadata parsing and UI-chrome-free readable text.
- Link-graph navigation (`okf_links`, both directions) and ASCII link-graph overlay rendered in `/okf-graph`.
- Usage tracking: docs read natively and catalog files touched via bash are surfaced in usage display.
- Permissive conformance (OKF §11): unknown fields, unknown types, missing frontmatter, and broken links are tolerated — never rejected.
