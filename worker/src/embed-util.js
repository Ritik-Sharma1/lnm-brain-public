// worker/src/embed-util.js
// Pure helpers for the embed write-path. No CF bindings — unit-testable in node.
// CommonJS export here; index.js re-declares the same logic inline (Workers ESM).

// Turn the async embed results into an honest summary. multiWritten is either
// the array embedAndStoreMulti returns, OR an Error if embedding threw.
function summarizeEmbedResult(multiWritten, singleOk) {
  if (multiWritten instanceof Error) {
    return { vectors_written: 0, embed_mode: "error", error: multiWritten.message };
  }
  const multi = Array.isArray(multiWritten) ? multiWritten.length : 0;
  const single = singleOk ? 1 : 0;
  return { vectors_written: multi + single, embed_mode: "ok" };
}

// Throw verbatim if any embedding vector is not exactly `dims` long.
function assertVectorDims(vectors, dims) {
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i];
    if (!Array.isArray(v) || v.length !== dims) {
      throw new Error(`embed dim mismatch at idx ${i}: got ${Array.isArray(v) ? v.length : typeof v}, want ${dims}`);
    }
  }
}

module.exports = { summarizeEmbedResult, assertVectorDims };
