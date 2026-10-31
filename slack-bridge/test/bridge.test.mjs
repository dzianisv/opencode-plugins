import test from "node:test"
import assert from "node:assert/strict"
import { MAX_TEXT, chunks, keyFor, parseModel, toMrkdwn } from "../lib.mjs"

test("keyFor joins channel and thread", () => {
  assert.equal(keyFor("C123", "1700000000.000100"), "C123:1700000000.000100")
})

test("parseModel splits provider/model", () => {
  assert.deepEqual(parseModel("opencode/deepseek-v4.1-flash-free"), {
    providerID: "opencode",
    modelID: "deepseek-v4.1-flash-free",
  })
})

test("parseModel rejects incomplete values", () => {
  assert.equal(parseModel(""), null)
  assert.equal(parseModel("opencode"), null)
  assert.equal(parseModel("/model"), null)
  assert.equal(parseModel("provider/"), null)
})

test("toMrkdwn converts common markdown", () => {
  assert.equal(toMrkdwn("**bold**"), "*bold*")
  assert.equal(toMrkdwn("# Heading"), "*Heading*")
  assert.equal(toMrkdwn("[docs](https://example.com)"), "<https://example.com|docs>")
})

test("chunks keeps every part within the limit", () => {
  const parts = chunks("a".repeat(8000))
  assert.equal(parts.length, 3)
  for (const part of parts) assert.ok(part.length <= MAX_TEXT)
})

test("chunks prefers newline boundaries", () => {
  const parts = chunks("a".repeat(3000) + "\n" + "b".repeat(3000))
  assert.deepEqual(parts.map((p) => p.length), [3000, 3000])
})
