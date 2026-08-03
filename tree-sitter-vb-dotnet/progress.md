# VB.NET grammar: corpus tests + first fixed gap

## Summary

`tree-sitter-vb-dotnet` had no `test/corpus/` (unlike `tree-sitter-kotlin`/`tree-sitter-dart`), so
none of its known parsing gaps were tracked as regression tests. This PR:

1. Adds `test/corpus/` with a baseline suite covering syntax the grammar already handles correctly.
2. Ports the known grammar gaps found while benchmarking autotriage's VB.NET call-tracing (see
   `autotriage`'s `src/langs/vb/vb-parser-breaks.md` and `src/langs/Vb.test.ts`) into
   `test/corpus/known_gaps.txt` as intentionally-failing tests, so each gap has a minimal (or
   verbatim real-world) repro pinned in the grammar repo itself.
3. Fixes one of those gaps: identifiers that start with a keyword (`DoWork`, `SelectAll`, ...)
   were being split into `ERROR` + orphan identifier instead of parsing as one identifier.

## What changed

### Corpus tests (`test/corpus/`)

- `declarations.txt` (7 tests), `statements.txt` (6 tests, incl. the newly-fixed one below) —
  baseline coverage: modules, classes, interfaces, structures, properties (auto + get/set),
  if/select/for/while/try. All pass; this is what proves the corpus-test plumbing works end to
  end (CI already runs `tree-sitter test` per grammar folder via `.github/workflows/test.yml`).
- `known_gaps.txt` (3 tests) — known bugs, each pinned with `(source_file)` as a deliberately-wrong
  placeholder expected tree, so the test fails until the grammar is fixed. Once fixed, regenerate
  the expected tree with `tree-sitter test -u` and (if it's a small/synthetic repro) move the test
  out of this file into `declarations.txt`/`statements.txt`.
  - **Nested class declaration breaks extraction of everything after it** — a `Class`/`Structure`/
    `Interface` nested inside another type misparses as a garbled `field_declaration` + `ERROR`,
    and the cascade loses every subsequent sibling declaration. Repro is a verbatim excerpt from
    `dotnet/roslyn`'s `AbstractFlowPass.vb`.
  - **Constructors with generic-collection parameters lose sibling declarations** — a parameter
    list combining an attribute (`<[In], Out>`), `ByRef`, a generic type
    (`CompoundUseSiteInfo(Of AssemblySymbol)`), and `Optional ... = Nothing` defaults across
    multiple lines breaks parsing of the entire surrounding class *and* its sibling `Structure`.
    Repro is a verbatim excerpt from `dotnet/roslyn`'s `BasesBeingResolvedBinder.vb`. Root cause
    likely overlaps with the fact that this grammar has no `(Of T)` generic-type support at all
    (affects class/method declarations, field types, return types, and call sites alike — see
    `vb-parser-breaks.md` items #17-21).
  - **`Inherits`/`Implements` on separate lines produce ERROR nodes** — real VB.NET style is
    `Inherits`/`Implements` as their own statement, one per line, right after the class header.
    The grammar only accepts them inline on the header line (before the statement terminator), so
    the normal separate-line form misparses as `field_declaration` + `ERROR` — happens even with
    only one of the two clauses present.

### Grammar fix: keyword-prefixed identifiers (`grammar.js`)

`kw()` wrapped every keyword as `token(prec(1, ci(word)))`. The `prec(1, ...)` was meant to only
break *ties* (disambiguating the exact string `Do` from an identically-spelled identifier), but
tree-sitter's lexer already prefers the *longest* match among competing tokens by default — the
explicit precedence instead made the *short* keyword win over a *longer* identifier match, so
`DoWork()` lexed as keyword `Do` (→ `ERROR`, since `do_statement` doesn't continue with `Work`)
plus an orphan `Work()` call. Same root cause covered `SelectAll()`, `Download()`, etc. (any
identifier keyword-prefixed with `Do`/`Select`/...).

Fix: drop the `prec()` boost from `kw()` — `token(ci(word))`. Verified:
- `DoWork()` / `SelectAll()` now parse as single identifiers, no `ERROR`.
- Bare `Do ... Loop` still parses as `do_statement` (no regression on the keyword itself).
- Full corpus suite (`tree-sitter test`) unaffected elsewhere: same tests pass/fail before and
  after, other than the one moved from `known_gaps.txt` into `statements.txt` now that it's fixed.

This likely also fixes `vb-parser-breaks.md` gap #2 (`Select`-prefix identifiers) — not yet
ported into a corpus test.

## Verification

```
tree-sitter generate --abi 14   # clean, no warnings
tree-sitter test                # 13 passing, 3 known gaps (intentionally failing)
```

## Also fixed in this branch (housekeeping, no behavior change)

- `binary_expression`'s unnecessary single-element `choice(...)` wrappers (`choice('^')`,
  `choice(kw('TypeOf'))`) — removed the "unnecessary `seq`/`choice`" generate warning.
- Two stale `conflicts` entries (`[$.type, $.invocation]`, `[$.type]`) that no longer correspond
  to any real grammar ambiguity — removed the "unnecessary conflicts" generate warning.
- Both confirmed byte-identical `parser.c`/`node-types.json` output before/after, i.e. purely
  cosmetic.

## Next steps

- Port `vb-parser-breaks.md` gap #2 (`Select`-prefix identifiers) as a corpus test in
  `statements.txt` — likely already fixed by the same change, needs verification.
- Fix `Inherits`/`Implements` on separate lines: move the optional clauses in `class_block`/
  `structure_block`/`interface_block` to after the statement terminator instead of before it.
- Investigate nested class declaration cascade and generic-parameter-list parsing — both larger,
  likely-related pieces of work (the latter needs `(Of T)` generic-type support designed from
  scratch, which touches many rules).
