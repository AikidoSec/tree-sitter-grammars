# tree-sitter-grammars

## How to add grammar

### 1. Add source code

we use subtree to keep history

```
git subtree add --prefix=tree-sitter-kotlin \
  git@github.com:fwcd/tree-sitter-kotlin.git \
  main --squash
```

### 2. fix grammar scripts and regenerate

Fix versions and add scripts in package.json

```
  "scripts": {
    "generate": "tree-sitter generate --abi 14",
    "clean:node": "rm binding.gyp & rm -rf bindings/node/",
    "init": "tree-sitter init --update",
    "regenarate": "npm run clean:node && npm run init && npm run generate"
  },
  "dependencies": {
    "node-addon-api": "^8.2.2",
    "node-gyp-build": "^4.8.4"
  },
  "peerDependencies": {
    "tree-sitter": "^0.21.1"
    }
  },
  "devDependencies": {
    "tree-sitter": "0.21.1",
    "tree-sitter-cli": "0.25.10",
    "prebuildify": "^6.0.0",
  },
```

### 3. Add to CI (two times)



## grammars

*Kotlin*

```
git subtree add --prefix=tree-sitter-kotlin \
  git@github.com:fwcd/tree-sitter-kotlin.git \
  main --squash
```
