# VB.NET grammar: corpus tests + first fixed gap

## Summary

`tree-sitter-vb-dotnet` had no `test/corpus/` (unlike `tree-sitter-kotlin`/`tree-sitter-dart`), so
none of its known parsing gaps were tracked as regression tests. This PR:

1. Adds `test/corpus/` with a baseline suite covering syntax the grammar already handles correctly.
2. Ports the known grammar gaps found while benchmarking autotriage's VB.NET call-tracing (see
   `autotriage`'s `src/langs/vb/vb-parser-breaks.md` and `src/langs/Vb.test.ts`) into
   `test/corpus/known_gaps.txt` as intentionally-failing tests, so each gap has a minimal repro
   pinned in the grammar repo itself.
3. Fixes three of those gaps:
   - identifiers that start with a keyword (`DoWork`, `SelectAll`, ...) were being split into
     `ERROR` + orphan identifier instead of parsing as one identifier.
   - a `Class`/`Structure`/`Interface`/`Enum` nested inside another type had no valid grammar
     production at all, so it (and every sibling declaration after it) misparsed as `ERROR`.
   - generic type parameters `(Of T)` on class/method declarations, and generic types `(Of T)` on
     field/return types, were missing their surrounding parens in the grammar and misparsed as
     `ERROR` either side of an otherwise-correct `type_parameters`/`generic_type` node.

## What changed

### Corpus tests (`test/corpus/`)

- `declarations.txt` (10 tests), `statements.txt` (7 tests, incl. the `Do`-prefix fix) — baseline
  coverage: modules, classes, interfaces, structures, properties (auto + get/set),
  if/select/for/while/try, nested classes, generic class/method declarations and generic
  field/return types. All pass; this is what proves the corpus-test plumbing works end to end (CI
  already runs `tree-sitter test` per grammar folder via `.github/workflows/test.yml`).
- `known_gaps.txt` (3 tests) — known bugs, each pinned with `(source_file)` as a deliberately-wrong
  placeholder expected tree, so the test fails until the grammar is fixed. Once fixed, regenerate
  the expected tree with `tree-sitter test -u` and (if it's a small/synthetic repro) move the test
  out of this file into `declarations.txt`/`statements.txt`.
  - **Generic method call type arguments are not supported** — `GetItem(Of String)("key")` has no
    grammar support for an explicit `(Of T)` type-argument list before a call's real argument list,
    so it misparses as a call with two bogus arguments (`Of`, `String`) followed by the real
    `("key")` misread as an indexer on the result. This is a separate grammar surface from generic
    *declarations* (see the fix below) — declarations are now fixed, call sites aren't yet.
  - **Constructors with generic-collection parameters lose sibling declarations** — a parameter
    list combining an attribute (`<[In], Out>`), `ByRef`, a generic type
    (`CompoundUseSiteInfo(Of AssemblySymbol)`), and `Optional ... = Nothing` defaults across
    multiple lines breaks parsing of the entire surrounding class *and* its sibling `Structure`.
    Repro is a verbatim excerpt from `dotnet/roslyn`'s `BasesBeingResolvedBinder.vb`. Confirmed
    this is *not* fixed by the generics-declaration fix below (still 18 `ERROR` nodes) — it's a
    distinct, compounding combination of factors seen in real code.
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

### Grammar fix: nested type declarations (`grammar.js`)

`_member_declaration` — the set of things allowed inside a class/module/structure/interface body —
had no `type_declaration` alternative at all, so a nested `Class`/`Structure`/`Interface`/`Enum`
had no valid production once inside another type's body. The parser fell into error recovery on
the nested type's header line, which (depending on the surrounding code) could cascade into losing
every sibling declaration that followed.

Fix: add `$.type_declaration` to `_member_declaration`, and drop the now-redundant direct
`$.delegate_declaration` entry (delegates are already one of `type_declaration`'s alternatives;
keeping both created a genuine grammar ambiguity — "Unresolved conflict for symbol sequence").

Verified:
- Minimal nested-class repro (`Container` → nested `Inner` class → sibling method) now parses with
  zero `ERROR` nodes, including the sibling method declared *after* the nested class.
- Re-parsed the real verbatim Roslyn excerpt that originally surfaced this bug
  (`AbstractFlowPass.vb`'s nested `SavedPending` class): the nested class and its sibling
  `SavePending` function are now both structurally correct. Every remaining `ERROR` in that file is
  adjacent to `(Of T)` generic-type syntax — confirming the nested-class cascade is fully fixed and
  what's left there is entirely the separate generics gap.
- No regressions: full corpus suite unaffected elsewhere.

### Grammar fix: generic type parameters and type arguments (`grammar.js`)

`type_parameters` (the `(Of T As Constraint, ...)` clause on class/method declarations) and
`type_argument_list` (the `(Of T, ...)` clause on a `generic_type` reference, e.g.
`List(Of Integer)`) were both missing their surrounding `(`/`)` in their own `seq(...)` — they only
matched `Of T`, not `(Of T)`. The caller (`class_block`, `variable_declarator`'s `as_clause`, etc.)
didn't consume the parens either, so both landed as stray `ERROR` tokens immediately either side of
an otherwise-correctly-parsed `type_parameters`/`generic_type` node.

Fix: add `'(' ... ')'` around the existing body of both rules. Also removed a stale
`[$.type_argument_list]` conflicts declaration that predated this fix and was no longer needed
(confirmed by removing it and regenerating clean — no warning, no unresolved conflict).

Verified:
- `Public Class Container(Of T)` (generic class) — zero `ERROR`.
- `Public Function GetItem(Of T)(key As String) As T` (generic method declaration, with a *plain*
  `parameter_list` following the type parameters) — zero `ERROR`.
- `Public Items As List(Of Integer)` (generic field type via `generic_type`) — zero `ERROR`.
- `GetItem(Of String)("key")` (generic method *call*) — confirmed still broken; this is a different
  grammar surface (the invocation/call rule has no optional type-argument-list of its own) and is
  now tracked separately in `known_gaps.txt`.
- `vb-parser-breaks.md` #18/#19/#21 describe more severe symptoms (whole class lost, wrong arity,
  types silently dropped) than what this fix actually shows — those rows may be stale/from an
  earlier grammar snapshot; only #17 and #20 matched what was reproduced here.
- No regressions: full corpus suite unaffected elsewhere.

## Verification

```
tree-sitter generate --abi 14   # clean, no warnings
tree-sitter test                # 16 passing, 3 known gaps (intentionally failing)
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
  `statements.txt` — likely already fixed by the `Do`-prefix change, needs verification.
- Fix `Inherits`/`Implements` on separate lines: move the optional clauses in `class_block`/
  `structure_block`/`interface_block` to after the statement terminator instead of before it.
- Add generic type arguments to call sites (`GetItem(Of String)(...)`) — add an optional
  `type_argument_list` to the invocation/call grammar before the regular `argument_list`.
- Re-verify `vb-parser-breaks.md` #18/#19/#21 against the current grammar now that #17/#20's actual
  behavior didn't match the doc — the doc may need a broader refresh, not just new corpus tests.
- Re-check the "constructors with generic-collection parameters" gap now that plain generics are
  fixed — still broken (18 `ERROR` nodes), so the remaining factors (parameter attribute, `ByRef`,
  multi-line `Optional` defaults) are the real blocker there, not generics itself.
