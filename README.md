# tree-sitter-grammars

## How to add grammar

### 1. Add source code

We use subtree to keep history. Example (adding Kotlin):

```
git subtree add --prefix=tree-sitter-kotlin \
  git@github.com:fwcd/tree-sitter-kotlin.git \
  main --squash
```

### 2. Fix grammar scripts and regenerate

1. Set exact versions of tools (see below). They should be same for all grammars
2. Add scripts in package.json to regenerate grammar files

```
{
  "scripts": {
    "generate": "tree-sitter generate --abi 14",
    "clean:node": "rm binding.gyp && rm -rf bindings/node/",
    "init": "tree-sitter init --update",
    "regenerate": "npm run clean:node && npm run init && npm run generate"
  },
  "dependencies": {
    "node-addon-api": "^8.2.2",
    "node-gyp-build": "^4.8.4"
  },
  "devDependencies": {
    "tree-sitter": "0.21.1",
    "tree-sitter-cli": "0.25.10",
    "prebuildify": "^6.0.0"
  }
}
```

3. Disable every bindings except node tree-sitter.json
```
  "bindings": {
    "c": false,
    "go": false,
    "node": true,
    "python": false,
    "rust": false,
    "swift": false
  }
```

4. Regenerate

```
  cd tree-sitter-kotlin && npm run regenerate
```

### 3. Add to CI

in `.github/workflows/test.yml`

```
    strategy:
      matrix:
        folder:
          - tree-sitter-kotlin
          - tree-sitter-dart   # <- new grammar added here
```

## Grammars

Reference list of vendored grammars: where each one's source comes from, and the command used to pull updates.

### Kotlin

```
git subtree pull --prefix=tree-sitter-kotlin \
  git@github.com:fwcd/tree-sitter-kotlin.git \
  main --squash
```
