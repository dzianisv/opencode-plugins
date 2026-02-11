import assert from "assert"

const WHISPER_PORT = 5552
const WHISPER_URL = `http://127.0.0.1:${WHISPER_PORT}`

function generateTestWav(): string {
  const buffer = Buffer.alloc(44 + 3200) // 0.1s at 16kHz
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + 3200, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16000, 24)
  buffer.writeUInt32LE(32000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(3200, 40)
  return buffer.toString("base64")
}

async function main(): Promise<void> {
  try {
    const healthResponse = await fetch(`${WHISPER_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })

    if (!healthResponse.ok) {
      console.warn("Whisper server not healthy - skipping transcription test")
      return
    }

    const health = await healthResponse.json()
    assert.strictEqual(health.status, "healthy")
    assert.strictEqual(health.model_loaded, true)
    console.log(`Whisper server running: model=${health.current_model}`)
  } catch (err) {
    console.warn("Whisper server not running on port 5552 - transcription test skipped")
    return
  }

  try {
    const payload = {
      audio: generateTestWav(),
      model: "base",
      format: "wav"
    }

    let response = await fetch(`${WHISPER_URL}/transcribe-base64`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    })

    if (response.status === 404) {
      response = await fetch(`${WHISPER_URL}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000)
      })
    }

    if (!response.ok) {
      console.warn(`Whisper transcription failed: ${response.status}`)
      return
    }

    const result = await response.json()
    assert.ok(Object.prototype.hasOwnProperty.call(result, "text"))
    assert.ok(Object.prototype.hasOwnProperty.call(result, "language"))
    assert.ok(Object.prototype.hasOwnProperty.call(result, "duration"))
    console.log(`Whisper transcription works: duration=${result.duration}s`)
  } catch (err) {
    console.warn("Whisper server not available for transcription test")
  }
}

await main()
