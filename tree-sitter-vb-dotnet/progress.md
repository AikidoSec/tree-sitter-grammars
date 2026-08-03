# VB.NET grammar: corpus tests + first fixed gap

## Summary

`tree-sitter-vb-dotnet` had no `test/corpus/` (unlike `tree-sitter-kotlin`/`tree-sitter-dart`), so
none of its known parsing gaps were tracked as regression tests. This PR:

1. Adds `test/corpus/` with a baseline suite covering syntax the grammar already handles correctly.
2. Ports the known grammar gaps found while benchmarking autotriage's VB.NET call-tracing (see
   `autotriage`'s `src/langs/vb/vb-parser-breaks.md` and `src/langs/Vb.test.ts`) into
   `test/corpus/known_gaps.txt` as intentionally-failing tests, so each gap has a minimal repro
   pinned in the grammar repo itself.
3. Fixes six of those gaps:
   - identifiers that start with a keyword (`DoWork`, `SelectAll`, ...) were being split into
     `ERROR` + orphan identifier instead of parsing as one identifier.
   - a `Class`/`Structure`/`Interface`/`Enum` nested inside another type had no valid grammar
     production at all, so it (and every sibling declaration after it) misparsed as `ERROR`.
   - generic type parameters `(Of T)` on class/method declarations, and generic types `(Of T)` on
     field/return types, were missing their surrounding parens in the grammar and misparsed as
     `ERROR` either side of an otherwise-correct `type_parameters`/`generic_type` node.
   - generic method/function *calls* with explicit type arguments (`GetItem(Of String)(...)`) had
     no grammar support at the call site at all.
   - VB.NET's 2-argument null-coalescing `If(expr, ifNothingExpr)` had no grammar support — only
     the 3-argument ternary `If(condition, true, false)` form existed.
   - `Inherits`/`Implements` — real VB.NET style is one per line, right after the class header —
     were only accepted inline on the header line itself, before the statement terminator.

## What changed

### Corpus tests (`test/corpus/`)

- `declarations.txt` (12 tests), `statements.txt` (9 tests, incl. the `Do`-prefix fix, the
  generic-call fix, and the 2-arg `If` fix) — baseline coverage: modules, classes, interfaces,
  structures, properties (auto + get/set), if/select/for/while/try, nested classes, generic
  class/method declarations, generic field/return types, generic method calls, 2-arg `If`,
  separate-line `Inherits`/`Implements`. All pass; this is what proves the corpus-test plumbing
  works end to end (CI already runs `tree-sitter test` per grammar folder via
  `.github/workflows/test.yml`).
- `known_gaps.txt` (1 test) — known bug, pinned with `(source_file)` as a deliberately-wrong
  placeholder expected tree, so the test fails until the grammar is fixed. Once fixed, regenerate
  the expected tree with `tree-sitter test -u` and (if it's a small/synthetic repro) move the test
  out of this file into `declarations.txt`/`statements.txt`.
  - **Generic type used as a value for static member access** — e.g.
    `ConsList(Of TypeSymbol).Empty`. This is what's left of the old "constructors with
    generic-collection parameters" gap: every other factor in that real-world repro (attribute +
    `ByRef` + generic-type parameter, `Optional` defaults, generic field types, `Shared ReadOnly
    Property`, and the 2-arg `If`) is now fixed; only this one remains, so it's isolated into its
    own minimal test. Tried fixing it (see "Attempted and reverted" below) — genuinely harder than
    the other gaps, not a quick follow-up.

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

### Grammar fix: generic method/function calls (`grammar.js`)

`invocation` (the grammar rule behind any `target(args)` call, e.g. `GetItem(...)`,
`obj.Method(...)`) had no way to accept an explicit `(Of T)` type-argument list between the target
and the real argument list, so `GetItem(Of String)("key")` parsed as a call to `GetItem` with two
bogus arguments (`Of`, `String`), with the real `("key")` then misread as an `element_access`
(array/indexer) on the call's result — matches `vb-parser-breaks.md` #20 closely (minor wording
difference: the doc says `Of` itself is `ERROR`; what's actually produced is `Of`/`String` parsed
as two valid-looking bogus arguments, with the `ERROR` landing on the real argument list instead).

Fix: add an `optional(field('type_arguments', $.type_argument_list))` between `target` and
`arguments` in `invocation`. `type_argument_list` (fixed in the previous commit) already starts
with `'(' kw('Of')`, so the parser can distinguish it from a plain `argument_list` by that second
token — no new grammar conflict, clean regenerate.

Verified:
- `GetItem(Of String)("key")` and `services.Configure(Of T)(x)` (member-access target) — both zero
  `ERROR`, with `type_arguments` and `arguments` as two separate, correctly-shaped fields.
- No regressions: full corpus suite unaffected elsewhere.

### Grammar fix: 2-argument `If` null-coalescing operator (`grammar.js`)

`ternary_expression` (VB's `If` operator) only supported the 3-argument ternary form
(`If(condition, true, false)`). VB.NET's other `If` form — `If(expr, ifNothingExpr)`, 2 arguments,
null-coalescing (returns `expr` unless it's `Nothing`, else `ifNothingExpr`) — has no dedicated rule
at all, so `If(a, b)` failed to parse (the grammar only recognizes `kw('If')` as the start of either
`if_statement` or the 3-arg `ternary_expression`, and neither accepts a 2-arg call shape).

Fix: make `false_branch` optional in `ternary_expression` — `field('true_branch', ...)` then
`optional(seq(',', field('false_branch', ...)))`. Clean regenerate, no new conflicts (unlike the
attempt below).

Verified:
- `If(a, b)` — zero `ERROR`.
- `If(cond, a, b).Prepend(symbol)` (3-arg form with a chained call) — still zero `ERROR`, confirming
  chaining onto a ternary result was never the problem; only the 2-arg form itself was missing.
- No regressions: full corpus suite unaffected elsewhere.

### Attempted and reverted: generic type as a value expression

Tried to fix `ConsList(Of TypeSymbol).Empty` (a generic type used as a value, e.g. for static member
access) by adding `$.generic_type` to `expression`'s choices. This is structurally harder than the
other gaps and was reverted:

- Adding `$.generic_type` directly to `expression` created a real ambiguity with `member_access`
  (both start with the same `identifier` prefix before diverging — `namespace_name` can extend with
  more dots, or reduce immediately to a complete `identifier` expression). Declaring the conflict
  tree-sitter's error suggested (`[$.namespace_name, $.expression]`) made it build, but at runtime
  the parser always eagerly reduced to the bare identifier first (this is a shift/reduce table
  decision made at build time, not a runtime GLR merge — `prec.dynamic()` doesn't affect it, since
  that only resolves ties between multiple *successfully completed* parses, not shift-vs-reduce
  timing) and the type-argument-list still landed as an orphan `ERROR`.
- Tried instead adding an optional `type_argument_list` directly to `member_access` between `object`
  and the dot (mirroring the `invocation` fix, which worked cleanly). This cascaded into new
  conflicts with `element_access`, then `unary_expression`, then `binary_expression`, each requiring
  another declared conflict — because *any* `expression` followed by `(` is now ambiguous with this
  new form, not just the one case we care about. Stopped rather than keep adding conflicts blind.

Whoever picks this up next should expect to need a more structural change — e.g. a dedicated rule
for "generic type as a value" that's distinguishable from a plain identifier *before* the parser
commits to reducing it, not a `choice` alternative bolted onto the general `expression`/
`member_access` rules.

### Grammar fix: `Inherits`/`Implements` on separate lines (`grammar.js`)

Real VB.NET style puts `Inherits`/`Implements` on their own line, right after the class/
structure/interface header — never inline on the header itself. `class_block`, `structure_block`,
and `interface_block` all placed `optional(inherits_clause)`/`optional(implements_clause)` *before*
`$._terminator`, so the grammar only accepted the (never-actually-used-in-practice) inline form; the
normal separate-line form had no member-level slot to land in and misparsed as `field_declaration` +
`ERROR`, the same category of bug as the nested-type-declaration fix earlier in this branch (a
missing "where can this appear" case, not a lexer/precedence issue like most of the others).

Fix: move `inherits`/`implements` to after `$._terminator` in all three rules, each now followed by
its own terminator: `optional(seq(field('inherits', $.inherits_clause), $._terminator))`, same for
`implements`. Only unrelated wrinkle: `namespace_name`/`inherits_clause`/`implements_clause` rules
themselves needed no changes — this was purely about *where* they're allowed to appear.

Verified:
- The original gap repro (`Inherits Animal` then `Implements IBarker`, each on its own line) — zero
  `ERROR`, both clauses correctly attached as `inherits`/`implements` fields on `class_block`.
- `Inherits`-only and `Implements`-only (with comma-separated interfaces) on a class — zero `ERROR`.
- `Interface` with `Inherits` on its own line, `Structure` with `Implements` on its own line (the
  other two rules touched by this fix) — zero `ERROR` each.
- No regressions: full corpus suite unaffected elsewhere.

## Verification

```
tree-sitter generate --abi 14   # clean, no warnings
tree-sitter test                # 20 passing, 1 known gap (intentionally failing)
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
- Re-verify `vb-parser-breaks.md` #18/#19/#20/#21 against the current grammar now that #17's actual
  behavior didn't match the doc — the doc may need a broader refresh, not just new corpus tests.
- Fix generic type as a value expression (`ConsList(Of TypeSymbol).Empty`) — see "Attempted and
  reverted" above for what doesn't work; needs a structurally different approach than the other
  fixes in this branch.
- `vb-parser-breaks.md` #23-25 (multi-line implicit line continuation — argument lists, `New With
  {}` initializers, lambda bodies spanning lines without a trailing `_`) is a separate, much larger
  gap: `_newline` is an unconditional `/\r?\n/` with no context awareness at all, so it's not a
  quick grammar tweak like the fixes above — almost certainly needs an external C scanner tracking
  bracket/paren depth (this grammar has none today), the same category of problem as Python's
  INDENT/DEDENT scanner.
