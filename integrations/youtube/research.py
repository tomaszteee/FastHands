import argparse
import json
import io
import contextlib
import re
import sys
import tempfile
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import yt_dlp

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / 'output'
from transcript_helper import download_subtitles, whisper_fallback, safe_name

YT_HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'music.youtube.com'}
STOPWORDS = {
    'a','an','and','or','the','to','of','for','in','on','with','how','best','tutorial','guide',
    'ai','coding','code','programming','workflow','loop','using','use','make','build','building'
}


def emit(payload, exit_code=0):
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


def normalized_tokens(text):
    return [t for t in re.findall(r"[a-z0-9]+", (text or '').lower()) if len(t) > 1]


def parse_input(value: str):
    value = (value or '').strip()
    if not value:
        raise ValueError('Puste zapytanie.')
    if not value.startswith(('http://', 'https://')):
        return {'kind': 'query', 'query': value}
    p = urlparse(value)
    host = p.netloc.lower().split(':')[0]
    if host not in YT_HOSTS and not host.endswith('.youtube.com'):
        raise ValueError('ObsĹ‚ugiwane sÄ… tylko linki YouTube albo zwykĹ‚e zapytanie tekstowe.')
    if host == 'youtu.be' or p.path == '/watch' or p.path.startswith('/shorts/') or p.path.startswith('/live/'):
        return {'kind': 'video', 'url': value}
    if p.path == '/results':
        q = parse_qs(p.query).get('search_query', [''])[0].strip()
        if not q:
            raise ValueError('Link do wynikĂłw YouTube nie zawiera search_query.')
        return {'kind': 'query', 'query': q}
    raise ValueError('NieobsĹ‚ugiwany typ linku YouTube. Podaj /results?... albo link do filmu.')


def search_variants(query: str):
    original = re.sub(r'\s+', ' ', query).strip()
    tokens = normalized_tokens(original)
    meaningful = [t for t in tokens if t not in STOPWORDS]
    variants = [original]
    if len(meaningful) >= 3:
        variants.append(' '.join(meaningful))
    # Adjacent high-signal windows are much more reliable than one over-specific long query.
    if len(meaningful) >= 5:
        variants.append(' '.join(meaningful[:4]))
        variants.append(' '.join(meaningful[-4:]))
    elif len(meaningful) == 4:
        variants.append(' '.join(meaningful[:3]))
        variants.append(' '.join(meaningful[1:]))
    # Domain-aware but deterministic variants for visual/UI research.
    s = set(meaningful)
    if {'screenshot','comparison'} <= s or {'visual','regression'} <= s:
        variants += ['visual regression screenshot comparison', 'pixel perfect screenshot code']
    out = []
    seen = set()
    for v in variants:
        k = v.lower().strip()
        if k and k not in seen:
            seen.add(k)
            out.append(v.strip())
    return out[:6]


def base_ydl(flat=True):
    return {
        'quiet': True,
        'no_warnings': True,
        'skip_download': True,
        'noplaylist': True,
        'extract_flat': 'in_playlist' if flat else False,
        'socket_timeout': 20,
        'retries': 3,
        'fragment_retries': 3,
    }


def compact(entry):
    vid = entry.get('id')
    return {
        'id': vid,
        'title': entry.get('title'),
        'url': entry.get('webpage_url') or entry.get('url') if str(entry.get('url','')).startswith('http') else (f'https://www.youtube.com/watch?v={vid}' if vid else None),
        'channel': entry.get('channel') or entry.get('uploader') or entry.get('channel_id'),
        'duration': entry.get('duration'),
        'duration_string': entry.get('duration_string'),
        'view_count': entry.get('view_count'),
        'upload_date': entry.get('upload_date'),
        'description': (entry.get('description') or '')[:800],
    }


def relevance_score(item, query):
    q = set(normalized_tokens(query)) - STOPWORDS
    title = set(normalized_tokens(item.get('title') or ''))
    desc = set(normalized_tokens(item.get('description') or ''))
    if not q:
        return 0.0
    title_hits = len(q & title)
    desc_hits = len(q & desc)
    phrase_bonus = 0
    title_l = (item.get('title') or '').lower()
    for phrase in ('visual regression','pixel perfect','screenshot comparison','visual testing','screenshot to code'):
        if phrase in query.lower() and phrase in title_l:
            phrase_bonus += 2
    return round((title_hits * 4 + desc_hits + phrase_bonus * 3) / max(1, len(q)), 3)


def search_one(query, limit):
    opts = base_ydl(flat=True)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f'ytsearch{limit}:{query}', download=False)
    return [compact(e) for e in (info.get('entries') or []) if e and e.get('id')]


def robust_search(query, top):
    variants = search_variants(query)
    merged = {}
    errors = []
    per_variant = max(10, min(20, top * 2))
    for v in variants:
        try:
            for item in search_one(v, per_variant):
                vid = item.get('id')
                if not vid:
                    continue
                if vid not in merged:
                    item['_matched_queries'] = [v]
                    merged[vid] = item
                else:
                    merged[vid]['_matched_queries'].append(v)
        except Exception as e:
            errors.append({'query': v, 'error': str(e)})
    ranked = list(merged.values())
    for item in ranked:
        item['relevance_score'] = relevance_score(item, query)
        item['matched_queries'] = item.pop('_matched_queries', [])
    ranked.sort(key=lambda x: (x.get('relevance_score') or 0, len(x.get('matched_queries') or []), x.get('view_count') or 0), reverse=True)
    return ranked[:top], variants, errors


def single_video(url):
    opts = base_ydl(flat=False)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    item = compact(info)
    item['relevance_score'] = None
    item['matched_queries'] = []
    return [item]


def get_transcript(url: str, allow_whisper: bool, outdir: Path, video_id: str, force_whisper=False):
    logs = []
    def log(msg): logs.append(str(msg))
    with tempfile.TemporaryDirectory(prefix='ytresearch_') as td_raw:
        td = Path(td_raw)
        text = title = source = None
        # Imported yt-dlp helpers can emit progress lines. Capture them so stdout remains strict JSON.
        noise_out, noise_err = io.StringIO(), io.StringIO()
        if not force_whisper:
            try:
                with contextlib.redirect_stdout(noise_out), contextlib.redirect_stderr(noise_err):
                    text, title, _ = download_subtitles(url, td, log)
                source = 'youtube_subtitles' if text else None
            except Exception as e:
                logs.append(f'subtitles_error: {e}')
        if force_whisper or (not text and allow_whisper):
            try:
                noise_out, noise_err = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(noise_out), contextlib.redirect_stderr(noise_err):
                    text, title = whisper_fallback(url, td, log)
                source = 'whisper'
            except Exception as e:
                logs.append(f'whisper_error: {e}')
                captured = (noise_err.getvalue() or noise_out.getvalue()).strip()
                if captured:
                    logs.append('captured_tool_output: ' + captured[-800:])
                return {'status':'error','source':None,'chars':0,'path':None,'preview':'','logs':logs,'error':str(e)}
        if not text:
            return {'status':'no_transcript','source':None,'chars':0,'path':None,'preview':'','logs':logs}
        text = text.strip()
        tdir = outdir / 'transcripts'
        tdir.mkdir(parents=True, exist_ok=True)
        path = tdir / f'{safe_name(video_id or title)}.txt'
        path.write_text(text + '\n', encoding='utf-8')
        return {
            'status':'ok','source':source,'title':title,'chars':len(text),
            'path':str(path),'preview':text[:4000], 'logs':logs
        }


def _video_stream_url(info):
    if info.get('url') and info.get('vcodec') != 'none':
        return info.get('url')
    for f in reversed(info.get('formats') or []):
        if f.get('url') and f.get('vcodec') not in (None, 'none') and (f.get('height') or 0) <= 720:
            return f.get('url')
    return None


def extract_frames(url: str, outdir: Path, count=6):
    outdir.mkdir(parents=True, exist_ok=True)
    opts = base_ydl(flat=False)
    opts.update({'format':'worstvideo[height<=480]/worst[height<=480]/worst'})
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    duration = float(info.get('duration') or 0)
    stream = _video_stream_url(info)
    if duration <= 0 or not stream:
        raise RuntimeError('Brak czasu trwania lub bezpoĹ›redniego strumienia wideo do ekstrakcji klatek.')
    frames = []
    for i in range(1, count + 1):
        t = duration * i / (count + 1)
        fp = outdir / f'{info.get("id")}_{i:02d}.jpg'
        cmd = ['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',f'{t:.3f}','-i',stream,'-frames:v','1','-q:v','3',str(fp)]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if proc.returncode != 0 or not fp.exists() or fp.stat().st_size < 1000:
            raise RuntimeError(f'FFmpeg nie utworzyĹ‚ klatki {i}: {(proc.stderr or "unknown error")[-500:]}')
        frames.append(str(fp))
    return frames


def health():
    checks = {}
    checks['python'] = sys.version.split()[0]
    checks['yt_dlp'] = getattr(yt_dlp.version, '__version__', 'unknown')
    try:
        p = subprocess.run(['ffmpeg','-version'], capture_output=True, text=True, timeout=5)
        checks['ffmpeg'] = 'ok' if p.returncode == 0 else 'error'
    except Exception as e:
        checks['ffmpeg'] = f'error: {e}'
    try:
        import faster_whisper
        checks['faster_whisper'] = 'ok'
    except Exception as e:
        checks['faster_whisper'] = f'error: {e}'
    checks['transcript_helper'] = str(ROOT / 'transcript_helper.py') if (ROOT / 'transcript_helper.py').exists() else 'missing'
    checks['status'] = 'ok' if checks['ffmpeg'] == 'ok' and checks['faster_whisper'] == 'ok' and checks['transcript_helper'] != 'missing' else 'degraded'
    return checks


def main():
    ap = argparse.ArgumentParser(description='Reliable YouTube research helper for Fast Hands')
    ap.add_argument('input', nargs='?', help='YouTube results URL, video URL, or search query')
    ap.add_argument('--top', type=int, default=8)
    ap.add_argument('--transcripts', type=int, default=0, help='Fetch transcripts for first N ranked results')
    ap.add_argument('--whisper', action='store_true', help='Use local Whisper fallback when captions are missing')
    ap.add_argument('--frames', type=int, default=0, help='Extract N evenly spaced frames from first ranked result without downloading full video')
    ap.add_argument('--out', default=str(DEFAULT_OUT))
    ap.add_argument('--health', action='store_true')
    ap.add_argument('--force-whisper', action='store_true', help='Force Whisper even when YouTube captions exist; useful for diagnostics')
    ap.add_argument('--self-test', action='store_true', help='Run local + network smoke tests and return JSON')
    args = ap.parse_args()

    if args.health:
        emit({'ok': True, 'health': health()})
    if args.self_test:
        report = {'health': health(), 'checks': []}
        try:
            parsed = parse_input('https://www.youtube.com/results?search_query=visual+regression+screenshot+comparison+playwright')
            report['checks'].append({'name':'parse_search_url','ok':parsed.get('query') == 'visual regression screenshot comparison playwright'})
        except Exception as e:
            report['checks'].append({'name':'parse_search_url','ok':False,'error':str(e)})
        try:
            r, v, errs = robust_search('visual regression screenshot comparison playwright', 3)
            report['checks'].append({'name':'youtube_search','ok':len(r) >= 3,'count':len(r),'search_errors':errs})
        except Exception as e:
            report['checks'].append({'name':'youtube_search','ok':False,'error':str(e)})
        report['ok'] = report['health'].get('status') == 'ok' and all(c.get('ok') for c in report['checks'])
        emit(report, 0 if report['ok'] else 4)
    try:
        parsed = parse_input(args.input)
        outdir = Path(args.out)
        outdir.mkdir(parents=True, exist_ok=True)
        top = max(1, min(args.top, 25))
        if parsed['kind'] == 'video':
            results = single_video(parsed['url'])
            query, variants, search_errors = None, [], []
        else:
            query = parsed['query']
            results, variants, search_errors = robust_search(query, top)
        payload = {
            'ok': True,
            'input_kind': parsed['kind'],
            'query': query,
            'search_variants': variants,
            'search_errors': search_errors,
            'count': len(results),
            'results': results,
        }
        if not results:
            payload['ok'] = False
            payload['error'] = 'Brak wynikĂłw po wszystkich strategiach wyszukiwania.'
            emit(payload, 3)
        n = max(0, min(args.transcripts, len(results)))
        for i in range(n):
            results[i]['transcript'] = get_transcript(results[i]['url'], args.whisper, outdir, results[i].get('id') or f'video_{i+1}', args.force_whisper)
        if args.frames:
            fdir = outdir / 'frames' / safe_name(results[0].get('id') or results[0].get('title'))
            results[0]['frames'] = extract_frames(results[0]['url'], fdir, max(1, min(args.frames, 12)))
        payload['generated_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        emit(payload, 0)
    except SystemExit:
        raise
    except Exception as e:
        emit({'ok':False,'error_type':type(e).__name__,'error':str(e)}, 2)

if __name__ == '__main__':
    main()
