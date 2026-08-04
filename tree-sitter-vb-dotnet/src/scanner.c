#include "tree_sitter/parser.h"

enum TokenType {
  NEWLINE,
};

void *tree_sitter_vb_dotnet_external_scanner_create() { return NULL; }
void tree_sitter_vb_dotnet_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_vb_dotnet_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}
void tree_sitter_vb_dotnet_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

// _newline only produces a real terminator when the grammar actually
// expects one (valid_symbols[NEWLINE]) — which is already false inside
// argument lists, object initializers, etc., since none of those rules
// reference _terminator. When it's not expected, we decline (return
// false) and the bare `\r?\n` in extras silently absorbs the character
// instead. This is what makes VB's implicit line continuation inside
// brackets work, with no bracket-depth tracking needed.
bool tree_sitter_vb_dotnet_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;

  if (!valid_symbols[NEWLINE]) return false;

  if (lexer->lookahead == '\r') {
    advance(lexer);
    if (lexer->lookahead != '\n') return false;
  }

  if (lexer->lookahead == '\n') {
    advance(lexer);
    lexer->result_symbol = NEWLINE;
    return true;
  }

  return false;
}
