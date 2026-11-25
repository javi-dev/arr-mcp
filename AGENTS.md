# Agent Instructions

This repository is a public fork of upstream `arr-mcp`. Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes, starting with [If you are working with a coding agent](CONTRIBUTING.md#if-you-are-working-with-a-coding-agent).

## Upstream Rules

All rules in [CONTRIBUTING.md](CONTRIBUTING.md) apply here. In short:

- **Verification gates.** Run `npm run lint`, `npm run typecheck`, and `npm test`, and report the actual output ([The three gates](CONTRIBUTING.md#the-three-gates)).
- **Fixtures and live claims.** Never write a fixture by hand. Capture real responses with `npm run capture -- <service>` (or `npm run capture:webhooks` for webhooks) and keep unverified paths marked per [Recorded fixtures](CONTRIBUTING.md#recorded-fixtures). State clearly what was exercised only in unit tests versus verified against a live instance.
- **Style and commits.** Follow [Writing](CONTRIBUTING.md#writing) (no em dashes, no en dashes, no `--` used as a dash, and no AI filler phrasing) and [Commit messages](CONTRIBUTING.md#commit-messages) (Conventional Commits).
- **Architecture and API surface.** Respect the public tool and prompt surface, tool count ceiling, adapter contracts, write harness, and `src/services/generated/` rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy and Anonymity

This fork is public and every commit, pull request, and issue is permanent. Never include personal or environment-specific information anywhere in code, tests, fixtures, docs, comments, commit messages, PRs, or issues.

Strictly forbidden:

- Private, LAN, or Tailscale IP addresses and subnets
- Local hostnames, internal DNS names, or personal domains
- Real `*arr`, media server, or download client instance names
- Real titles from a personal media library
- Private tracker or indexer names, announce URLs, RSS URLs, or passkeys
- Personal email addresses, usernames, or account identifiers
- Real local filesystem paths, mount points, or container paths
- API keys, tokens, cookies, passwords, or session IDs

Rules when working with live services or examples:

- Never paste raw or unredacted output from a live service into files, commits, PRs, or issues.
- Never write fixtures by hand from real service data. When capturing with `npm run capture -- <service>` or `npm run capture:webhooks`, run `test/fixtures.test.ts` and inspect `git diff test/fixtures/` line by line to ensure no private data, paths, trackers, or personal library titles remain (stricter than upstream on library titles).
- When synthetic examples are needed in tests or docs, use only reserved placeholders (`example.test`, `example.com`, RFC 5737/3849 documentation IPs, `user1`, `Indexer 1`, `/media/...`).
- Before pushing or opening a PR, audit `git diff` and commit messages to confirm no personal or environment-specific data is present.

## Operational Boundaries

- **Release and image workflows.** Do not enable, trigger, or modify `.github/workflows/pr-image.yml`, `.github/workflows/preview.yml`, or `.github/workflows/release.yml` without explicit authorization.
- **No external deployments.** Do not deploy to production or modify external containers, hosts, or running services from code tasks.
- **Repository target.** Push branches and open pull requests against this fork (`origin`) unless explicitly asked to target upstream.
