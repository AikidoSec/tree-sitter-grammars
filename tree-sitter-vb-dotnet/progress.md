# VB.NET grammar: corpus tests + first fixed gap

## Summary

`tree-sitter-vb-dotnet` had no `test/corpus/` (unlike `tree-sitter-kotlin`/`tree-sitter-dart`), so
none of its known parsing gaps were tracked as regression tests. This PR:

1. Adds `test/corpus/` with a baseline suite covering syntax the grammar already handles correctly.
2. Ports the known grammar gaps found while benchmarking autotriage's VB.NET call-tracing (see
   `autotriage`'s `src/langs/vb/vb-parser-breaks.md` and `src/langs/Vb.test.ts`) into
   `test/corpus/known_gaps.txt` as intentionally-failing tests, so each gap has a minimal repro
   pinned in the grammar repo itself.
3. Fixes fourteen of those gaps:
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
   - Preprocessor directives (`#If`/`#Else`/`#End If`, `#Region`/`#End Region`, ...) had no valid
     production at member level (class/module/structure/interface body) — only inside statement
     lists (method bodies) — so wrapping alternate member declarations (e.g. two method overloads
     behind `#If ... Then` / `#Else`) misparsed as `ERROR`. Found while investigating a residual
     cascade in `DefinitelyAssignedWalker.vb` during autotriage benchmarking, not from
     `vb-parser-breaks.md` (not previously documented there).
   - Any identifier starting with the 3 letters `Rem` (case-insensitive) — `RemoveHandlerFoo`,
     `Reminder`, `Remote`, ... — got swallowed into a `REM`-style comment along with the rest of the
     physical line. Found while re-testing `RemoveHandler`-adjacent identifiers; turned out to have
     nothing to do with the `RemoveHandler` keyword at all.
   - A leading comment as a file's first line, followed by `Imports` (with or without a blank line
     between) — the near-universal license-header shape in real VB.NET codebases — misparsed as
     `ERROR`. `source_file` had no way to consume a stray terminator before `option_statements`/
     `imports_statement`; already documented as `vb-parser-breaks.md` #34 ("cosmetic only, N/A") but
     that assessment undersold it badly, since a comment (an invisible lexer "extra") leaves its
     terminator stranded there too, not just a literal blank first line.
   - **VB's implicit line continuation** (`vb-parser-breaks.md` #23/#24/#25) — a line break after
     `(`/`,`/most operators inside an unclosed grouping (multi-line argument lists, multi-line
     `New With {}` object initializers) was misparsed as a statement terminator. This is the first
     fix in this branch needing an external scanner (`src/scanner.c`, new — this grammar had none
     before) rather than a pure `grammar.js` change; see its own section below for how it works.
   - **`New Type(args)` constructor calls** (`New SqlConnection(connStr)`, `New Exception("msg")`,
     `New Point(x, y)`) produced `ERROR`, and parameterless `New Type()` silently misparsed as
     `array_type` + empty rank — VB.NET reuses parens for both array-rank markers and call
     arguments, and `new_expression` reused the general-purpose `type` rule (which ends in an
     optional `array_rank_specifier`) right before its own `argument_list`. **And the other side of
     the same ambiguity**: genuine array creation `New Integer(2) {1, 2, 3}` had no grammar support
     at all, silently reading `(2)` as a bogus constructor argument and `{1, 2, 3}` as
     `object_initializers`. Fixed together, since the disambiguator is the bare trailing `{…}`.

## What changed

### Corpus tests (`test/corpus/`)

- `declarations.txt` (14 tests), `statements.txt` (16 tests, incl. the `Do`-prefix fix, the
  generic-call fix, the 2-arg `If` fix, the `Rem`-prefix fix, a baseline `REM`-comment test, the
  3 multi-line continuation fixes, and the 3 `New` constructor-call/array-creation fixes) — baseline
  coverage: modules, classes, interfaces, structures,
  properties (auto + get/set), if/select/for/while/try, nested classes, generic class/method
  declarations, generic field/return types, generic method calls, 2-arg `If`, separate-line
  `Inherits`/`Implements`, member-level preprocessor directives, comments, a leading comment before
  `Imports`, multi-line argument lists and object initializers, `New Type(args)` constructor calls
  and `New T(n) {…}` array creation. All pass; this is what proves the
  corpus-test plumbing works end to end (CI already runs `tree-sitter test` per grammar folder via
  `.github/workflows/test.yml`).
- `known_gaps.txt` (1 test) — known bugs, each pinned with `(source_file)` as a deliberately-wrong
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
  - ~~**Constructor call with arguments misparsed as array type** and **array creation via `New`
    with a size and initializer**~~ — two paired gaps, opposite sides of the same ambiguity
    (VB.NET reuses parens for both array-rank markers and call arguments). **Both now fixed** and
    moved into `statements.txt`; see "Follow-up investigation: `New Type(...)` constructor calls"
    below for the original writeup and "Grammar fix: `New Type(args)` constructor calls and
    `New T(n) {…}` array creation" for the fix.

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

### Grammar fix: preprocessor directives at member level (`grammar.js`)

Found while re-running the autotriage benchmark after packaging the fixes above: a residual
cascade in `DefinitelyAssignedWalker.vb:65`, at a `#If REFERENCE_STATE Then ... #Else ... #End If`
wrapping two overload signatures of the same method. Didn't reproduce in isolation at first (same
"compound trigger" symptom the generic-constructor gap had) — turned out isolation just needed the
right shape: two member declarations (not statements) inside the `#If`/`#Else` branches, not inside
a method body.

Root cause: `preprocessor_directive` (`#` + rest of line, one opaque token — no distinction between
`#If`/`#Else`/`#End If`/`#Region`/`#Const`/etc.) was only listed as a `statement` alternative (valid
inside method bodies), never as a `_member_declaration` alternative (valid directly inside a
class/module/structure/interface body). So a `#If`/`#Else`/`#End If` wrapping two *member*
declarations — the actual pattern real code uses to conditionally compile alternate method
overloads — had no valid production at that level, even though the exact same directive works fine
one level down inside a method. Same "where can this appear" category as the nested-type-declaration
and `Inherits`/`Implements` fixes; not documented in `vb-parser-breaks.md` at all (a new finding, not
a previously-known gap).

Fix: add `$.preprocessor_directive` to `_member_declaration`. Since it's a single opaque line-token
starting with `#` — a prefix no other member-declaration alternative starts with — this needed no
conflict declaration; clean regenerate. Covers every preprocessor directive kind at member level in
one fix, not just `#If`/`#Else`.

Verified:
- The real trigger's shape (two `Sub` overloads behind `#If ... Then` / `#Else` / `#End If`) — zero
  `ERROR`, both method declarations found correctly on either side of the directives.
- `#Region "Fields"` / `#End Region` wrapping a field declaration — zero `ERROR`.
- `#If DEBUG Then` / `#End If` inside a method body (the pre-existing, already-working
  statement-level case) — still zero `ERROR`, confirming no regression there.
- No regressions: full corpus suite unaffected elsewhere.

### Grammar fix: `Rem`-prefixed identifiers swallowed as `REM` comments (`grammar.js`)

Found while re-testing `RemoveHandler`-adjacent identifiers after the packaging fixes: `RemoveFoo`,
`Removed`, `Reminder`, `Remote`, `Remainder`, ... — any identifier starting with the 3 letters `Rem`
(case-insensitive) — got swallowed into a comment along with the rest of the physical line. Turned
out to have nothing to do with `RemoveHandler`/`AddHandler` at all, despite the superficial
resemblance to the `Do`-prefix bug we fixed earlier in this branch.

Root cause is the *opposite* mechanism from the `Do`-prefix bug. That one was precedence beating
length (a *shorter* keyword artificially winning over a *longer* identifier via a forced `prec()`
boost we'd added). Here, `comment`'s `REM` alternative was `seq(kw('REM'), /[^\r\n]*/)` — the
trailing `/[^\r\n]*/` greedily consumes the *entire rest of the line*, unbounded. For
`Dim Removed As Integer`, the token `Rem` + `oved As Integer` (18+ chars) is genuinely *longer* than
the identifier `Removed` (7 chars) alone — longest-match correctly, mechanically prefers the
comment; no precedence trick involved or exploitable. `AddHandler`-adjacent identifiers were never
affected because they don't happen to start with `rem`.

Fix: require a whitespace separator between `REM` and any trailing text —
`seq(kw('REM'), optional(seq(/[ \t]/, /[^\r\n]*/)))`. For `Removed`, after matching `Rem` the next
character is `o` (not whitespace), so the optional tail doesn't match at all and the comment
alternative is bounded to just 3 characters — now genuinely shorter than the 7-character identifier,
so longest-match naturally prefers `Removed` as an identifier. For real `REM this is a comment`, the
space after `REM` lets the optional tail match as before, no change in behavior.

Verified:
- `RemoveHandlerFoo`, `Removed`, `Reminder`, `Remote`, `Remainder` (as variable names, method names)
  — all zero `ERROR`, confirming the fix is about the `Rem` prefix generally, not specific to
  `RemoveHandler`.
- `REM this is a comment` (with content) and bare `REM` alone on a line (no content) — both still
  parse as a valid `comment` node, no regression on genuine `REM` comments.
- No regressions: full corpus suite unaffected elsewhere.

### Grammar fix: leading comment before `Imports` (`grammar.js`)

Found via a fresh autotriage benchmark re-run after packaging the fixes above — a minimal 4-line
repro: a comment as a file's very first line, followed directly by `Imports` (with or without a
blank line between). This is the near-universal license-header shape in real VB.NET codebases —
every Roslyn source file starts with exactly this pattern (a multi-line license comment, then a
block of `Imports`) — so despite showing a smaller aggregate miss count than the earlier fixes (it's
often a partial, not total, cascade), the *reach* across real-world files is likely larger than
everything fixed so far combined.

This is `vb-parser-breaks.md` #34 ("Leading blank line before `Imports`"), already documented but
marked "cosmetic only, N/A" for a workaround — that assessment undersold it: `comment` is a lexer
"extra" (matched anywhere, invisible to the grammar), but the *newline terminating* a comment-only
line is a real, meaningful `_terminator` token that still needs a rule to consume it. `source_file`
had `repeat(alias($._terminator, $.blank_line))` *after* `option_statements`/`imports_statement`,
but nothing *before* them — so a leading comment (or a literal blank first line, no comment needed)
left its terminator with no valid production, misparsing as `ERROR` right before the first
`imports_statement`.

Fix: add `repeat(alias($._terminator, $.blank_line))` at the very start of `source_file`, before
`option_statements`. This creates a genuine ambiguity with the *existing* trailing repeat when
`option_statements`/`imports_statement` are both absent (either repeat could consume the same
terminator) — resolved with a `[$.source_file]` conflict declaration, clean regenerate.

Verified:
- The exact reported repro (`' a comment` / `Imports System` / `Namespace Foo` / `End Namespace`)
  — zero `ERROR`.
- A literal blank first line (no comment) before `Imports` — zero `ERROR`, confirming this is the
  same root cause as #34, not a comment-specific variant.
- A comment directly before `Imports` with no blank line between — zero `ERROR`.
- A realistic 3-line Roslyn-style license header + blank line + two `Imports` + `Namespace` — zero
  `ERROR`.
- No regressions: full corpus suite unaffected elsewhere.

### Grammar fix: implicit line continuation inside brackets (`grammar.js`, `src/scanner.c` — new)

Re-checked `vb-parser-breaks.md`'s multi-line family (#23/#24/#25) against the current grammar,
added corpus tests, and — unlike every other gap in this branch — actually needed an **external
scanner** (`src/scanner.c`, new file; this grammar had none before) rather than a pure `grammar.js`
change. This is the first fix in this branch that isn't just a rule tweak.

**Investigation first.** Read `tree-sitter-python`'s and `tree-sitter-ruby`'s external scanners
(both suggested as the closest precedent) to scope the work before touching code:
- Ruby's scanner is mostly irrelevant here — it's built for heredocs/string-interpolation/
  percent-literals, a different problem than bracket-depth continuation.
- Python's scanner does *not* maintain a manual bracket-depth counter for this. It declares the
  closing brackets (`')'`, `']'`, `'}'` — the *same* literal tokens already used everywhere else in
  the grammar) as `externals`, purely so the scanner can read `valid_symbols[CLOSE_PAREN]` etc. —
  tree-sitter's own signal for "the parser's current state would accept this token next," which
  already reflects nesting depth via the LR state stack. The scanner never matches those brackets
  itself (always declines, letting the normal lexer handle the literal); declaring them external is
  only to make them visible in `valid_symbols`.
- Neither project unit-tests the scanner C code separately — both have only `test/corpus` (the same
  mechanism used throughout this repo) plus `test/highlight`/`test/tags` for query tests unrelated
  to parsing.

**First attempt (wrong) and why:** tried mirroring the "compute `within_brackets`, then skip
newline characters in a loop and `return false`" shape literally. Empirically (verified with a call
counter + logged position in the scanner) this doesn't work: returning `false` from
`scan()` fully rolls back *all* consumption from that call, skip-marked or not — the next
invocation starts at the exact same position with the exact same lookahead. A scanner cannot
"silently swallow trivia and decline" this way; declining always means declining from the original
position.

**What actually makes Python's approach work:** its `extras` array includes a bare whitespace regex
that explicitly matches `\r?\n` — newlines are *unconditionally* extras, absorbable anywhere,
completely independently of the scanner. The scanner's only job is to *win the race*: when
`valid_symbols[NEWLINE]` is true (the grammar structurally expects a real terminator there), the
external scanner gets first refusal and explicitly produces it, which takes priority over treating
the character as a mere extra. When `NEWLINE` isn't a valid symbol (already false inside argument
lists, object initializers, etc., since none of those rules reference `_terminator` at all), the
scanner declines and the plain extras-based absorption handles it — no bracket-depth tracking
needed in the scanner whatsoever, and (for VB's specific need — continuation, not
indentation/heredocs) no `CLOSE_PAREN`/`CLOSE_BRACE` externals needed either, unlike Python's.

**Fix:**
- `grammar.js`: made `$._newline` external (moved out of `rules`, into `externals`); added a bare
  `/\r?\n/` to `extras`.
- `src/scanner.c` (new, ~40 lines of real logic): `scan()` checks `valid_symbols[NEWLINE]`; if
  false, declines immediately. If true and the lookahead is `\r?\n`, consumes it and returns the
  `NEWLINE` token. That's the entire mechanism.
- No build-file changes needed — `binding.gyp`/`CMakeLists.txt` already conditionally compile
  `src/scanner.c` if present (standard tree-sitter boilerplate, already there for the sibling
  `tree-sitter-kotlin`/`tree-sitter-dart` grammars in this monorepo).

Verified:
- All three corpus repros (multi-line argument list, multi-line `New With {}`, multi-line
  anonymous type with `Key`) — zero `ERROR`, moved from `known_gaps.txt` into `statements.txt`.
- A synthetic Roslyn-shaped multi-line method signature + multi-line `With {}` object initializer
  together in one file — zero `ERROR`.
- Multiple blank lines *outside* brackets still produce real `blank_line` nodes (no regression on
  the existing "where can this appear" fixes from earlier in this branch).
- CRLF line endings inside a multi-line bracketed construct — zero `ERROR`.
- Full corpus suite unaffected elsewhere (including the `Imports`-leading-comment fix, which also
  depends on `_newline`/blank-line handling).

### Grammar fix: `New Type(args)` constructor calls and `New T(n) {…}` array creation (`grammar.js`)

Fixes both halves of the "Follow-up investigation: `New Type(...)` constructor calls" section below
— they're one ambiguity seen from two sides, and neither could be fixed without the other.

**Root cause.** `type`'s bare-`namespace_name` alternative ends in `optional($.array_rank_specifier)`
(needed for legitimate array-type declarations like `Dim x As Foo()`), and `new_expression` reused
that same general-purpose `type` rule, immediately followed by its own separate
`optional($.argument_list)`. Both want the same `(`. On `New SqlConnection(connStr)` the parser
committed to `array_rank_specifier` (comma-only body) and kept the `ERROR`-laden attempt; on
`New Foo()` the comma-only body matched trivially, so it "succeeded" as `array_type` + rank with no
`ERROR` at all. Separately, `new_expression`'s trailing clause was only
`choice($.object_initializers, $.with_initializer)` with no `$.array_literal`, so array creation had
nowhere to go and its `{1, 2, 3}` landed in `object_initializers`.

**Fix — structurally exclusive rule shapes, not precedence/conflict heuristics.** Split
`new_expression` into three alternatives that can't overlap, and gave it its own narrower type rule:
- `_new_type: choice($.primitive_type, alias($._new_generic_type, $.generic_type), $.namespace_name)`
  — deliberately *no* `array_rank_specifier` and *no* `array_type`, because after `New` a
  parenthesised group is always arguments or array bounds, never a rank marker. Aliased to `$.type`
  at the use site so the `type:` field keeps its existing node name in consumers' trees.
- `New t [args] [With {…}]` — plain constructor call; `argument_list` now unambiguously owns the
  parens.
- `New t args {…}` — array creation; both the parens (bounds) and the trailing `array_literal` are
  mandatory, so the bare `{…}`-with-no-`With` is the disambiguator, exactly as the VB.NET spec
  implies. This is what makes `New Integer(2) {1, 2, 3}` distinguishable from a constructor call
  with no semantic/type information.
- `New t {…}` — the parens-less form, kept so the existing anonymous-type parse
  (`New With { Key .x = 1 }`) still resolves to `object_initializers` unchanged.

**Two dead ends on the way there, both worth recording:**
- Copying `generic_type`'s `prec.left(3, …)` onto `_new_generic_type` (the obvious move, since
  `generic_type` is the alternative that already handled `New List(Of Integer)()` correctly)
  *generated cleanly but broke every plain constructor call*: with `New Foo` on the stack and `(`
  ahead, the precedence made the parser always **shift** into `type_argument_list`, which then
  demands `Of` and fails. The reduce-vs-shift choice there genuinely needs two tokens of lookahead
  (`Of` or not), so it must stay a real GLR conflict — `prec` can only pick one branch statically,
  and either static pick is wrong half the time. Dropping the `prec` and declaring
  `[$._new_type, $._new_generic_type]` instead is what actually works.
- The pre-existing `[$.new_expression]` / `[$.type, $.array_type]` conflict declarations were never
  sufficient on their own (already noted in the investigation below, re-confirmed here). Declaring a
  conflict only lets the parser *explore* both branches; it doesn't help when both branches are
  viable expansions of the *same* rule shape. Making the shapes mutually exclusive is what removed
  the ambiguity — the conflict declaration then only has to cover the genuine 2-token lookahead.

Verified:
- Both gap repros (`New SqlConnection(connStr)`, `New Integer(2) {1, 2, 3}`) — zero `ERROR`, and the
  array case now yields `argument_list` + `array_literal` rather than a bogus constructor argument +
  `object_initializers`. Moved out of `known_gaps.txt` into `statements.txt`, widened to cover
  `New Exception("msg")`, `New Point(x, y)`, `New System.Text.StringBuilder(100)`,
  `New StringBuilder()`, `New List(Of Integer)()`, `New Dictionary(Of String, Integer)(cmp)`,
  `New Integer() {1, 2, 3}`, `New String(9) {}`, `New Integer(1, 2) {}`.
- The existing "Multi-line `New With {}` object initializer" test now parses `New OrderViewModel()`
  as `namespace_name` + `argument_list` instead of `array_type` + empty `array_rank_specifier` —
  its pinned tree was pinning the *bug*, so it was re-pinned with `tree-sitter test -u`.
- No regressions: `Dim x As Foo()`, `Dim m As Integer(,)`, `Dim g As List(Of Integer)`,
  `Dim ga As List(Of Integer)()` all still parse as array/generic types; "Multi-line anonymous type
  with `Key` properties" unchanged; full corpus suite green except the one unrelated remaining gap
  (`ConsList(Of TypeSymbol).Empty`).
- **Corpus-wide before/after over all 3807 `.vb` files in `autotriage`** (benchmark samples +
  `dotnet/roslyn`): files containing an `ERROR`/`MISSING` node dropped 3277 → 3110 — **167 files
  newly parse completely clean, zero newly broken**. Of the 291 files whose first-error position
  moved, 290 moved *later* in the file (the `New` error was masking a later one). The single
  outlier, `EmitTestStrongNameProvider.vb`, was checked by hand: its `New Foo(args) With {…}` now
  parses fine and the reported error simply becomes the pre-existing, unrelated lambda-with-
  `As <ReturnType>` gap a line further down, which recovers over a wider span.
- Two errors surfaced by the smoke sweep were confirmed **pre-existing and out of scope** by
  re-generating the parser from `HEAD:grammar.js` and re-parsing: `New List(Of String) From {"a"}`
  (no `From` collection-initializer support anywhere in the grammar) and
  `Dim arr2() As Integer = {1, 2, 3}` (`dim_statement` has no `array_rank_specifier` after the name,
  unlike `variable_declarator`). Identical `ERROR` positions before and after.

**What this doesn't cover:** VB's implicit continuation is broader than "inside brackets" — a break
after a trailing operator/comma/`.` with *no* enclosing brackets at all (e.g. `Dim x = a +\n b`) is
a different mechanism (needs "what was the last significant token," not just `valid_symbols`), and
none of the documented gaps needed it, so it wasn't attempted.

**Other findings from this investigation, not part of this fix:**
- **#26 (`New With { var }` key inference) is stale** — `New With { returnUrl, model.RememberMe }`
  already parses with zero `ERROR` (confirmed `object_initializer` already has a bare-`expression`
  alternative alongside the `.Prop = val` one).
- **#31 (`With` block member access) is a *different* root cause**, not part of the multi-line
  family despite superficially involving newlines: `with_statement`'s body is `repeat($.statement)`,
  and there's no grammar support anywhere for a leading-dot implicit-target member access
  (`.Name = "test"`, referring to the enclosing `With` target) as an assignment statement —
  `member_access`'s `object` field is required, not optional. `object_initializer` *does* have its
  own dedicated leading-dot rule (`seq('.', $.identifier, '=', $.expression)`, `grammar.js:814`),
  which is why `New Foo() With { .Prop = val }` works fine but a `With` block's body doesn't; that
  rule isn't reachable from `statement`. Not added to `known_gaps.txt` yet.
- **`Key` in an anonymous type initializer is silently mis-parsed**, even on a single line —
  `Key .status = "ok"` reads as `member_access(object: identifier "Key", member: "status")`, i.e.
  `Key` is swallowed as if it were a variable name, not recognized as the `Key` modifier at all.
- None of `Key`/`With`-as-fake-typename produce `ERROR` nodes, so neither surfaces via
  cascade/miss-count analysis, and neither is prioritized right now — noted for completeness. (The
  related `New Type(...)` constructor-call finding below is a different story — it's now scoped
  and tracked as its own gap, not just a note.)

### Follow-up investigation: `New Type(...)` constructor calls (`known_gaps.txt`)

Found while auto-generating the multi-line `New With {}` corpus test: `New OrderViewModel()`
parsed "successfully" (no `ERROR`) as `array_type` + empty `array_rank_specifier`, not a
parameterless constructor call. Scoped this further before assuming it was a narrow, parens-only
edge case — it's much broader:

- **`New Type()` (no arguments)** — silently misparses as `array_type`, no `ERROR` at all.
  Confirmed on `New StringBuilder()`, `New Random()`, `New Object()`, and the original
  `New OrderViewModel()`. This is genuinely wrong (parameterless constructor calls are one of the
  most common expressions in any codebase) but invisible to cascade/miss-count analysis.
- **`New Type(args)` where `args` isn't purely commas** — a real `ERROR`. Confirmed on
  `New SqlConnection(connStr)`, `New Exception("msg")`, `New Point(x, y)` — all extremely common,
  everyday patterns (exception construction, ADO.NET connections, simple value objects). The parser
  commits to matching the parenthesized content as `array_rank_specifier` (which only accepts
  commas — a rank/dimension marker like `Foo()`/`Foo(,)`, never an expression), and when that fails
  it keeps the `ERROR`-laden attempt rather than falling back to leaving the parens for
  `new_expression`'s own `argument_list`.
- **Root cause**: `type`'s bare-`namespace_name` alternative has an optional trailing
  `array_rank_specifier` (needed for legitimate array-type declarations like `Dim x As Foo()`), and
  it's reused as-is for `new_expression`'s `field('type', $.type)`, immediately followed by
  `new_expression`'s own separate `optional($.argument_list)`. Both want the same `(`.
- **Why this isn't a quick fix**: `[$.new_expression]` and `[$.type, $.array_type]` are *already*
  declared conflicts — the grammar already acknowledges this ambiguity and still resolves to the
  wrong branch. Tried giving the bare-`namespace_name` alternative the same `prec.left(3, ...)`
  `generic_type` has (since `generic_type` *does* correctly defer to `argument_list` in the
  equivalent `New List(Of Integer)()` case) — that just moved the conflict to `type` vs
  `generic_type` instead of fixing this one. Likely needs a dedicated, narrower type-reference rule
  for `new_expression`'s `type` field (excluding the array-rank alternative) rather than reusing the
  general-purpose `type` rule, or a real GLR fix distinguishing "this parenthesized content is pure
  commas" from "it isn't" before committing.
- Added as `[gap] constructor call with arguments misparsed as array type` in `known_gaps.txt`
  (using `New SqlConnection(connStr)` — unambiguous intent, no `With` clause needed to trigger it).
  Likely the single highest real-world blast radius of any gap found in this branch, including the
  ones already fixed — object construction via `New Type(...)` is about as fundamental as VB.NET
  syntax gets.
- **The other side of the same coin**: genuine VB.NET array-creation-via-`New` (`New ElementType
  (bound) {initializer}` — a trailing array literal, even empty `{}`, is what syntactically signals
  "this is array creation", not a constructor call — no semantic/type info needed) has *no* grammar
  support at all today, confirmed unrelated to Python/Ruby (checked both — neither has this
  ambiguity in the first place, since neither overloads parens for both array-rank markers and call
  arguments the way VB.NET does; that's a BASIC-ism specific to VB). `new_expression`'s trailing
  clause is only `choice($.object_initializers, $.with_initializer)` (both require `With`) — no
  `$.array_literal` alternative, even though `array_literal` already exists as a rule. Given
  `New Integer(2) {1, 2, 3}`: no `ERROR`, but silently wrong — `(2)` gets swallowed as a bogus
  constructor argument to `Integer` (which has no such constructor), and `{1, 2, 3}` gets misread
  as `object_initializers` instead of an `array_literal`. Added as
  `[gap] array creation via New with a size and initializer` in `known_gaps.txt`, right next to the
  constructor-call gap — fixing both together should use "is there a bare trailing `{}` with no
  preceding `With`" as the real disambiguator between the two meanings, rather than resolving the
  ambiguity via conflicts/precedence.

## Verification

```
tree-sitter generate --abi 14   # clean, no warnings
tree-sitter test                # 27 passing, 1 known gap (intentionally failing)
```

## Also fixed in this branch (housekeeping, no behavior change)

- `binary_expression`'s unnecessary single-element `choice(...)` wrappers (`choice('^')`,
  `choice(kw('TypeOf'))`) — removed the "unnecessary `seq`/`choice`" generate warning.
- Two stale `conflicts` entries (`[$.type, $.invocation]`, `[$.type]`) that no longer correspond
  to any real grammar ambiguity — removed the "unnecessary conflicts" generate warning.
- Both confirmed byte-identical `parser.c`/`node-types.json` output before/after, i.e. purely
  cosmetic.

### Packaging bug: broken native binding, found while testing the packed tarball

Testing `npm pack` output installed into `autotriage` surfaced a **pre-existing** packaging bug,
unrelated to any grammar change in this branch: the native Node binding crashed on load.

Root cause: `tree-sitter.json`'s grammar `name` was `"tree_sitter_vb_dotnet"` — already
double-prefixed — while `grammar.js`'s own `name` is correctly `'vb_dotnet'`. Every artifact
scaffolded *from* `tree-sitter.json` (via `tree-sitter init`) inherited the double prefix —
`bindings/node/binding.cc` declared `extern "C" TSLanguage *tree_sitter_tree_sitter_vb_dotnet()`,
`binding.gyp`'s `target_name`, the NAPI module name — but `parser.c` (generated from `grammar.js`,
the correct single-prefixed name) only ever exported `tree_sitter_vb_dotnet()`. `binding.cc` called
a symbol that was never actually generated, so the native module either failed to link or crashed at
load, depending on the toolchain. Confirmed `tree-sitter-kotlin`/`tree-sitter-dart` in this monorepo
don't have this bug — both consistently use their real name (`"kotlin"`, `"dart"`) everywhere; this
was a one-off scaffolding mistake specific to `tree-sitter-vb-dotnet`, likely from whoever ran
`tree-sitter init` initially entering `tree_sitter_vb_dotnet` as the project name without realizing
the tool always auto-prepends `tree_sitter_` itself.

Also found and fixed while testing the tarball: `peerDependencies.tree-sitter` was `^0.25.0`, while
this package's own `devDependencies.tree-sitter` pins `0.21.1` — a real mismatch (not something
intentionally different from upstream) that forced `--legacy-peer-deps` on install. Both sibling
grammars pin `peerDependencies.tree-sitter` to `^0.21.1`, matching their own `devDependencies` — vb
dotnet's `^0.25.0` didn't match that convention or its own pin. Fixed to `^0.21.1` to match.

Fix: corrected `tree-sitter.json`'s `name`/`camelcase`/`title`/`scope`/`file-types`/
`injection-regex`/`class-name` to consistently use `vb_dotnet` (also fixed the metadata
`links.repository`, which pointed at a nonexistent placeholder URL from the same scaffolding
mistake, to the real `CodeAnt-AI/tree-sitter-vb-dotnet` upstream), then regenerated the Node
bindings via the documented flow (`npm run clean:node && npm run init && npm run generate &&
npm run generate:nodeTypes`) — confirmed `package.json`'s scripts/dependencies were untouched by
that regenerate (diffed before/after), only `binding.gyp`, `bindings/node/binding.cc`,
`bindings/node/index.js`, and `nodes.ts` changed. Fixed the peer dependency version separately.

`nodes.ts` also picked up two TypeScript type updates we'd missed regenerating after earlier
commits in this branch (`typeArgumentsNode` on `InvocationNode` from the generic-call fix,
nullable `falseBranchNode` on `TernaryExpressionNode` from the 2-arg `If` fix) — unrelated to the
packaging bug, just stale from not re-running `generate:nodeTypes` after those grammar changes.

Verified:
- `npm install` (triggering the `install` script, `node-gyp-build`) builds cleanly from source, no
  prebuilt binaries needed.
- Loaded and parsed successfully via the Node binding directly (not just the CLI).
- Fresh `npm pack` → installed into an isolated temp project with a clean `npm install` (no
  `--legacy-peer-deps`) → loaded and parsed `Inherits`/`Implements` correctly. This confirms the fix
  from a genuinely clean install, not just leftover local build state.
- Full corpus suite (`tree-sitter test`) and the bundled `test/test.js` sanity script both still
  pass, unaffected by any of this.

## Next steps

- Port `vb-parser-breaks.md` gap #2 (`Select`-prefix identifiers) as a corpus test in
  `statements.txt` — likely already fixed by the `Do`-prefix change, needs verification.
- Re-verify `vb-parser-breaks.md` #18/#19/#20/#21 against the current grammar now that #17's actual
  behavior didn't match the doc — the doc may need a broader refresh, not just new corpus tests.
- Fix generic type as a value expression (`ConsList(Of TypeSymbol).Empty`) — see "Attempted and
  reverted" above for what doesn't work; needs a structurally different approach than the other
  fixes in this branch.
- `vb-parser-breaks.md` #31 (`With` block member access) — confirmed a *different* root cause from
  the multi-line family (no grammar support for leading-dot implicit-target member access as a
  statement); not yet added as a corpus test or attempted.
- Extend implicit line continuation beyond brackets — a break after a trailing operator/comma/`.`
  with *no* enclosing brackets (e.g. `Dim x = a +\n b`) isn't covered by the fix in this branch and
  would need a different mechanism ("what was the last significant token," not `valid_symbols`).
  Not attempted since no documented gap needed it.
- `vb-parser-breaks.md` #26 is stale (already fixed/never broken), and `Key` anonymous-type
  modifier plus `With` (in anonymous-type `New With { ... }`) are both silently mis-parsed as plain
  identifiers (no `ERROR`, low priority) — doc needs a refresh reflecting all of this, plus every
  other break this branch fixed that the doc still lists as broken (#1, #5-9, #12, #17, #20, #23-25,
  #34, ...).

## Benchmark results (re-run against `dotnet/roslyn` after this branch's fixes)

Affected-file count (files where `extractAllFunctionDeclarations()` misses ground-truth functions)
dropped from 299 → 163: 894 files clean, cascade files down from 185 → 60, scattered-miss files down
from 114 → 103, consistent with the nested-class and generic-collection-parameter bugs (the two
biggest, most-cascading root causes) being fixed. The preprocessor-directive fix in this commit was
found while characterizing one of the remaining 60 cascade files (`DefinitelyAssignedWalker.vb:65`);
the other cascade triggers in that remaining set haven't been characterized yet and may be a mix of
distinct new causes rather than tails of already-fixed ones — worth another characterization pass
before deciding whether to keep chasing individual cascade files or treat the current ~66% overall
rate as the checkpoint to report.
