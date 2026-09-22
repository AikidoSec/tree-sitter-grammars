# Fixing a tree-sitter grammar

A practical workflow for finding and fixing parsing gaps in any grammar in this repo
(`tree-sitter-vb-dotnet`, `tree-sitter-dart`, `tree-sitter-kotlin`, or a future one), distilled from
the session that added corpus tests and fixed 10 parsing gaps in `tree-sitter-vb-dotnet`
(see that grammar's `progress.md` for the full worked example this guide is based on).

The core idea: **each gap is small, isolated, and empirically verified** — you reproduce it
minimally, diagnose why the grammar is doing what it's doing, fix it, and prove it doesn't regress
anything, before moving to the next one. Resist the urge to fix five things at once; the gaps that
looked biggest at first often turned out to be two or three unrelated bugs wearing one costume.

## 0. Prerequisites

```bash
cd tree-sitter-<language>
npm install               # pulls devDependencies (tree-sitter-cli, etc.)
tree-sitter generate --abi 14
tree-sitter test           # confirms the existing corpus (if any) still passes
```

If `test/corpus/` doesn't exist yet for this grammar, that's step 1.

## 1. Set up corpus test infrastructure (if it doesn't exist yet)

Corpus tests are the *only* testing mechanism you need — checked this against
`tree-sitter-python` and `tree-sitter-ruby` upstream: neither unit-tests their scanner C code
separately, both rely entirely on `test/corpus/*.txt` (plus `test/highlight`/`test/tags` for query
tests, unrelated to parsing). Don't build anything more elaborate than that.

Split test files by convention used in this repo:

- **`declarations.txt` / `statements.txt`** (or similar, split however makes sense for the
  language) — a baseline suite of syntax the grammar *already* handles correctly. Write a handful
  of representative snippets covering the language's main constructs, then run:
  ```bash
  tree-sitter test -u
  ```
  `-u` auto-fills the expected S-expression from the current (hopefully correct) parse. This alone
  proves the corpus-test plumbing works end to end, and CI (`.github/workflows/test.yml` in this
  repo already runs `tree-sitter test` per grammar folder) picks it up with zero extra config.
- **`known_gaps.txt`** — known bugs, each pinned with a deliberately-wrong placeholder expected
  tree (`(source_file)` is the convention used here) so the test visibly fails until the grammar is
  fixed. See §5 for the full lifecycle of a gap test.

## 2. Find gaps worth fixing

Sources, roughly in order of how well-scoped the result tends to be:

- **A language-specific break list**, if one exists (e.g. `vb-parser-breaks.md` in `autotriage`).
  Treat it as a *lead*, not ground truth — re-verify every entry against the current grammar before
  trusting it. Several entries in that doc turned out to be stale (already fixed, or never actually
  broken) by the time they were re-checked.
- **Real-world corpus benchmarking.** If there's a way to run the grammar against a large body of
  real source (a benchmark harness, a comparison against a reference compiler's ground truth, or
  just cloning a big real-world repo in the language and running `tree-sitter parse` over every
  file), do it. This is how the highest-impact gaps in the VB.NET session were found — one wasn't
  in the break-list doc at all (member-level preprocessor directives), and another
  (`New Type(args)` constructor calls) turned out to affect far more real code than its original,
  narrower repro suggested.
- **Grep for `ERROR` count, don't stop at the first hit.** A single symptom can hide multiple
  independent root causes stacked in the same file — group failures by file, look at cascade vs.
  scattered patterns, and characterize a few examples by hand before assuming they're all the same
  bug.

## 3. Reproduce minimally — and watch for compound triggers

Before touching the grammar, get the *smallest* input that reproduces the bug, using
`tree-sitter parse <file>` (not the CLI's own file, use a scratch `.vb`/`.dart`/etc. file).

**The single most common mistake in this kind of work: assuming a real-world repro has one bug when
it actually has several, compounding.** In the VB.NET session, a giant real-world Roslyn file
looked like one nasty gap ("constructors with generic-collection parameters"); after isolating each
factor individually (attribute + `ByRef` + generic type + `Optional` defaults + generic field types
+ `Shared ReadOnly Property` + a 2-arg `If`), it turned out to be **six unrelated, independently
fixable gaps** that happened to co-occur in that one file. Isolate each suspicious token/construct
in its own tiny file before deciding how many bugs you're actually looking at:

```bash
printf 'Module M\n\tSub Main()\n\t\tFoo(\n\t\t\ta\n\t\t)\n\tEnd Sub\nEnd Module\n' > /tmp/t.vb
tree-sitter parse /tmp/t.vb
```

Conversely, don't over-split either — if a full real-world file parses clean end-to-end after a
fix, that's worth confirming directly (not just each isolated fragment individually), since some
bugs only manifest when several passing constructs are chained together.

## 4. Diagnose the root cause

Read the grammar rule involved (`grammar.js`) and the actual output of `tree-sitter parse`
side by side. In practice, every gap in the VB.NET session fell into one of these categories —
knowing which one you're looking at tells you how hard the fix will be:

### a) Missing "where can this appear" case (easy)

A construct has a rule, but that rule isn't listed as a valid alternative in the *container* that
should allow it. Example: `_member_declaration` (what's valid inside a class/module body) didn't
include `$.type_declaration`, so a nested class had nowhere to go. Fix: add it to the relevant
`choice(...)` list. Watch for a resulting "unresolved conflict" if the newly-added alternative
overlaps with something already reachable another way (in that case, a redundant
`$.delegate_declaration` entry had to be removed since `type_declaration` already covered it).

### b) Lexer precedence beating length (easy, but counter-intuitive)

If a keyword and a longer identifier sharing the same prefix collide (`Do` vs. `DoWork`), and the
keyword is wrapped in `token(prec(N, ...))`, check whether that precedence is *necessary*.
tree-sitter's lexer already prefers the longest match by default — a precedence boost only matters
for breaking *exact-length ties* (`Do` vs. a hypothetical identifier also spelled `Do`). If the
grammar's `kw()`-style helper applies that boost unconditionally, it can make a *shorter* keyword
incorrectly win over a *longer* identifier. Fix: remove the boost, verify the longest match now
wins, and verify the keyword still resolves correctly on an exact-length input (`Do` alone still
needs to parse as the keyword, not an identifier).

### c) Unbounded/greedy token beating length legitimately (easy once you spot it, easy to
   misdiagnose as (b))

Superficially identical symptom to (b) — an identifier gets swallowed by something keyword-shaped
— but a *different* mechanism: a token with a greedy, unbounded tail (e.g. a comment matching
`kw('REM') + /[^\r\n]*/`, consuming the rest of the line) is *genuinely longer* than the colliding
identifier for any input where they overlap, so removing a precedence boost won't help — there was
never a precedence issue. Fix: bound the greedy tail with a mandatory separator (e.g. require
whitespace between the keyword and its content) so it can only extend when a human actually
intended it as that construct.

### d) Ambiguity needing a real grammar restructure (moderate to hard)

Two rules can both start matching the same token sequence, and whichever one "wins" by default is
wrong in some contexts. A `conflicts: [...]` declaration alone often isn't enough — GLR forking
still needs *some* signal to prefer the right branch, and if neither branch produces an outright
parse failure (both "succeed", just one is semantically wrong), tree-sitter has no error signal to
break the tie by. Two techniques that work, in order of preference:

1. **Structurally exclusive rule shapes** — redesign the colliding rules so their *expansions*
   don't overlap at all, rather than relying on conflict resolution to pick between overlapping
   ones. This is how `New Type(args)` (constructor call) vs. `New Type(n) {...}` (array creation)
   was ultimately fixed: give the constructor-call path a type reference with no array-rank
   alternative at all, and make the array-creation path require a mandatory trailing array literal
   (the actual syntactic disambiguator the language itself uses) — so there's no shared prefix left
   to be ambiguous about. Look at how the *target* language's own spec disambiguates a case like
   this before inventing a heuristic; VB.NET's own answer (a trailing `{...}`) was directly
   transplantable into the grammar.
2. **A genuine GLR conflict declaration**, when the ambiguity truly can't be resolved until more
   tokens are seen (e.g. `New Foo(` — is a `(Of T)` type-argument list coming, or is this the
   constructor's argument list? Only knowable after the next token or two). Declare the conflict
   between the specific colliding rules and let GLR fork; don't add a static `prec()` guess here —
   a fixed precedence can only be right for one of the two cases, and picks wrong for the other one
   every time. (A `prec.left(3, ...)` copy-paste that looked like the obvious fix in this session
   broke *every* plain constructor call, exactly because of this.)

If you find yourself declaring a conflict and the parser *still* resolves to the wrong branch even
though the "right" branch would parse cleanly, that's a sign the ambiguity needs approach 1 instead
— conflicts alone don't guarantee GLR explores far enough to discover which branch is error-free
before committing.

### e) Missing feature needing an external scanner (hardest, but often smaller than it sounds)

Some things genuinely can't be expressed in pure `grammar.js` — anything context-sensitive at the
*character* level rather than the *token* level. VB's implicit line continuation (a newline inside
an unclosed paren/brace shouldn't terminate the statement) is the canonical example in this repo.

Before assuming this needs heavy bracket-depth tracking in C: read how a mature grammar for a
similar feature actually does it (`tree-sitter-python`'s scanner has exactly this problem solved).
The real mechanism there is almost always simpler than it looks from the outside:

- Newline-like tokens go in the grammar's `externals` array (so the *scanner*, not the internal
  DFA, controls whether one is produced).
- The **same literal token is also listed unconditionally in `extras`** — meaning by default it's
  just silently-absorbable trivia, exactly like whitespace, with zero involvement from the scanner.
- The scanner's only job is to *win the race*: check `valid_symbols[NEWLINE]` (tree-sitter tells you
  whether the grammar's current parser state would actually accept a real terminator token here —
  this is already `false` inside an argument list, since nothing in that rule references the
  terminator symbol). If it's valid, produce the real token (which takes priority over the extras
  fallback). If it's not, decline (`return false`) and let the extras-based absorption handle it —
  no manual bracket-counting needed.
- **Do not try to "skip trivia and then return false" as a mechanism for suppressing a token** —
  verified empirically in this session that returning `false` from `scan()` rolls back *all*
  consumption from that call, whether or not it was marked with the "skip" flag. If you want a
  character to become invisible to the grammar unconditionally, it has to be a real `extras` entry,
  not something the scanner tries to swallow and then disavow.
- Declaring closing brackets (`')'`, `'}'`) as externals *purely* to read `valid_symbols` on them
  (Python's approach, for its own indentation tracking) is a separate technique from the above and
  often isn't needed at all for a "just suppress the terminator" problem — check whether the
  simpler newline-only mechanism already covers your case before reaching for it.
- No build-file changes are needed to add a scanner — `binding.gyp`/`CMakeLists.txt` in this repo's
  grammar template already conditionally compile `src/scanner.c` if the file exists.

If the target language you're fixing doesn't have a close analog already solved by an established
grammar, this is the point to escalate to a stronger reasoning model (see §8) rather than
guess-and-check your way through GLR internals — the empirical-verification loop (hypothesis →
`tree-sitter generate` → `tree-sitter parse` → read the actual tree → repeat) is exactly the kind of
task where a model that reasons carefully about *why* an attempt failed, not just what to try next,
earns its cost.

## 5. Fix, verify, and land the corpus test

The lifecycle of one gap, start to finish:

1. Reproduce minimally (§3), confirm the exact `ERROR`/wrong-structure shape with
   `tree-sitter parse`.
2. Add it to `known_gaps.txt` *before* fixing, with a `(source_file)` placeholder and a `;`-prefixed
   comment block explaining the repro and root cause (S-expression comments start with `;`,
   confirmed safe inside the expected-tree section). This captures the finding even if the fix gets
   deferred or takes several attempts.
3. Edit `grammar.js`. Run:
   ```bash
   tree-sitter generate --abi 14
   ```
   If this reports an unresolved conflict, read the *exact* symbol sequence it prints — it usually
   tells you precisely which two rules need a `conflicts` entry (§4d), not just "conflicts exist".
4. `tree-sitter parse` the minimal repro again. Confirm zero `ERROR`/`MISSING` nodes.
5. **Only once the parse is genuinely clean**, run:
   ```bash
   tree-sitter test -u
   ```
   `-u` explicitly refuses to auto-fill a test whose actual output still contains `ERROR`/`MISSING`
   — don't fight this by hand-transcribing a broken tree; get the grammar fix right first.
6. Move the now-passing test out of `known_gaps.txt` into the baseline file it belongs in.
7. Run the *full* suite, not just the one test — `tree-sitter test` — to catch regressions in
   unrelated constructs. Specifically re-check anything structurally adjacent to what you touched
   (e.g. after touching array-type declarations, re-check plain array-type declarations still work,
   not just the constructor-call case you were fixing).
8. If you touched anything that affects the Node binding (not just the CLI-facing grammar), run
   `npm install` to rebuild the native addon via `node-gyp-build`, and sanity-check by loading the
   grammar through the actual `tree-sitter` Node package, not just `tree-sitter parse`.
9. Regenerate derived TypeScript types if this repo generates them for the grammar:
   ```bash
   npm run generate:nodeTypes
   ```
   Check `git diff nodes.ts` — if a fix added a new field or a new possible child node, this often
   needs re-running even when you didn't think you changed a "shape".

### The `:skip` escape hatch

Not every documented gap needs fixing right away, and some are worth investigating, documenting,
and then deliberately leaving alone (see §7). Corpus test files support a `:skip` attribute on the
line right after the test name:

```
================================================================================
Test name
:skip
================================================================================
<code>
--------------------------------------------------------------------------------
<expected — doesn't matter, never checked while skipped>
```

A skipped test shows as a distinct marker in `tree-sitter test` output and is **excluded from the
pass/fail totals entirely** — confirmed this gives exit code 0 with a skipped gap present. Use this
instead of deleting a known-bad repro once you've decided not to fix it: it keeps the finding on
record (with a comment explaining *why* it's accepted) rather than silently dropping it, while
keeping CI green.

## 6. Test the actual package, not just the grammar

A grammar fix that's correct in `tree-sitter parse`/`tree-sitter test` can still ship broken if the
*package* around it is wrong. Two real bugs found this way in the VB.NET session, worth checking
for on any grammar in this repo before calling a fix done:

- **Double-prefixed grammar name.** If `tree-sitter.json`'s grammar `name` doesn't exactly match
  `grammar.js`'s own `name` field, everything scaffolded from `tree-sitter.json` (via
  `tree-sitter init`) — `bindings/node/binding.cc`, `binding.gyp`'s `target_name`, the NAPI module
  name — ends up calling a symbol `parser.c` (generated from `grammar.js`) never actually exports.
  This crashes on load and is invisible to `tree-sitter test`/`tree-sitter parse`, since those don't
  go through the Node binding at all. Compare against a sibling grammar in this repo that's known to
  work (e.g. `grep -n '"name"' tree-sitter-kotlin/tree-sitter.json` vs. `grammar.js`) if unsure what
  "correct" looks like.
- **Peer dependency drift.** Check `package.json`'s `peerDependencies.tree-sitter` actually matches
  its own `devDependencies.tree-sitter` pin, and matches the convention other grammars in this repo
  use. A mismatch forces `--legacy-peer-deps` on every downstream install — easy to miss since
  `npm install` still "works" with that flag, just not cleanly.

To verify a fix survives real packaging, not just the CLI tools:

```bash
npm run generate && npm install   # regenerate + rebuild the native addon
npm pack                           # build the actual tarball that ships
# then, in a scratch directory:
npm init -y && npm install tree-sitter@<pinned-version>
npm install /path/to/the/packed.tgz   # no --legacy-peer-deps if the fix is real
node -e "require('tree-sitter-<lang>')"   # loads without crashing
```

Do this in a genuinely fresh directory/`node_modules`, not just re-using local build artifacts from
earlier in the session — a stale compiled `.node` binary can mask a fix that was actually reverted
from the source, or mask a packaging bug that only manifests on a truly clean install.

Per this repo's own `README.md`: **never touch a vendored package's `scripts`/`dependencies`
fields** beyond the 5 specifically documented ones — those need to survive future
`git subtree pull` merges from upstream cleanly. `grammar.js`, `src/*`, and `test/corpus/*` are
always fair game.

## 7. Decide what's actually worth fixing

Not every `ERROR` node is equally important, and not every silent (non-`ERROR`) misparse is
unimportant. Before spending more time on a gap (or deciding to leave it alone, per §5's `:skip`),
check its actual blast radius:

- **Does it cascade?** Parse the minimal repro *and* a realistic surrounding context (the gap
  embedded in a function, with sibling statements before and after). If the `ERROR` stays confined
  to the one broken sub-expression and everything around it — the enclosing declaration, sibling
  statements, any calls chained onto the result — still parses correctly, the practical impact is
  much smaller than the bare existence of an `ERROR` node suggests.
- **Is the broken construct actually something your consumer cares about?** A generic type used as
  a bare value for a static member access isn't a function call or a declaration; if your downstream
  use case only extracts call graphs and declarations, that gap may be genuinely safe to accept.
  Know what your consumer actually reads out of the tree before prioritizing by `ERROR` count alone.
- **Is a "no `ERROR`" result actually correct?** Some of the nastiest findings in this session had
  *zero* `ERROR` nodes and were still completely wrong (e.g. a parameterless constructor call
  silently misparsing as an array-type declaration). These don't show up if you're only grepping for
  `ERROR` — spot-check the actual tree shape for common, unremarkable-looking constructs
  occasionally, not just the ones you already suspect are broken.
- **How common is the pattern in real code, really?** A narrow-looking repro can turn out to affect
  a huge fraction of real files (or vice versa). If a corpus-wide sweep over real source is
  available, use it — this is how a fix initially scoped as "New Type() with a trailing With clause"
  turned out to also affect `New Exception("msg")` and `New SqlConnection(connStr)`, which are
  everywhere.

## 8. Escalating to a different model

For grammar-design-heavy fixes (external scanners, genuine GLR ambiguities needing structural
redesign, anything where the first two hypotheses both failed for non-obvious reasons), consider
handing off to a stronger reasoning model in a fresh thread rather than continuing to iterate. When
you do:

- Write the prompt as if briefing a smart colleague with zero context, not a terse instruction —
  include the exact repro commands, the exact root cause you've already diagnosed (with file/line
  references), and — critically — **everything you already tried and why it failed**, in enough
  detail that the next thread doesn't waste its own budget re-discovering the same dead end.
- If you have a design hypothesis, state it as a hypothesis to verify, not a spec to follow
  blindly — leave room for the next thread to disagree if their own investigation points elsewhere.
- Check whether an *analogous* language actually has the same problem before assuming a technique
  transplants — VB.NET's `New Type(args)` ambiguity looked at first like it might have a Python/Ruby
  precedent (both were already being read for the external-scanner fix), but neither language
  actually has this specific overload (both avoid it by using brackets for generics, or having no
  `new`-keyword-plus-parens sugar at all). The real disambiguator came from VB.NET's *own* spec
  instead. Don't assume a borrowed technique applies without checking the target language actually
  shares the problem.
- Restate the repo's specific conventions (corpus test format, `-u` behavior, what not to touch in
  `package.json`, how to rebuild the native addon) explicitly — don't assume they're obvious or that
  the next thread will find them unprompted.

## Appendix: command cheat sheet

```bash
tree-sitter generate --abi 14        # regenerate parser.c/grammar.json/node-types.json from grammar.js
tree-sitter parse <file>             # parse one file, print the tree (grep -c ERROR for a quick check)
tree-sitter test                     # run the full corpus suite
tree-sitter test -u                  # auto-fill expected trees (refuses if ERROR/MISSING present)
tree-sitter test -i "<regex>"        # run only tests whose name matches
tree-sitter test -r                  # force-rebuild the parser before testing (use if results look stale)
npm run generate:nodeTypes           # regenerate nodes.ts from src/node-types.json
npm install                          # rebuild the native Node addon (node-gyp-build)
npm pack                             # build the real tarball, for a genuine packaging test
```
