#!/usr/bin/env python3
"""
Faster Whisper STT Server for OpenCode TTS Plugin

Lightweight HTTP server that provides speech-to-text transcription
for Telegram voice messages. Runs as a subprocess managed by tts.ts.

Based on the implementation from opencode-manager.
"""

import os
import sys
import json
import tempfile
import logging
import subprocess
import shutil
import base64
from pathlib import Path
from typing import Optional

# Auto-install dependencies if missing
try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse
    import uvicorn
except ImportError:
    print("Installing required packages...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fastapi", "uvicorn", "python-multipart"])
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import JSONResponse
    import uvicorn

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Installing faster-whisper...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "faster-whisper"])
    from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OpenCode Whisper STT Server", version="1.0.0")

# Configuration from environment
MODELS_DIR = os.environ.get("WHISPER_MODELS_DIR", str(Path.home() / ".cache" / "whisper"))
DEFAULT_MODEL = os.environ.get("WHISPER_DEFAULT_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "auto")

AVAILABLE_MODELS = [
    "tiny", "tiny.en", 
    "base", "base.en", 
    "small", "small.en", 
    "medium", "medium.en", 
    "large-v2", "large-v3"
]

# Model cache to avoid reloading
model_cache: dict[str, WhisperModel] = {}
current_model_name: Optional[str] = None


def convert_to_wav(input_path: str) -> str:
    """Convert audio file to WAV format using ffmpeg for better compatibility."""
    output_path = input_path.rsplit('.', 1)[0] + '_converted.wav'
    
    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        logger.warning("ffmpeg not found, using original file")
        return input_path
    
    try:
        result = subprocess.run([
            ffmpeg_path, '-y', '-i', input_path,
            '-ar', '16000',  # 16kHz sample rate (Whisper's expected rate)
            '-ac', '1',       # Mono
            '-c:a', 'pcm_s16le',  # 16-bit PCM
            output_path
        ], capture_output=True, timeout=30)
        
        if result.returncode == 0 and os.path.exists(output_path):
            logger.debug(f"Converted {input_path} to {output_path}")
            return output_path
        else:
            logger.warning(f"ffmpeg conversion failed: {result.stderr.decode()[:200]}")
            return input_path
    except Exception as e:
        logger.warning(f"Audio conversion failed: {e}")
        return input_path


def get_model(model_name: str = DEFAULT_MODEL) -> WhisperModel:
    """Get or load a Whisper model (cached)."""
    global current_model_name
    
    if model_name not in AVAILABLE_MODELS:
        model_name = DEFAULT_MODEL
    
    if model_name in model_cache:
        return model_cache[model_name]
    
    logger.info(f"Loading Whisper model: {model_name}")
    
    # Auto-detect device
    device = DEVICE
    if device == "auto":
        try:
            import torch
            if torch.cuda.is_available():
                device = "cuda"
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                device = "cpu"  # MPS not fully supported by faster-whisper, use CPU
            else:
                device = "cpu"
        except ImportError:
            device = "cpu"
    
    # Auto-detect compute type
    compute_type = COMPUTE_TYPE
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    
    model = WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        download_root=MODELS_DIR
    )
    
    model_cache[model_name] = model
    current_model_name = model_name
    logger.info(f"Model {model_name} loaded successfully on {device} with {compute_type}")
    
    return model


@app.on_event("startup")
async def startup_event():
    """Pre-load the default model on startup."""
    logger.info("Starting OpenCode Whisper STT Server...")
    logger.info(f"Models directory: {MODELS_DIR}")
    logger.info(f"Default model: {DEFAULT_MODEL}")
    try:
        get_model(DEFAULT_MODEL)
        logger.info("Default model pre-loaded successfully")
    except Exception as e:
        logger.warning(f"Could not pre-load model: {e}. Will load on first request.")


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "model_loaded": current_model_name is not None,
        "current_model": current_model_name,
        "available_models": AVAILABLE_MODELS
    }


@app.get("/models")
async def list_models():
    """List available Whisper models."""
    return {
        "models": AVAILABLE_MODELS,
        "current": current_model_name,
        "default": DEFAULT_MODEL
    }


@app.post("/transcribe")
async def transcribe(request: dict):
    """
    Transcribe audio from base64-encoded data.
    
    Request body:
    {
        "audio": "<base64-encoded-audio>",
        "model": "base",           // optional, defaults to env var
        "language": "en",          // optional, null for auto-detect
        "format": "ogg"            // audio format hint
    }
    
    Response:
    {
        "text": "transcribed text",
        "language": "en",
        "language_probability": 0.98,
        "duration": 2.5
    }
    """
    audio_data = request.get("audio")
    model_name = request.get("model", DEFAULT_MODEL)
    language = request.get("language")
    if language in ("auto", ""):
        language = None
    file_format = request.get("format", "ogg")
    
    if not audio_data:
        raise HTTPException(status_code=400, detail="No audio data provided")
    
    tmp_path = None
    converted_path = None
    
    try:
        # Handle data URL format
        if "," in audio_data:
            audio_data = audio_data.split(",")[1]
        
        # Decode base64
        audio_bytes = base64.b64decode(audio_data)
        
        # Write to temp file
        with tempfile.NamedTemporaryFile(delete=False, suffix=f".{file_format}") as tmp_file:
            tmp_file.write(audio_bytes)
            tmp_path = tmp_file.name
        
        # Convert to WAV if needed (Telegram voice messages are OGG Opus)
        audio_path = tmp_path
        if file_format.lower() in ['webm', 'ogg', 'mp4', 'm4a', 'opus', 'oga']:
            converted_path = convert_to_wav(tmp_path)
            if converted_path != tmp_path:
                audio_path = converted_path
        
        # Load model and transcribe
        whisper_model = get_model(model_name)
        
        segments, info = whisper_model.transcribe(
            audio_path,
            language=language,
            task="transcribe",
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=400
            )
        )
        
        # Collect all segments
        segments_list = list(segments)
        full_text = " ".join(segment.text.strip() for segment in segments_list)
        
        return JSONResponse(content={
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration
        })
        
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # Cleanup temp files
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except:
                pass
        if converted_path and converted_path != tmp_path:
            try:
                os.unlink(converted_path)
            except:
                pass


if __name__ == "__main__":
    port = int(os.environ.get("WHISPER_PORT", "8787"))
    host = os.environ.get("WHISPER_HOST", "127.0.0.1")
    
    logger.info(f"Starting Whisper server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
