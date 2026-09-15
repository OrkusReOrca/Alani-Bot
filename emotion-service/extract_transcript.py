"""Speech Transcript (T) — faster-whisper, same tool family the source
pipeline used (OpenAI Whisper), just the CPU-friendly faster-whisper
binding and a smaller default model size (see config.WHISPER_MODEL's own
comment for why). No hallucination filtering here on purpose — the
source pipeline's own approach was to feed the raw transcript straight to
the VLM with a "disregard if garbled" instruction (see prompt.py) rather
than trying to detect garbling itself, and this keeps that same division
of responsibility.
"""

import config

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(config.WHISPER_MODEL, compute_type=config.WHISPER_COMPUTE_TYPE)
    return _model


def extract_transcript(audio_path):
    """Returns the raw transcribed text, or '' if there's no audio track
    or no detected speech — same as the original's 37-silent-clips case."""
    if not audio_path:
        return ""
    segments, _ = _get_model().transcribe(audio_path)
    text = " ".join(seg.text.strip() for seg in segments)
    return text.strip()
