import { describe, it, expect, jest, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { _test_internal } from '../telegram.js';

const { transcribeAudio } = _test_internal;

describe('Telegram Plugin Internals', () => {
  const originalFetch = global.fetch;

  beforeAll(() => {
    global.fetch = jest.fn() as any;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    (global.fetch as any).mockClear();
  });

  it('transcribeAudio calls the correct endpoint /transcribe-base64', async () => {
    const mockFetch = global.fetch as any;
    
    // Mock sequence:
    // 1. /health -> 200 OK (server running)
    // 2. /transcribe-base64 -> 200 OK (transcription result)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "healthy" })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: "Hello World", language: "en", duration: 1.0 })
      });

    const config = {
      whisper: { enabled: true, port: 9999 }
    };

    const result = await transcribeAudio("base64data", config);

    expect(result).toBe("Hello World");

    // Verify calls
    // Note: It might be called more times if retries happen, but we expect at least these 2
    expect(mockFetch).toHaveBeenCalledTimes(2);
    
    // First call: Health check
    expect(mockFetch).toHaveBeenNthCalledWith(1, 
      expect.stringContaining("http://127.0.0.1:9999/health"), 
      expect.anything()
    );

    // Second call: Transcription (THE CRITICAL CHECK)
    // This ensures we are calling /transcribe-base64 and NOT /transcribe
    expect(mockFetch).toHaveBeenNthCalledWith(2,
      expect.stringContaining("http://127.0.0.1:9999/transcribe-base64"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("base64data")
      })
    );
  });

  it('transcribeAudio handles missing configuration gracefully', async () => {
    const config = {
      whisper: { enabled: false }
    };
    const result = await transcribeAudio("data", config);
    expect(result).toBeNull();
  });
});
