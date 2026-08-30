import json, os, re, socket, subprocess, time, ipaddress
from html import unescape
from urllib.parse import urlparse, urljoin, quote
import xml.etree.ElementTree as ET
import time
import threading

USER_AGENT='FastHands-DeepResearch/1.0 (+on-demand; no background crawling)'
MAX_BYTES=3_000_000
CORE_URL='https://api.core.ac.uk/v3/search/works/'
BASE_URL='https://api.base-search.net/cgi-bin/BaseHttpSearchInterface.fcgi'
BASE_WEB_SEARCH_TEMPLATE='https://www.base-search.net/Search/Results?lookfor={query}&name=&oaboost=1&newsearch=1&refid=dcbaspl'
OSINT_TREE='https://raw.githubusercontent.com/lockfale/OSINT-Framework/master/public/arf.json'
TORCH_ONION=os.environ.get('FASTWEB_TORCH_ONION','http://torchsfe235y6d7wguqo6g4ucxqq7frrm5fpgkjssdhthsq4kjmmisid.onion')

class SourceError(RuntimeError):
    def __init__(self, code, message, detail=None):
        super().__init__(message); self.code=code; self.detail=detail

def _requests():
    import requests
    return requests

def _headers(extra=None):
    h={'User-Agent':USER_AGENT,'Accept':'application/json,text/xml,application/xml,text/html,text/plain;q=0.9,*/*;q=0.1'}
    if extra:h.update(extra)
    return h

def get(url,params=None,timeout=25,headers=None,proxy=None,max_bytes=MAX_BYTES):
    requests=_requests(); proxies={'http':proxy,'https':proxy} if proxy else None
    with requests.get(url,params=params,headers=_headers(headers),timeout=timeout,allow_redirects=True,proxies=proxies,stream=True) as r:
        data=bytearray()
        for chunk in r.iter_content(65536):
            if chunk:
                data.extend(chunk)
                if len(data)>=max_bytes:break
        return {'status':r.status_code,'url':r.url,'content_type':(r.headers.get('content-type') or '').lower(),'bytes':bytes(data),'headers':dict(r.headers),'truncated':len(data)>=max_bytes}

def get_json(url,params=None,timeout=25,headers=None,proxy=None):
    r=get(url,params=params,timeout=timeout,headers=headers,proxy=proxy)
    if r['status']>=400: raise SourceError('HTTP_ERROR',f'HTTP {r["status"]}',r['bytes'][:400].decode('utf-8','replace'))
    try:return json.loads(r['bytes'].decode('utf-8','replace'))
    except Exception as e:raise SourceError('INVALID_JSON',str(e))

def norm(v):return re.sub(r'\s+',' ',str(v or '')).strip()
def toks(v):return {x for x in re.findall(r'[\w.+#/-]{2,}',norm(v).lower(),flags=re.UNICODE)}

def tor_proxy():
    p=os.environ.get('FASTWEB_TOR_PROXY','').strip()
    if p:return p
    for port in (9150,9050):
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=.15):return f'socks5h://127.0.0.1:{port}'
        except Exception:pass
    return None

def searx_instances(limit=4):
    explicit=os.environ.get('FASTWEB_SEARXNG_URL','').strip().rstrip('/')
    if explicit:return [explicit]
    if os.environ.get('FASTWEB_SEARXNG_AUTO','1')=='0':return []
    try:
        data=get_json('https://searx.space/data/instances.json',timeout=15); rows=[]
        for url,info in (data.get('instances') or {}).items():
            if not str(url).startswith('https://') or not isinstance(info,dict):continue
            if info.get('network_type') not in (None,'normal'):continue
            http=info.get('http') or {}
            if isinstance(http,dict) and http.get('status_code') not in (None,200):continue
            grade=(info.get('tls') or {}).get('grade') or ''
            rows.append((0 if grade in ('A+','A') else 1,url.rstrip('/')))
        rows.sort();return [u for _,u in rows[:limit]]
    except Exception:return []

def searx_search(query,n=10,engines=None,instances=8,pages=2):
    out=[]; errors=[]; seen=set()
    for base in searx_instances(instances):
        for page in range(1,pages+1):
            params={'q':query,'format':'json','language':'all','safesearch':1,'pageno':page}
            if engines:params['engines']=engines
            try:data=get_json(base+'/search',params,timeout=22)
            except Exception as e:
                errors.append({'instance':base,'error':str(e)[:180]});break
            for r in data.get('results',[]):
                u=r.get('url')
                if not u or u in seen:continue
                seen.add(u); out.append({'source':'searxng','title':norm(r.get('title')),'url':u,'snippet':norm(r.get('content')),'engine':r.get('engine'),'searx_instance':base})
                if len(out)>=n:return out,errors
    return out,errors

def core_search(query,n=20,offset=0):
    key=os.environ.get('CORE_API_KEY','').strip(); h={}
    if key:h['Authorization']='Bearer '+key
    r=get(CORE_URL,{'q':query,'limit':min(100,max(1,n)),'offset':max(0,offset)},timeout=40,headers=h,max_bytes=5_000_000)
    if r['status'] in (401,403):raise SourceError('FREE_KEY_REQUIRED','CORE API requires a CORE_API_KEY for this request')
    if r['status']>=400:raise SourceError('CORE_HTTP_ERROR',f'CORE HTTP {r["status"]}',r['bytes'][:400].decode('utf-8','replace'))
    try:data=json.loads(r['bytes'].decode('utf-8','replace'))
    except Exception as e:raise SourceError('CORE_INVALID_JSON',str(e))
    out=[]
    for w in data.get('results',[]):
        authors=w.get('authors') or []
        author_names=', '.join(norm(a.get('name') if isinstance(a,dict) else a) for a in authors[:8])
        doi=norm(w.get('doi')).replace('https://doi.org/','') or None
        urls=w.get('sourceFulltextUrls') or []; u=w.get('downloadUrl') or (f'https://doi.org/{doi}' if doi else None) or (urls[0] if urls else None) or (f'https://core.ac.uk/works/{w.get("id")}' if w.get('id') else None)
        if not u:continue
        out.append({'source':'core','title':norm(w.get('title')),'url':u,'snippet':norm(w.get('abstract') or w.get('fullText'))[:1800],'doi':doi,'authors':author_names,'year':w.get('yearPublished'),'open_access':True,'core_id':w.get('id'),'provider':'CORE API v3'})
    return out,{'total_hits':data.get('totalHits'),'offset':data.get('offset'),'limit':data.get('limit'),'authenticated':bool(key)}

def _xml_local(tag):return tag.rsplit('}',1)[-1].lower()
def base_search(query,n=20,offset=0):
    params={'func':'PerformSearch','query':query,'boost':'oa','hits':min(100,max(1,n)),'offset':max(0,offset)}
    r=get(BASE_URL,params,timeout=30,max_bytes=5_000_000)
    text=r['bytes'].decode('utf-8','replace')
    if '<error>' in text.lower():
        msg=norm(re.sub(r'<[^>]+>',' ',text))
        # BASE sometimes IP-blocks direct clients. Use a SearXNG instance's official BASE engine, not a site: search.
        rows,errs=searx_search(query,n=n,engines='base',instances=4,pages=2)
        if rows:
            for x in rows:x.update({'source':'base','provider':'BASE official API via SearXNG BASE engine'})
            return rows,{'direct':'BLOCKED_BY_BASE','fallback':'SEARXNG_BASE_ENGINE','detail':msg[:240],'errors':errs}
        raise SourceError('BASE_BROWSER_REQUIRED',msg[:300],{'official_web_template':BASE_WEB_SEARCH_TEMPLATE,'reason':'BASE public web search is protected by Anubis and requires a real browser session; no challenge bypass is attempted'})
    if r['status']>=400:raise SourceError('BASE_HTTP_ERROR',f'BASE HTTP {r["status"]}')
    try:root=ET.fromstring(text)
    except Exception as e:raise SourceError('BASE_INVALID_XML',str(e))
    out=[]
    candidates=[]
    for el in root.iter():
        if _xml_local(el.tag) in ('document','record','result','hit'):candidates.append(el)
    if not candidates:candidates=list(root)
    for node in candidates:
        fields={}
        for el in node.iter():
            k=_xml_local(el.tag); v=norm(el.text)
            if v and k not in fields:fields[k]=v
        title=fields.get('dctitle') or fields.get('title') or fields.get('dc:title')
        u=fields.get('dclink') or fields.get('url') or fields.get('link') or fields.get('identifier') or fields.get('dcidentifier')
        desc=fields.get('dcdescription') or fields.get('description') or fields.get('abstract') or ''
        if title and u and str(u).startswith(('http://','https://')):
            out.append({'source':'base','title':title,'url':u,'snippet':desc[:1800],'open_access':True,'provider':'BASE official search API'})
            if len(out)>=n:break
    return out,{'direct':'OK'}

def openalex_search(query,n=20):
    d=get_json('https://api.openalex.org/works',{'search':query,'per-page':min(100,n)},timeout=30);out=[]
    for w in d.get('results',[]):
        doi=norm(w.get('doi')).replace('https://doi.org/','') or None; oa=w.get('open_access') or {}; loc=w.get('best_oa_location') or {}
        u=loc.get('landing_page_url') or loc.get('pdf_url') or w.get('doi') or w.get('id')
        if u:out.append({'source':'openalex','title':norm(w.get('display_name')),'url':u,'snippet':norm((w.get('primary_location') or {}).get('source',{}).get('display_name')),'doi':doi,'open_access':bool(oa.get('is_oa')),'oa_url':oa.get('oa_url'),'year':w.get('publication_year'),'provider':'OpenAlex API'})
    return out,{'count':len(out)}

def crossref_search(query,n=20):
    d=get_json('https://api.crossref.org/works',{'query':query,'rows':min(100,n)},timeout=30);out=[]
    for w in (d.get('message') or {}).get('items',[]):
        title=(w.get('title') or [''])[0];doi=w.get('DOI');u=w.get('URL') or (f'https://doi.org/{doi}' if doi else None)
        if u:out.append({'source':'crossref','title':norm(title),'url':u,'snippet':norm(w.get('publisher')),'doi':doi,'provider':'Crossref API'})
    return out,{'count':len(out)}

def arxiv_search(query,n=20):
    r=get('https://export.arxiv.org/api/query',{'search_query':'all:'+query,'start':0,'max_results':min(100,n)},timeout=30,max_bytes=5_000_000); text=r['bytes'].decode('utf-8','replace');out=[]
    for e in re.findall(r'<entry>(.*?)</entry>',text,re.S):
        def field(name):
            m=re.search(fr'<{name}>(.*?)</{name}>',e,re.S);return norm(unescape(re.sub(r'<[^>]+>',' ',m.group(1)))) if m else ''
        u=field('id');title=field('title');summary=field('summary')
        if u:out.append({'source':'arxiv','title':title,'url':u,'snippet':summary[:1800],'open_access':True,'provider':'arXiv Atom API'})
    return out,{'count':len(out)}

def pubmed_search(query,n=20):
    ids=get_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi',{'db':'pubmed','term':query,'retmode':'json','retmax':min(100,n)},timeout=30).get('esearchresult',{}).get('idlist',[])
    if not ids:return [],{'count':0}
    d=get_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi',{'db':'pubmed','id':','.join(ids),'retmode':'json'},timeout=30);out=[]
    for pid in ids:
        w=(d.get('result') or {}).get(pid,{})
        out.append({'source':'pubmed','title':norm(w.get('title')),'url':f'https://pubmed.ncbi.nlm.nih.gov/{pid}/','snippet':norm(w.get('fulljournalname')),'external_id':pid,'provider':'NCBI E-utilities'})
    return out,{'count':len(out)}

def archive_search(query,n=20,page=1):
    d=get_json('https://archive.org/advancedsearch.php',{'q':query,'fl[]':['identifier','title','description','creator','date','mediatype'],'rows':min(100,n),'page':max(1,page),'output':'json'},timeout=35);out=[]
    for x in (d.get('response') or {}).get('docs',[]):
        ident=x.get('identifier');desc=x.get('description');desc=desc[0] if isinstance(desc,list) and desc else desc
        if ident:out.append({'source':'internet_archive','title':norm(x.get('title') or ident),'url':f'https://archive.org/details/{ident}','snippet':norm(desc)[:1800],'creator':x.get('creator'),'date':x.get('date'),'mediatype':x.get('mediatype'),'open_access':True,'provider':'Internet Archive Advanced Search'})
    return out,{'numFound':(d.get('response') or {}).get('numFound'),'page':page}

def wayback_snapshots(url,n=10):
    if not url or not url.startswith(("http://","https://")):return [],{"status":"NEEDS_URL"}
    n=max(1,min(200,n)); errors=[]; rows=None; provider=None
    # TimeMap provides the complete known timeline; this lets us sample across years instead of only the oldest N CDX rows.
    try:
        r=get("https://web.archive.org/web/timemap/json",{"url":url},timeout=35,max_bytes=8_000_000)
        if r["status"]>=400: raise SourceError("WAYBACK_TIMEMAP_HTTP",f"HTTP {r['status']}")
        full=json.loads(r["bytes"].decode("utf-8","replace"))
        if full and len(full)>1:
            head=full[0]; body=full[1:]; provider="Wayback TimeMap JSON"
            # Deduplicate by digest first, then sample evenly over the entire chronology.
            di=head.index("digest") if "digest" in head else None; uniq=[]; seen=set()
            for vals in body:
                key=(vals[di] if di is not None and di<len(vals) else tuple(vals[:3]))
                if key in seen: continue
                seen.add(key); uniq.append(vals)
            if len(uniq)>n:
                idxs=sorted(set(round(i*(len(uniq)-1)/(n-1)) if n>1 else len(uniq)-1 for i in range(n)))
                uniq=[uniq[i] for i in idxs]
            rows=[head,*uniq]
    except Exception as e: errors.append("TIMEMAP "+str(e)[:160])
    if not rows or len(rows)<2:
        params={"url":url,"output":"json","fl":"timestamp,original,statuscode,mimetype,digest","filter":"statuscode:200","collapse":"digest","limit":max(100,min(5000,n*50)),"from":"1996"}
        try:
            r=get("https://web.archive.org/cdx/search/cdx",params,timeout=25,max_bytes=8_000_000)
            if r["status"]<400:
                full=json.loads(r["bytes"].decode("utf-8","replace")); provider="Wayback CDX API"
                if full and len(full)>1:
                    head=full[0];body=full[1:]
                    if len(body)>n:
                        idxs=sorted(set(round(i*(len(body)-1)/(n-1)) if n>1 else len(body)-1 for i in range(n)))
                        body=[body[i] for i in idxs]
                    rows=[head,*body]
            else: errors.append(f"CDX HTTP {r['status']}")
        except Exception as e: errors.append("CDX "+str(e)[:160])
    if not rows or len(rows)<2:
        try:
            d=get_json("https://archive.org/wayback/available",{"url":url},timeout=20); snap=((d.get("archived_snapshots") or {}).get("closest") or {})
            if snap.get("available"):
                return [{"source":"wayback","title":f"Wayback {snap.get('timestamp')} — {url}","url":snap.get("url"),"snippet":f"closest archived snapshot status {snap.get('status')}","original_url":url,"timestamp":snap.get("timestamp"),"provider":"Wayback Availability API"}],{"count":1,"provider":"Wayback Availability API","errors":errors}
        except Exception as e: errors.append("AVAILABLE "+str(e)[:160])
        raise SourceError("WAYBACK_UNAVAILABLE","All official Wayback endpoints failed",errors)
    head=rows[0];out=[];seen=set()
    for vals in rows[1:]:
        rec=dict(zip(head,vals));ts=rec.get("timestamp");orig=rec.get("original");digest=rec.get("digest");key=digest or (ts,orig)
        if not ts or not orig or key in seen:continue
        seen.add(key);out.append({"source":"wayback","title":f"Wayback {ts} — {orig}","url":f"https://web.archive.org/web/{ts}id_/{orig}","snippet":f"{rec.get('mimetype','')} {rec.get('statuscode','')}".strip(),"original_url":orig,"timestamp":ts,"provider":provider})
        if len(out)>=n:break
    return out,{"count":len(out),"provider":provider,"errors":errors}

_GITHUB_RATE_LIMIT_UNTIL=0.0
_GITHUB_SEARCH_LOCK=threading.Lock()

def _github_rate_limited_text(text):
    t=norm(text).lower()
    return ('rate limit' in t) or ('api rate limit exceeded' in t) or ('secondary rate limit' in t)

def github_search(query,n=20):
    global _GITHUB_RATE_LIMIT_UNTIL
    with _GITHUB_SEARCH_LOCK:
        return _github_search_locked(query,n)

def _github_search_locked(query,n=20):
    global _GITHUB_RATE_LIMIT_UNTIL
    out=[];meta={'providers':[]}
    now=time.time()
    if now < _GITHUB_RATE_LIMIT_UNTIL:
        meta.update({'rate_limited':True,'circuit_open':True,'retry_after_sec':max(1,int(_GITHUB_RATE_LIMIT_UNTIL-now)),'note':'GitHub search skipped after a rate-limit response; other research sources continue.'})
        return out,meta
    token=os.environ.get('GITHUB_TOKEN','').strip();h={'Accept':'application/vnd.github+json'}
    if token:h['Authorization']='Bearer '+token
    try:
        d=get_json('https://api.github.com/search/repositories',{'q':query,'per_page':min(50,n),'sort':'updated'},timeout=25,headers=h)
        meta['providers'].append('GitHub REST repository search')
        for r in d.get('items',[]):out.append({'source':'github','kind':'repository','title':r.get('full_name'),'url':r.get('html_url'),'snippet':norm(r.get('description')),'stars':r.get('stargazers_count'),'updated_at':r.get('updated_at'),'provider':'GitHub REST Search API'})
    except Exception as e:
        msg=str(e)[:300];meta['repo_error']=msg
        if _github_rate_limited_text(msg) or 'HTTP 403' in msg:
            _GITHUB_RATE_LIMIT_UNTIL=time.time()+300
            meta.update({'rate_limited':True,'circuit_open':True,'retry_after_sec':300})
            return out,meta
    # gh uses authenticated GitHub Search API when available, enabling code/issues search without any mutation.
    try:
        gh='gh'
        pr=subprocess.run([gh,'api','--method','GET','search/code','-f',f'q={query}','-f',f'per_page={min(30,n)}'],capture_output=True,text=True,timeout=35,encoding='utf-8',errors='replace')
        if pr.returncode==0:
            d=json.loads(pr.stdout);meta['providers'].append('gh api GET search/code')
            for r in d.get('items',[]):
                repo=(r.get('repository') or {}).get('full_name');u=r.get('html_url')
                if u:out.append({'source':'github','kind':'code','title':f'{repo}: {r.get("path") or r.get("name") or "code"}','url':u,'snippet':norm(r.get('path')),'repository':repo,'provider':'GitHub Code Search API via gh GET'})
        else:
            msg=norm(pr.stderr)[:300];meta['code_error']=msg
            if _github_rate_limited_text(msg):
                _GITHUB_RATE_LIMIT_UNTIL=time.time()+300
                meta.update({'rate_limited':True,'circuit_open':True,'retry_after_sec':300})
                return out,meta
        pi=subprocess.run([gh,'api','--method','GET','search/issues','-f',f'q={query}','-f',f'per_page={min(30,n)}'],capture_output=True,text=True,timeout=35,encoding='utf-8',errors='replace')
        if pi.returncode==0:
            d=json.loads(pi.stdout);meta['providers'].append('gh api GET search/issues')
            for r in d.get('items',[]):
                u=r.get('html_url')
                if u:out.append({'source':'github','kind':'issue_or_pr','title':norm(r.get('title')),'url':u,'snippet':norm(r.get('body'))[:1200],'repository_url':r.get('repository_url'),'provider':'GitHub Issues Search API via gh GET'})
        else:
            msg=norm(pi.stderr)[:300];meta['issues_error']=msg
            if _github_rate_limited_text(msg):
                _GITHUB_RATE_LIMIT_UNTIL=time.time()+300
                meta.update({'rate_limited':True,'circuit_open':True,'retry_after_sec':300})
    except Exception as e:meta['gh_error']=str(e)[:180]
    seen=set();ded=[]
    for x in out:
        u=x.get('url')
        if u and u not in seen:seen.add(u);ded.append(x)
        if len(ded)>=max(n,20):break
    return ded,meta

def _flatten_osint(node,path=()):
    out=[]
    if not isinstance(node,dict):return out
    name=norm(node.get('name'));typ=node.get('type');cur=path+((name,) if name else ())
    if typ=='url' and node.get('url'):
        out.append({'name':name,'url':node.get('url'),'description':norm(node.get('description')),'bestFor':norm(node.get('bestFor')),'input':norm(node.get('input')),'output':norm(node.get('output')),'status':node.get('status'),'pricing':node.get('pricing'),'api':node.get('api'),'registration':node.get('registration'),'localInstall':node.get('localInstall'),'deprecated':node.get('deprecated'),'opsec':node.get('opsec'),'path':' > '.join(cur[:-1])})
    for c in node.get('children') or []:out.extend(_flatten_osint(c,cur))
    return out

def osint_framework_search(query,n=30):
    d=get_json(OSINT_TREE,timeout=30);tools=_flatten_osint(d);qt=toks(query);ranked=[]
    for t in tools:
        if t.get('deprecated') is True:continue
        blob=' '.join(str(t.get(k) or '') for k in ('name','description','bestFor','input','output','path'))
        ov=len(qt & toks(blob));phrase=1 if norm(query).lower() in blob.lower() else 0
        if ov==0 and not phrase:continue
        score=ov*8+phrase*30+(5 if t.get('status')=='live' else 0)+(3 if str(t.get('pricing')).lower()=='free' else 0)+(2 if t.get('api') else 0)
        ranked.append((score,t))
    ranked.sort(key=lambda z:(-z[0],z[1]['name']))
    out=[]
    for score,t in ranked[:n]:
        out.append({'source':'osint_framework','title':t['name'],'url':t['url'],'snippet':norm(f"{t['description']} Best for: {t['bestFor']} Input: {t['input']} Output: {t['output']}")[:1800],'osint_path':t['path'],'osint_status':t['status'],'pricing':t['pricing'],'api':t['api'],'registration':t['registration'],'opsec':t['opsec'],'score_hint':score,'provider':'OSINT Framework arf.json tree'})
    return out,{'tree_tools':len(tools),'matched':len(ranked),'source':'lockfale/OSINT-Framework public/arf.json'}

def shodan_search(query,n=20):
    ips=[]
    for s in re.findall(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])',query):
        try:
            ip=ipaddress.ip_address(s)
            if ip.version==4 and ip.is_global:ips.append(str(ip))
        except Exception:pass
    out=[];meta={'internetdb_ips':ips}
    for ip in ips[:10]:
        try:
            d=get_json('https://internetdb.shodan.io/'+ip,timeout=20)
            out.append({'source':'shodan_public','title':f'Shodan InternetDB {ip}','url':'https://www.shodan.io/host/'+ip,'snippet':norm(json.dumps(d,ensure_ascii=False))[:1800],'ip':ip,'provider':'Shodan InternetDB public API'})
        except Exception as e:meta.setdefault('internetdb_errors',[]).append({'ip':ip,'error':str(e)[:120]})
    key=os.environ.get('SHODAN_API_KEY','').strip()
    if key:
        d=get_json('https://api.shodan.io/shodan/host/search',{'key':key,'query':query,'page':1},timeout=30);meta['full_search']='SHODAN_API'
        for m in d.get('matches',[])[:n]:
            ip=m.get('ip_str');port=m.get('port');u=f'https://www.shodan.io/host/{ip}' if ip else 'https://www.shodan.io/'
            out.append({'source':'shodan_public','title':f'{ip}:{port}' if ip else 'Shodan host','url':u,'snippet':norm(m.get('data'))[:1800],'ip':ip,'port':port,'provider':'Shodan Host Search API'})
    elif not ips:meta['full_search']='API_KEY_REQUIRED';meta['note']='No fake site-search fallback is used.'
    return out[:n],meta

def ahmia_search(query,n=20):
    r=get('https://ahmia.fi/search/',{'q':query},timeout=25);html=r['bytes'].decode('utf-8','replace');out=[];seen=set()
    for u,title in re.findall(r'href=["\']([^"\']+\.onion[^"\']*)["\'][^>]*>(.*?)</a>',html,re.I|re.S):
        u=unescape(u)
        if u in seen:continue
        seen.add(u);out.append({'source':'ahmia','title':norm(re.sub(r'<[^>]+>',' ',unescape(title))) or u,'url':u,'snippet':'Ahmia indexed onion result','onion':True,'provider':'Ahmia search index'})
        if len(out)>=n:break
    return out,{'count':len(out)}

def torch_search(query,n=20,allow_onion=False):
    if not allow_onion:raise SourceError('ONION_OPT_IN_REQUIRED','Torch requires explicit allow_onion=true')
    proxy=tor_proxy()
    if not proxy:raise SourceError('TOR_NOT_RUNNING','Torch requires an active local Tor SOCKS proxy; Fast Hands will not auto-start Tor')
    candidates=[(TORCH_ONION.rstrip('/')+'/',{'q':query}),(TORCH_ONION.rstrip('/')+'/search',{'q':query}),(TORCH_ONION.rstrip('/')+'/search',{'query':query})]
    errors=[]
    for url,params in candidates:
        try:
            r=get(url,params,timeout=35,proxy=proxy,max_bytes=2_000_000);html=r['bytes'].decode('utf-8','replace');out=[];seen=set()
            for u,title in re.findall(r'href=["\']([^"\']+\.onion[^"\']*)["\'][^>]*>(.*?)</a>',html,re.I|re.S):
                u=urljoin(r['url'],unescape(u))
                if u in seen:continue
                seen.add(u);out.append({'source':'torch','title':norm(re.sub(r'<[^>]+>',' ',unescape(title))) or u,'url':u,'snippet':'Torch indexed onion result','onion':True,'provider':'Torch onion search'})
                if len(out)>=n:break
            if out:return out,{'endpoint':r['url'],'count':len(out)}
        except Exception as e:errors.append(str(e)[:160])
    raise SourceError('TORCH_SEARCH_FAILED','Torch did not return parseable results',errors)


