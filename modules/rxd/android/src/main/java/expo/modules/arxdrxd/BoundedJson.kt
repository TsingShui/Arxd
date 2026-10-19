package expo.modules.arxdrxd

/** Reject deeply nested public input before Android's recursive JSON parser. */
internal fun boundedJson(text: String, maxBytes: Int) {
  require(text.toByteArray().size <= maxBytes) { "JSON exceeds byte budget" }
  var depth = 0
  var quoted = false
  var escaped = false
  for (char in text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char == '\\') escaped = true
      else if (char == '"') quoted = false
    } else when (char) {
      '"' -> quoted = true
      '{', '[' -> { depth++; require(depth <= 64) { "JSON exceeds nesting budget" } }
      '}', ']' -> { depth--; require(depth >= 0) { "Invalid JSON nesting" } }
    }
  }
  require(depth == 0 && !quoted) { "Incomplete JSON" }
}
