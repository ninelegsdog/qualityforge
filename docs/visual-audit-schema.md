# Appearance artifact v1

One run's verdict on the appearance a project approved: what each declared page looks
like now, against the committed image it was approved to look like.

- Machine-readable schema and runtime validator:
  [`../src/visual/types.ts`](../src/visual/types.ts)
- Producer: [`../src/visual/audit.ts`](../src/visual/audit.ts)
- Capture: [`../src/visual/observe.ts`](../src/visual/observe.ts)
- Configuration: `visual` in `config/project.json`

## The design rule

**An appearance is not a defect, and it is not a field on `defect.v1`.** A defect exists
because a test failed; a page can lose its header border while every assertion holds, and
that case is the entire reason this dimension exists. Binding the two would make every
measurement look like a failure.

## Producing artifacts

```json
"visual": {
  "project": "chromium",
  "directory": "tests/visual-baselines",
  "pages": ["/", "/docs", "/contact"]
}
```

`project` is **named, not derived**, because measurement showed it cannot be derived: on
2026-10-18 the same page produced no shared screenshot hash across engines or viewports.
A baseline that does not say which engine approved a picture says nothing about it, which
is why the engine is in the filename too.

The fixture is declared `auto`, so no test has to ask: every test photographs the page it
is on, and the collector writes `visual-audit.v1` under `artifacts/visual/<runId>/`.

The collector exits `1` when a page is not as approved, and prints one line per finding.
Two verdicts live in the run summary and are reported apart:

| Field            | Question it answers                   |
| ---------------- | ------------------------------------- |
| `summary.gate`   | did the **tests** hold the thresholds |
| `summary.visual` | did the **pages** look as approved    |

`summary.gate` keeps its published meaning. Folding appearance findings into it would
change the _meaning_ of an existing field, which the versioning rule calls a major change
and a `v2` file.

## The verdict is a hash, and that is what makes it zero tolerance

Byte equality is a real measurement here, not an approximation: chromium produced
byte-identical screenshots across five runs in fresh contexts, at a fixed viewport with
animations disabled. Comparing hashes is therefore **zero tolerance by construction** —
there is no threshold to tune, and so no size of change that was quietly decided not to
look for.

The tempting alternative is a pixel count, and the measurement says not to:

|                                           | pixels       |
| ----------------------------------------- | ------------ |
| same commit, same machine, chromium       | **0**        |
| same commit, same machine, firefox        | 253          |
| **same commit, a different machine (CI)** | **269–1898** |
| a real CSS change, same machine           | 3 315        |

On one machine the signal clears the noise by 13. **Across two machines the gap is
gone** — the cross-machine difference is 57% of the signal — and a threshold wide enough
to tolerate it would swallow a 1000-pixel change, which is nearly any visual change at
all. Zero tolerance therefore holds _within one rendering environment_, and the
environment is pinned by capturing and checking in the same place.

## Baselines are born in CI, and nothing else writes one

`tests/visual-baselines/` holds committed PNGs. **There is no manifest of expected
hashes**: the image is the baseline, and its hash is computed from the file on every run.
A manifest beside the images would be a second copy of one fact, and two copies of one
fact are two things to drift.

**A baseline's viewport is `null`, not a number.** The PNG carries pixels, not CSS
dimensions, and a viewport cannot be recovered from it without guessing. The capture
beside the verdict records the viewport that was actually used. Until the live external
run on 2026-10-19, the producer wrote `0×0×0` in that field, which a reader could only
take as a real measurement of a page nobody rendered. Unknown is now stated as unknown,
and the validator refuses zero dimensions if an older producer or a tampered artifact
claims them.

Three rules keep the approval human:

| rule                                                | why                                                                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `updateSnapshots: "none"` in `playwright.config.ts` | Playwright's default is `missing`: a plain suite run would write any snapshot it lacks and pass, so the first run of a new page would approve its own appearance with nobody looking at it |
| `npm run visual:baselines` is the only writer       | it passes `--update-snapshots=missing` explicitly: it writes what is absent and never overwrites what exists                                                                               |
| the CI step runs **after** the collector            | a missing baseline is reported as a violation and the verdict stands; the run stays red until a human commits the image                                                                    |

## What a page looks like is the page at rest

The fixture **reloads before photographing**. Measured: `/contact` was seen five ways
across nine captures, because tests fill the form and leave error states behind. Those are
one page and five things a test did to it. Reloading is safe because the test body has
finished.

Two conditions must hold before the shot, and they are bounded:

- **The page must settle.** Waiting for fonts alone left the home page hashing
  differently between the generator and the suite run at the same viewport — the list was
  still being fetched. Both sides wait for the network first.
- **A page that never settles contributes nothing.** `networkidle` never arrives on a
  test that deliberately holds a request open, which is a whole category here, so the
  wait is bounded and a timeout is not an error.

## Violations

| kind             | means                                                               |
| ---------------- | ------------------------------------------------------------------- |
| `changed`        | the approved engine looked, and it moved                            |
| `unstable`       | the approved engine looked, and the page rendered more than one way |
| `no-baseline`    | nobody has approved this page's appearance                          |
| `no-observation` | the approved engine ran and never looked at this page               |

`no-baseline` and `no-observation` are the fail-closed pair: an appearance nobody
approved is not an approved appearance, and an appearance nobody looked at is not an
unchanged one. Both name the file and the command, because a finding that does not say
what to do is a complaint rather than a finding.

`unstable` is its own kind because calling it a change would send a reader to diff two
pictures when the real question is **which of them is the page**. Firefox does exactly
this on this repository's home page.

## Only the approving engine is judged

The producer ignores captures from any other engine. This is not tidiness: judging every
engine against the approved engine's baseline made CI's firefox and webkit legs report
`changed` on pages they do not gate, with `/docs` arriving as `ad87d6051c1b` against a
baseline of `109c1cec65a4`. An absent engine is **not** the approving one — silence is
not consent.

And a leg that is not the approved engine produces **no findings at all**. `ran` means
"this leg is judging", which is a different question from "did anything render":

| state                   | meaning                                               | a failure |
| ----------------------- | ----------------------------------------------------- | --------- |
| not judged here         | this leg is not the approved engine                   | no        |
| judged, page unobserved | the approved engine ran and never looked at this page | yes       |
| judged, page differs    | the approved engine looked and it moved               | yes       |

Fail-closed applies inside the run that is judging. Outside it there is nothing to be
closed about.

## A deliberate stub is evidence about the stub

A test that stubs a declared endpoint to prove the API audit reports a breach also
photographs a page the stub changed — measured: the home page was seen four ways across 21
captures because the API capture tests stub `/api/items`. The existing `markStubbed()`
convention covers appearance too, and the guard test requires **both** markers: marking
one and not the other is how a project's own evidence ended up counted against it.

## Reading artifacts

Two read-only MCP tools serve them over `--visual-root`:

- `quality_list_visual_audits` — one entry per run, with the approving engine
- `quality_get_visual_audit` — every page, its hash, and what was approved against what
  was seen

A client path that walks out of the appearance root is refused with `-32602`, asserted
over a real pipe in `scripts/mcp-tools-check.py` against a **seeded change** — a clean
seed would prove the wire works and nothing about the part a model acts on.

## What this does not do

**There is no rendered diff overlay in v1, and the observed screenshot is not stored.**
The owner's decision of 2026-10-20 is recorded as
[G24](defect-schema.md#g24--a-rendered-difference-is-not-stored-as-a-picture): a
screenshot is page content, not a measurement, and it could carry a token or a
personalised list that no field-level redaction can remove. The artifact gives the
baseline's hash and path, the observed hash and byte size, and the viewport the capture
used; a human who needs more reproduces the page at that viewport.

There are no two images in the artifact to open or diff. A reader who wants the observed
page has to reproduce it; the baseline is the one picture the repository keeps.

Cross-environment comparison is written up with the rendered-diff decision as
[G23–G25 in the defect schema](defect-schema.md#g23--a-screenshot-cannot-say-which-way-a-page-looks-right).
