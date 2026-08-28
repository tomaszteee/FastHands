import argparse, json, sys, time, re
from urllib.parse import urlparse


def emit(obj, code=0):
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    print(json.dumps(obj, ensure_ascii=False))
    raise SystemExit(code)


def is_url(s):
    try:
        p=urlparse(s)
        return p.scheme in ('http','https') and bool(p.netloc)
    except Exception:
        return False


def search_web(q, n=10):
    from ddgs import DDGS
    errors=[]
    for backend in ('auto','duckduckgo','brave','google','bing'):
        try:
            rows=list(DDGS().text(q, max_results=n, backend=backend))
            out=[]; seen=set()
            for r in rows:
                u=r.get('href') or r.get('url') or ''
                if not u or u in seen: continue
                seen.add(u)
                out.append({'title':r.get('title',''),'url':u,'snippet':r.get('body',''),'backend':backend})
            if out:
                return out[:n], errors
        except Exception as e:
            errors.append({'backend':backend,'error':str(e)[:300]})
    return [], errors


def http_read(url, timeout=20):
    import requests
    from trafilatura import extract
    h={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'}
    r=requests.get(url,headers=h,timeout=timeout,allow_redirects=True)
    r.raise_for_status()
    text=extract(r.text, output_format='markdown', with_metadata=True, include_comments=False, include_links=True)
    if not text or len(text.strip())<120:
        raise RuntimeError('trafilatura_empty_or_too_short')
    return {'url':r.url,'status':r.status_code,'content_type':r.headers.get('content-type',''),'text':text,'mode':'http+trafilatura'}


def browser_read(url, timeout=30000):
    import os
    from playwright.sync_api import sync_playwright
    preferred = os.environ.get("FASTWEB_BROWSER_CHANNEL", "").strip()
    attempts = [preferred] if preferred else ["msedge", "chrome", None]
    errors = []
    with sync_playwright() as p:
        for channel in attempts:
            browser = None
            try:
                browser = p.chromium.launch(channel=channel, headless=True) if channel else p.chromium.launch(headless=True)
                page = browser.new_page(viewport={"width":1440,"height":1000})
                page.goto(url, wait_until="domcontentloaded", timeout=timeout)
                try: page.wait_for_load_state("networkidle", timeout=5000)
                except Exception: pass
                title = page.title(); final = page.url
                text = page.locator("body").inner_text(timeout=10000)
                browser.close()
                text = re.sub(r"\n{3,}", "\n\n", text).strip()
                if len(text) < 80: raise RuntimeError("browser_body_too_short")
                return {"url":final,"status":200,"content_type":"text/html","title":title,"text":text,"mode":"playwright+"+(channel or "chromium")}
            except Exception as e:
                errors.append(f"{channel or 'chromium'}: {e}")
                try:
                    if browser: browser.close()
                except Exception: pass
    raise RuntimeError("browser_launch_failed: " + " | ".join(errors)[:1200])

def read_web(url, allow_browser=True):
    errors=[]
    try: return http_read(url), errors
    except Exception as e: errors.append({'mode':'http+trafilatura','error':str(e)[:500]})
    if allow_browser:
        try: return browser_read(url), errors
        except Exception as e: errors.append({'mode':'playwright+edge','error':str(e)[:500]})
    return None, errors


def main():
    ap=argparse.ArgumentParser(); sub=ap.add_subparsers(dest='cmd',required=True)
    s=sub.add_parser('search'); s.add_argument('query'); s.add_argument('--top',type=int,default=10)
    r=sub.add_parser('read'); r.add_argument('url'); r.add_argument('--no-browser',action='store_true'); r.add_argument('--force-browser',action='store_true'); r.add_argument('--max-chars',type=int,default=20000)
    d=sub.add_parser('deep'); d.add_argument('query'); d.add_argument('--top',type=int,default=5); d.add_argument('--max-chars',type=int,default=12000)
    sub.add_parser('health'); sub.add_parser('self-test'); a=ap.parse_args(); t=time.time()
    if a.cmd=='health':
        checks={}
        for m in ('ddgs','trafilatura','requests','playwright'):
            try: __import__(m); checks[m]=True
            except Exception: checks[m]=False
        import os
        checks['edge']=os.path.exists(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe') or os.path.exists(r'C:\Program Files\Microsoft\Edge\Application\msedge.exe')
        emit({'ok':all(checks.values()),'checks':checks,'elapsed_ms':round((time.time()-t)*1000)},0 if all(checks.values()) else 6)
    if a.cmd=='self-test':
        report={}
        rows,errs=search_web('OpenAI official documentation',3); report['search']=len(rows)>0
        doc,rerrs=read_web('https://example.com',False); report['http_read']=bool(doc and len(doc.get('text',''))>80)
        try:
            b=browser_read('https://example.com'); report['browser_read']=bool(b and 'Example Domain' in b.get('text',''))
        except Exception as e:
            report['browser_read']=False; report['browser_error']=str(e)[:300]
        emit({'ok':all(report.get(k,False) for k in ('search','http_read','browser_read')),'report':report,'elapsed_ms':round((time.time()-t)*1000)},0 if all(report.get(k,False) for k in ('search','http_read','browser_read')) else 7)
    if a.cmd=='search':
        rows,errs=search_web(a.query,max(1,min(a.top,30)))
        emit({'ok':bool(rows),'query':a.query,'count':len(rows),'results':rows,'errors':errs,'elapsed_ms':round((time.time()-t)*1000)},0 if rows else 3)
    if a.cmd=='read':
        if not is_url(a.url): emit({'ok':False,'error':'invalid_url'},2)
        doc,errs=(browser_read(a.url),[]) if a.force_browser else read_web(a.url,not a.no_browser)
        if not doc: emit({'ok':False,'url':a.url,'errors':errs,'elapsed_ms':round((time.time()-t)*1000)},4)
        doc['text']=doc['text'][:a.max_chars]
        emit({'ok':True,'document':doc,'fallback_errors':errs,'elapsed_ms':round((time.time()-t)*1000)})
    if a.cmd=='deep':
        rows,serrs=search_web(a.query,max(1,min(a.top,10))); docs=[]
        for row in rows:
            doc,errs=read_web(row['url'],True)
            docs.append({'result':row,'document':None if not doc else {**doc,'text':doc['text'][:a.max_chars]},'errors':errs})
        ok=sum(1 for x in docs if x['document'])
        emit({'ok':ok>0,'query':a.query,'searched':len(rows),'read_ok':ok,'items':docs,'search_errors':serrs,'elapsed_ms':round((time.time()-t)*1000)},0 if ok else 5)

if __name__=='__main__': main()
