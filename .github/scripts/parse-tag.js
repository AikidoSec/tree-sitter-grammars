/**
 * Resolve the grammar folder to package from a release tag.
 *
 *   node .github/scripts/parse-tag.js tree-sitter-kotlin@0.4.0
 *
 * Prints the grammar folder to stdout, so the caller can capture it:
 *
 *   FOLDER="$(node .github/scripts/parse-tag.js "$TAG_NAME")"
 *
 * Exits non-zero if the tag is malformed, names a folder that is not a grammar,
 * or disagrees with that grammar's package.json version. Diagnostics go to
 * stderr to keep stdout parseable.
 */

const { readFileSync, existsSync } = require("fs");
const path = require("path");

/* Grammar folders are plain directory names at the repo root. Anything else
 * (a path separator, `..`, shell metacharacters) is rejected before it is used
 * as a path or, downstream, as a job working-directory. */
const FOLDER_PATTERN = /^tree-sitter-[a-z0-9][a-z0-9._-]*$/;

class TagError extends Error {}

/**
 * Split `<grammar-folder>@<version>` and validate both halves against the
 * grammar actually present in `repoRoot`.
 */
function parseTag(tagName, repoRoot) {
  const at = tagName.lastIndexOf("@");
  if (at <= 0 || at === tagName.length - 1) {
    throw new TagError(
      `Tag '${tagName}' must be <grammar-folder>@<version>, e.g. tree-sitter-kotlin@0.4.0.`,
    );
  }

  const folder = tagName.slice(0, at);
  const version = tagName.slice(at + 1);

  if (!FOLDER_PATTERN.test(folder)) {
    throw new TagError(`'${folder}' is not a valid grammar folder name.`);
  }

  const pkgPath = path.join(repoRoot, folder, "package.json");
  if (!path.resolve(pkgPath).startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new TagError(`'${folder}' resolves outside the repository.`);
  }
  if (!existsSync(pkgPath)) {
    throw new TagError(
      `No grammar at '${folder}' (${folder}/package.json not found).`,
    );
  }

  // A tag that disagrees with package.json would publish a tarball whose
  // version silently differs from the tag npm users see.
  const pkgVersion = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  if (version !== pkgVersion) {
    throw new TagError(
      `Tag version ${version} does not match ${folder}/package.json version ${pkgVersion}.`,
    );
  }

  return { folder, version };
}

function fail(message) {
  // stderr, not stdout: stdout is the folder, and on failure the caller's
  // command substitution would swallow this line.
  console.error(`::error::${message}`);
  process.exit(1);
}

function main(argv) {
  const tagName = argv[2];
  if (!tagName) {
    fail("Usage: parse-tag.js <grammar-folder>@<version>");
  }

  const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
  let resolved;
  try {
    resolved = parseTag(tagName, repoRoot);
  } catch (err) {
    if (!(err instanceof TagError)) throw err;
    fail(err.message);
  }

  const { folder, version } = resolved;
  console.error(`Packaging ${folder}@${version}`);
  console.log(folder);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { parseTag, TagError, FOLDER_PATTERN };
