# Acceptance criteria referenced by tracked code

## Why this file is tracked when the rest of `docs/` is not

The plans, specifications, reports and runbooks under `docs/` are working
documents. They are deliberately excluded from the repository, and `.gitignore`
denies them by default.

That is fine for prose nobody else has to resolve. It is not fine for an
identifier: tracked source, comments, test names, diagnostic strings and CI
workflow steps in this repository cite acceptance criteria by tag, and a reader
who has only a clone must be able to find out what a tag means. A tag whose
definition lives solely in an untracked document is a dangling reference.

This file is the tracked definition for every such tag. It carries the criterion
wording and its verification status — nothing else. It is not a copy of the
specification, and it is not a substitute for one.

If you add a tracked reference to a criterion that is not defined below, define
it here in the same change.

---

## AC-21 — Scope isolation

> After broker crash or plugin reconnect, a different client cannot use the
> prior client's confirmed scoped directory before the existing
> revocation/confirmation invariant is re-established.

**Verification status as of 2026-08-23: UNVERIFIED. This criterion is not
satisfied and must not be reported as satisfied.**

What that status does and does not mean:

- No measurement says the product fails this criterion. Nothing here is a known
  product limitation.
- The deterministic half of the proof exists and is falsifiable. Six scenarios
  in `tests/adapter-scope-isolation.test.ts` drive the invariant against a fake
  plugin and a fake broker: eager revocation on a newly authenticated bridge, an
  unanswered revocation blocking public commands, a refused revocation keeping
  them blocked, and a freshly started broker revoking an inherited grant.
- The missing half is live corroboration — a real Blockbench, a real scoped
  filesystem, and a human answering a confirmation dialog. Fakes cannot exercise
  that path, because the confirmation and the scoped-filesystem acquisition
  belong to Blockbench rather than to this project.
- The repository owner accepted the criterion as unverified on 2026-08-23, on
  the ground that operator time to run the live smoke on Linux, macOS and native
  Windows was not available. **That is an acceptance of missing evidence, not
  evidence.**

The means to close it is committed and ready:

| Path | Role |
| --- | --- |
| `scripts/smoke-scope-isolation.mjs` | The smoke. Drives establish / disrupt / assert / re-establish. |
| `scripts/smoke/scope-isolation.sh` | POSIX launcher. |
| `scripts/smoke/scope-isolation.ps1` | Windows PowerShell launcher, targeting 5.1 and 7. |
| `npm run smoke:scope-isolation-live` | Entry point. |

The smoke returns a three-valued verdict — `PASS`, `FAIL`, `INCONCLUSIVE`,
exiting 0, 1 and 2. A grant to the second client is `FAIL` however it was
reached, decided first and unconditionally. Every other outcome starts from
`INCONCLUSIVE` and must clear each gate in turn, so `INCONCLUSIVE` can never
collapse into `PASS`; a run that never reached its own assertion reports that
rather than passing.

**A green platform matrix does not cover this criterion.** Hosted runners have
no Blockbench, no desktop session, and nobody to answer a confirmation dialog.
Do not read CI success as closing it.

Discharging it means running the smoke on Linux, macOS and native Windows, in
both the platform-default and the explicit alternative mode, and retaining the
receipts.

**Revisit trigger:** when operator time is available, or immediately if any
change touches scope handling in `src/adapter/ws-bridge.ts` or
`src/plugin/scope-manager.ts`. Do not let this acceptance be inherited silently
into a release.

Referenced from `scripts/smoke-scope-isolation.mjs`,
`scripts/smoke/scope-isolation.sh`, `scripts/smoke/scope-isolation.ps1`,
`tests/smoke-scope-isolation.test.ts`, and
`.github/workflows/platform-matrix.yml`. The smoke's receipt also carries the
tag as data, in its `acceptance_criterion` field.

---

## AC-27 — Platform evidence

> Linux/WSL brokered behavior, native-Windows direct behavior, macOS default
> behavior, and explicit native-Windows broker behavior each pass in an
> authoritative environment. If a required platform environment is unavailable,
> this criterion remains unverified and the limitation is reported explicitly;
> absence of a runner is not a passing result and does not narrow the set of
> platforms this project claims to support.

**Verification status as of 2026-08-23: SATISFIED.**

GitHub Actions run `32609586573` returned `verdict=PASS` on all four required
legs. No platform support was narrowed to reach it: no conditional skip was
added, and every expected count moved up rather than down.

The four legs are the four scenarios, one-to-one. The `ac27-gate` job in
`.github/workflows/platform-matrix.yml` fails the run unless every leg
succeeded, so a leg that was skipped, cancelled, or never configured cannot pass
by absence — which is what the criterion's second sentence requires.

That workflow triggers only on `ci/**` branches. It is retained on the main line
so the evidence can be regathered, not because it runs here.

**Revisit trigger:** re-open if the matrix workflow, its `expected_*` rows, or
the platform-capability registry in `tests/platform-capabilities.ts` changes,
since each of those can make a leg pass for the wrong reason.

Referenced from `.github/workflows/platform-matrix.yml` as the `ac27-gate` job.
