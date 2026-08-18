# VB.NET grammar: corpus tests + 10 parsing gaps fixed

## Summary

`tree-sitter-vb-dotnet` had no `test/corpus/`, unlike `tree-sitter-kotlin`/`tree-sitter-dart`, so
none of its known parsing gaps were tracked as regression tests. This PR:

1. Adds `test/corpus/` — a baseline suite (`declarations.txt`, `statements.txt`) covering syntax
   the grammar already handles correctly, plus `known_gaps.txt` for known bugs pinned as
   intentionally-failing/skipped tests with a minimal repro each.
2. Fixes **10 distinct parsing gaps**, several found while benchmarking autotriage's VB.NET
   call-tracing against a Roslyn-based ground truth, not just from the pre-existing
   `vb-parser-breaks.md` doc.
3. Fixes **2 packaging bugs** found while test-installing the built package downstream.
4. Adds `progress.md` — a full changelog of root causes, fixes, what was tried and reverted, and
   why the one remaining known gap is intentionally not fixed.

`tree-sitter test`: **30 passing, 0 failing** (1 additional known-and-accepted gap marked `:skip`,
excluded from totals — see below).

## Grammar fixes

- **Keyword-prefixed identifiers** (`DoWork`, `SelectAll`, ...) were being split into `ERROR` +
  orphan identifier. `kw()`'s `prec(1, ...)` boost made a *shorter* keyword win over a *longer*
  identifier match — tree-sitter's lexer already prefers the longest match by default; the
  precedence was fighting that. Fix: drop the boost.
  ```vb
  Sub DoWork()
  End Sub
  ```
- **Nested type declarations** (a `Class`/`Structure`/`Interface`/`Enum` nested inside another
  type) had no valid grammar production at all, so it — and every sibling declaration after it —
  misparsed as `ERROR`.
  ```vb
  Public Class Outer
      Protected Class Inner
      End Class
  End Class
  ```
- **Generic type parameters/arguments** `(Of T)` on class/method declarations and field/return
  types were missing their surrounding parens in the grammar, landing as `ERROR` either side of an
  otherwise-correct node.
  ```vb
  Public Class Container(Of T)
      Public Items As List(Of Integer)
  End Class
  ```
- **Generic method/function calls** with explicit type arguments (`GetItem(Of String)(...)`) had
  no grammar support at the call site.
  ```vb
  GetItem(Of String)("key")
  ```
- **2-argument null-coalescing `If(expr, ifNothingExpr)`** had no grammar support — only the
  3-argument ternary form existed.
  ```vb
  Dim x = If(a, b)
  ```
- **`Inherits`/`Implements` on separate lines** (the real VB.NET style — one per line, right after
  the class header) were only accepted inline on the header line itself.
  ```vb
  Public Class Dog
      Inherits Animal
      Implements IBarker
  End Class
  ```
- **Preprocessor directives** (`#If`/`#Else`/`#End If`, `#Region`/`#End Region`, ...) had no valid
  production at member level (class/module/structure/interface body) — only inside statement lists
  — so wrapping alternate member declarations (e.g. two method overloads behind `#If ... Then`)
  misparsed as `ERROR`.
  ```vb
  #If DEBUG Then
      Sub DoWork(x As Integer)
  #End If
  ```
- **`Rem`-prefixed identifiers** (`RemoveHandlerFoo`, `Reminder`, `Remote`, ...) were swallowed into
  a `REM`-style comment along with the rest of the line — an unbounded greedy token beating a
  shorter identifier on raw length, unrelated to the `RemoveHandler` keyword despite appearances.
  ```vb
  Dim Removed As Integer
  ```
- **A leading comment before `Imports`** (the near-universal license-header shape in real VB.NET
  codebases) misparsed as `ERROR` — `source_file` had no way to consume the stray terminator a
  comment leaves behind before `option_statements`/`imports_statement`.
  ```vb
  ' Licensed under the MIT license.
  Imports System
  ```
- **VB's implicit line continuation** inside brackets (multi-line argument lists, multi-line
  `New With {}` object initializers) was misparsed as a statement terminator. This is the only fix
  in this branch needing an **external scanner** (`src/scanner.c`, new — this grammar had none
  before) rather than a pure `grammar.js` change.
  ```vb
  Foo(
      a, b)
  ```
- **`New Type(args)` constructor calls** (`New SqlConnection(connStr)`, `New Exception("msg")`)
  produced `ERROR`, and parameterless `New Type()` silently misparsed as an array type — VB.NET
  reuses parens for both array-rank markers and call arguments. Fixed together with the other side
  of the same ambiguity: **array creation via `New`** (`New Integer(2) {1, 2, 3}`) had no grammar
  support at all. Resolved with three structurally-exclusive `new_expression` shapes (constructor
  call / array creation / anonymous-type initializer) instead of a conflict/precedence hack — the
  bare trailing `{...}` with no `With` is the real disambiguator, matching VB.NET's own spec.
  ```vb
  Dim conn = New SqlConnection(connStr)
  Dim arr = New Integer(2) {1, 2, 3}
  ```

## Packaging fixes

- **Broken native binding, crashes on load.** `tree-sitter.json`'s grammar name was already
  double-prefixed (`tree_sitter_vb_dotnet`) while `grammar.js` correctly uses `vb_dotnet`, so
  `bindings/node/binding.cc` (scaffolded from the wrong name) called a symbol `parser.c` never
  actually exports. One-off scaffolding mistake — confirmed `tree-sitter-kotlin`/`tree-sitter-dart`
  in this monorepo don't have it.
- **`peerDependencies.tree-sitter` mismatch** (`^0.25.0` vs. this package's own
  `devDependencies.tree-sitter: 0.21.1`), forcing `--legacy-peer-deps` on install. Fixed to match
  the pin and both sibling grammars' convention (`^0.21.1`).

## Known gap — investigated, accepted, not fixed

`ConsList(Of TypeSymbol).Empty` (a generic type used as a value, e.g. for a static member access)
still produces an `ERROR`. Two fix attempts were tried and reverted — both cascaded into new
grammar conflicts with `element_access`/`unary_expression`/`binary_expression` (see `progress.md`
for the full story).

Before leaving it open indefinitely, checked the actual blast radius for autotriage's purposes
(function-declaration and call extraction, no type inference): confirmed the `ERROR` never
cascades — every sibling statement, the enclosing function declaration, and every *call* around
the broken fragment (including one chained directly onto its result) still parse correctly. The
construct itself isn't a call at all, so it was never going to be tracked anyway. Marked `:skip` in
`known_gaps.txt` (a real corpus-test attribute, not a hack) rather than deleted, so the repro and
reasoning stay on record.

## Test plan

- [x] `tree-sitter generate --abi 14` — clean, no warnings
- [x] `tree-sitter test` — 30 passing, 0 failing
- [x] `npm install` (native rebuild via `node-gyp-build`) succeeds without `--legacy-peer-deps`
- [x] Fresh `npm pack` → clean `npm install` into an isolated temp project → loads via the Node
      binding directly and parses correctly (not just the CLI)
- [x] No regressions on `Dim x As Foo()`, `Dim m As Integer(,)`, `Dim g As List(Of Integer)`,
      `Dim ga As List(Of Integer)()`, bare `Do ... Loop`, `New With { Key .x = 1 }` (anonymous type)
- [x] Real-world benchmarking against `dotnet/roslyn`, at two points in the branch's history:
  - After the first several fixes (nested types, generics, `Inherits`/`Implements`): affected-file
    count (files where `extractAllFunctionDeclarations()` misses ground-truth functions) dropped
    299 → 163 out of 1195 sampled files (`progress.md`'s "Benchmark results" section has the
    cascade/scattered-miss breakdown).
  - After the `New Type(...)`/array-creation fix specifically: a separate before/after sweep over
    3807 `.vb` files (benchmark samples + all of `dotnet/roslyn`) found 167 newly-clean files and
    0 newly-broken ones.
  - These are two different, non-cumulative measurements taken at different points, not a single
    final number for all 10 fixes combined — a fresh end-to-end re-run would be needed for that.

## Note for reviewers / downstream consumers

Two of the fixes change node shapes:
- `New Foo()` now yields `argument_list` where it previously (incorrectly) yielded `array_type` +
  `array_rank_specifier`.
- `new_expression` gained a new possible child, `array_literal` (for genuine array creation).

**autotriage's `src/langs/vb/` extraction code should be checked against these shapes** (and
rebuilt via `npm install` to pick up the new native binding) before adopting this package there —
it may have been written against the old, incorrect shape.
