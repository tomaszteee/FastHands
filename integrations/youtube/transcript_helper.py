import re
from pathlib import Path


def safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name or 'transcript')
    name = re.sub(r'\s+', ' ', name).strip().rstrip('.')
    return name[:180] or 'transcript'


def choose_lang(info):
    manual = info.get('subtitles') or {}
    auto = info.get('automatic_captions') or {}
    def pick(data):
        keys = [k for k in data.keys() if k and k != 'live_chat']
        for exact in ('en', 'pl'):
            if exact in keys:
                return exact
        for prefix in ('en-', 'en_', 'pl-', 'pl_'):
            for key in keys:
                if key.lower().startswith(prefix):
                    return key
        return keys[0] if keys else None
    lang = pick(manual)
    if lang:
        return lang, 'manual'
    lang = pick(auto)
    if lang:
        return lang, 'auto'
    return None, None


def clean_srt(path: Path) -> str:
    text = path.read_text(encoding='utf-8', errors='ignore')
    blocks = re.split(r'\n\s*\n', text.replace('\r\n', '\n'))
    out, last = [], None
    for block in blocks:
        lines = [x.strip() for x in block.splitlines() if x.strip()]
        lines = [x for x in lines if not x.isdigit() and '-->' not in x]
        if not lines:
            continue
        phrase = re.sub(r'<[^>]+>', '', ' '.join(lines))
        phrase = re.sub(r'\s+', ' ', phrase).strip()
        if phrase and phrase != last:
            out.append(phrase)
            last = phrase
    return '\n'.join(out).strip()


def download_subtitles(url, tmpdir: Path, logger):
    import yt_dlp
    logger('Checking available YouTube captions...')
    base_opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True}
    with yt_dlp.YoutubeDL(base_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    title = info.get('title') or info.get('id') or 'transcript'
    lang, kind = choose_lang(info)
    if not lang:
        return None, title, info
    logger(f'Found captions: {lang} ({kind}).')
    opts = {
        'quiet': True, 'no_warnings': True, 'noplaylist': True, 'skip_download': True,
        'writesubtitles': kind == 'manual', 'writeautomaticsub': kind == 'auto',
        'subtitleslangs': [lang], 'subtitlesformat': 'srt/best',
        'outtmpl': str(tmpdir / '%(id)s.%(ext)s'),
        'postprocessors': [{'key': 'FFmpegSubtitlesConvertor', 'format': 'srt', 'when': 'before_dl'}],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    srts = list(tmpdir.glob('*.srt'))
    if not srts:
        vtts = list(tmpdir.glob('*.vtt'))
        if vtts:
            raw = vtts[0].read_text(encoding='utf-8', errors='ignore').replace('WEBVTT', '')
            fake = tmpdir / 'captions.srt'
            fake.write_text(raw, encoding='utf-8')
            srts = [fake]
    if not srts:
        raise RuntimeError('YouTube reported captions but no subtitle file could be downloaded.')
    return clean_srt(srts[0]), title, info


def whisper_fallback(url, tmpdir: Path, logger):
    import yt_dlp
    logger('No captions. Downloading audio for local Whisper...')
    opts = {
        'quiet': True, 'no_warnings': True, 'noplaylist': True, 'format': 'bestaudio/best',
        'outtmpl': str(tmpdir / 'audio.%(ext)s'),
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '128'}],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    audio = tmpdir / 'audio.mp3'
    if not audio.exists():
        candidates = list(tmpdir.glob('audio.*'))
        if not candidates:
            raise RuntimeError('Could not download audio.')
        audio = candidates[0]
    if audio.stat().st_size < 16000:
        raise RuntimeError('Downloaded audio is missing or too small to transcribe.')
    logger('Running faster-whisper locally (small, CPU/int8).')
    from faster_whisper import WhisperModel
    model = WhisperModel('small', device='cpu', compute_type='int8')
    def transcribe(vad):
        segments, detected = model.transcribe(str(audio), beam_size=5, vad_filter=vad, condition_on_previous_text=True)
        lines = [(seg.text or '').strip() for seg in segments if (seg.text or '').strip()]
        return lines, detected
    lines, detected = transcribe(True)
    if not lines:
        lines, detected = transcribe(False)
    if not lines:
        raise RuntimeError('Whisper did not detect speech in the downloaded audio.')
    return '\n'.join(lines), info.get('title') or info.get('id') or 'transcript'
