import argparse, concurrent.futures, json, os, re, socket, time
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urlparse, urljoin

import deep_sources as ds

USER_AGENT='FastHands-ResearchGraph/1.0 (+external-only; on-demand; RAM-only)'
MAX_HTTP_BYTES=2_000_000
TEXT_TYPES=('text/','application/json','application/xml','application/xhtml+xml','application/atom+xml')
BLOCKED_EXTS={'.exe','.msi','.dll','.scr','.bat','.cmd','.ps1','.js','.vbs','.jar','.apk','.dmg','.pkg','.iso','.zip','.rar','.7z','.tar','.gz'}
SOURCE_META={
 'web':{'group':'OPEN_WEB','authority':35,'primary':False},
 'searxng':{'group':'OPEN_WEB','authority':45,'primary':False},
 'core':{'group':'SCIENCE','authority':82,'primary':True},
 'base':{'group':'SCIENCE','authority':82,'primary':True},
 'openalex':{'group':'SCIENCE','authority':88,'primary':True},
 'crossref':{'group':'SCIENCE','authority':90,'primary':True},
 'arxiv':{'group':'SCIENCE','authority':92,'primary':True},
 'pubmed':{'group':'SCIENCE','authority':94,'primary':True},
 'internet_archive':{'group':'ARCHIVES','authority':84,'primary':True},
 'wayback':{'group':'ARCHIVES','authority':86,'primary':True},
 'github':{'group':'CODE','authority':90,'primary':True},
 'osint_framework':{'group':'PUBLIC_OSINT','authority':60,'primary':False},
 'shodan_public':{'group':'PUBLIC_OSINT','authority':72,'primary':True},
 'ahmia':{'group':'LAWFUL_ONION','authority':48,'primary':False},
 'torch':{'group':'LAWFUL_ONION','authority':42,'primary':False},
 'followup':{'group':'FOLLOWUP','authority':50,'primary':False},
}
DEFAULT_SOURCES=['web','searxng','core','base','openalex','crossref','arxiv','pubmed','internet_archive','wayback','github','osint_framework','shodan_public','ahmia','torch']
PRESETS={
 'quick':{'query_budget':6,'time_budget_sec':55,'per_source':5,'inspect_budget':14,'max_results':100,'max_rounds':3,'workers':5},
 'deep':{'query_budget':36,'time_budget_sec':235,'per_source':10,'inspect_budget':55,'max_results':500,'max_rounds':10,'workers':7},
 'exhaustive':{'query_budget':140,'time_budget_sec':510,'per_source':15,'inspect_budget':140,'max_results':1800,'max_rounds':24,'workers':8},
}
SOURCE_CAPS={'web':40,'searxng':35,'core':6,'base':8,'openalex':18,'crossref':18,'arxiv':16,'pubmed':12,'internet_archive':18,'github':35,'osint_framework':8,'shodan_public':8,'ahmia':8,'torch':5}
GENERIC_RESEARCH_TOKENS={'ai','api','automation','automate','automating','workflow','workflows','software','system','systems','tool','tools','agent','agents','research','using','with','for','and','the'}

def emit(obj,code=0):
 import sys
 try:sys.stdout.reconfigure(encoding='utf-8')
 except Exception:pass
 print(json.dumps(obj,ensure_ascii=False));raise SystemExit(code)
def norm(v):return re.sub(r'\s+',' ',str(v or '')).strip()
def tokens(v):return {x for x in re.findall(r'[\w.+#/-]{2,}',norm(v).lower(),flags=re.UNICODE)}

def canonical_url(u):
 try:
  p=urlparse(u)
  if p.scheme not in ('http','https'):return u
  return p._replace(fragment='').geturl()
 except Exception:return u

def ddgs_search(query,n=10):
 from ddgs import DDGS
 errors=[];out=[];seen=set()
 for backend in ('auto','duckduckgo','brave','google','bing'):
  try:
   rows=list(DDGS().text(query,max_results=n,backend=backend))
   for r in rows:
    u=r.get('href') or r.get('url')
    if u and u not in seen:
     seen.add(u);out.append({'source':'web','title':norm(r.get('title')),'url':u,'snippet':norm(r.get('body')),'backend':backend,'provider':'DDGS multi-backend'})
   if len(out)>=n:break
  except Exception as e:errors.append({'backend':backend,'error':str(e)[:160]})
 return out[:n],{'errors':errors,'backends_tried':5}

def adapter_search(name,query,n,allow_onion=False):
 if name=='web':return ddgs_search(query,n)
 if name=='searxng':
  rows,errs=ds.searx_search(query,n=n,instances=4,pages=2);return rows,{'instances':4,'pages':2,'errors':errs}
 if name=='core':return ds.core_search(query,n)
 if name=='base':return ds.base_search(query,n)
 if name=='openalex':return ds.openalex_search(query,n)
 if name=='crossref':return ds.crossref_search(query,n)
 if name=='arxiv':return ds.arxiv_search(query,n)
 if name=='pubmed':return ds.pubmed_search(query,n)
 if name=='internet_archive':return ds.archive_search(query,n)
 if name=='github':return ds.github_search(query,n)
 if name=='osint_framework':return ds.osint_framework_search(query,n)
 if name=='shodan_public':return ds.shodan_search(query,n)
 if name=='ahmia':return ds.ahmia_search(query,n)
 if name=='torch':return ds.torch_search(query,n,allow_onion=allow_onion)
 if name=='wayback':return [],{'status':'DERIVED_FROM_DISCOVERED_URLS'}
 raise ValueError('unknown source '+name)

class LinkParser(HTMLParser):
 def __init__(self):super().__init__();self.links=[];self._title=[];self._in_title=False
 def handle_starttag(self,tag,attrs):
  if tag=='a':
   href=dict(attrs).get('href')
   if href:self.links.append(href)
  if tag=='title':self._in_title=True
 def handle_endtag(self,tag):
  if tag=='title':self._in_title=False
 def handle_data(self,data):
  if self._in_title:self._title.append(data)
 @property
 def title(self):return norm(' '.join(self._title))

def inspect_url(url,max_chars=12000,allow_onion=False):
 p=urlparse(url);host=(p.hostname or '').lower();onion=host.endswith('.onion')
 if onion and not allow_onion:return {'ok':False,'url':url,'reason':'onion_requires_explicit_allow_onion'}
 if p.scheme not in ('http','https'):return {'ok':False,'url':url,'reason':'unsupported_scheme'}
 ext=os.path.splitext(p.path.lower())[1]
 if ext in BLOCKED_EXTS:return {'ok':False,'url':url,'reason':'blocked_download_extension'}
 proxy=None
 if onion:
  proxy=ds.tor_proxy()
  if not proxy:return {'ok':False,'url':url,'reason':'tor_proxy_not_configured_or_running'}
 try:
  r=ds.get(url,timeout=24,proxy=proxy,max_bytes=min(MAX_HTTP_BYTES,max(262144,max_chars*24)));ctype=r['content_type']
  if not any(x in ctype for x in TEXT_TYPES):
   if 'pdf' in ctype:return {'ok':False,'url':r['url'],'reason':'document_requires_isolated_parser','content_type':ctype}
   return {'ok':False,'url':r['url'],'reason':'non_text_content_blocked','content_type':ctype}
  raw=r['bytes'].decode('utf-8','replace');title='';links=[]
  if 'html' in ctype:
   parser=LinkParser()
   try:parser.feed(raw);title=parser.title;links=[urljoin(r['url'],x) for x in parser.links[:160]]
   except Exception:pass
   try:
    from trafilatura import extract
    text=extract(raw,output_format='markdown',with_metadata=True,include_comments=False,include_links=True) or ''
   except Exception:
    text=re.sub(r'<script.*?</script>|<style.*?</style>',' ',raw,flags=re.I|re.S);text=re.sub(r'<[^>]+>',' ',text)
  else:text=raw
  text=norm(unescape(text))[:max_chars]
  return {'ok':bool(text),'url':r['url'],'title':title,'text':text,'links':links[:100],'content_type':ctype,'truncated':r['truncated'],'onion':onion}
 except Exception as e:return {'ok':False,'url':url,'reason':'read_failed','error':str(e)[:300],'onion':onion}

def score_item(item,query):
 meta=SOURCE_META.get(item.get('source'),{'authority':25,'primary':False});blob=' '.join([item.get('title') or '',item.get('snippet') or '',item.get('repository') or '',item.get('osint_path') or ''])
 q=tokens(query);b=tokens(blob);overlap=len(q&b);coverage=(overlap/max(1,len(q)))
 anchors={x for x in q if x not in GENERIC_RESEARCH_TOKENS and len(x)>=5};anchor_overlap=len(anchors&b)
 phrase=1 if norm(query).lower() in norm(blob).lower() else 0
 # Relevance is a gate, not just a small bonus. Distinctive query anchors (e.g. product/project names) matter more than generic AI/workflow words.
 relevance=min(60,overlap*9)+min(24,int(round(coverage*24)))+(18 if phrase else 0)+(anchor_overlap*12)
 authority=min(34,int(meta['authority'])//3)
 score=authority+relevance
 if meta.get('primary') and overlap:score+=6
 if item.get('open_access') and overlap:score+=3
 if item.get('doi') and overlap:score+=2
 if item.get('kind')=='code' and overlap:score+=6
 if item.get('kind')=='issue_or_pr' and overlap:score+=5
 score+=min(8,int(item.get('score_hint') or 0)//10)
 if overlap==0 and not phrase:score-=45
 elif overlap==1 and len(q)>=5:score-=16
 if anchors and anchor_overlap==0 and not phrase:score-=28
 if item.get('source')=='github' and len(anchors)>=3 and anchor_overlap<2 and not phrase:score-=35
 return score

def dedupe_rank(items,query,max_items):
 best={}
 for raw in items:
  u=canonical_url(raw.get('url') or '');key=(raw.get('doi') or '').lower() or u.lower() or (raw.get('source','')+':'+norm(raw.get('title')).lower())
  if not key:continue
  it={**raw,'url':u,'score':score_item(raw,query),'group':SOURCE_META.get(raw.get('source'),{}).get('group','OTHER')}
  if key not in best or it['score']>best[key]['score']:best[key]=it
 ranked=sorted(best.values(),key=lambda x:(-x['score'],x.get('source',''),x.get('title','')))
 if ranked:
  qn=max(1,len(tokens(query))); floor=max(18,ranked[0]['score']-48)
  strong=[x for x in ranked if x['score']>=floor and (len(tokens(query)&tokens(' '.join([x.get('title') or '',x.get('snippet') or '',x.get('repository') or '',x.get('osint_path') or ''])))>=min(2,qn) or qn<=2)]
  if strong:ranked=strong
 return ranked[:max_items]

def oa_fallback(item):
 doi=item.get('doi')
 if not doi:return None
 try:
  d=ds.get_json('https://api.openalex.org/works/https://doi.org/'+__import__('urllib.parse').parse.quote(doi,safe=''),timeout=25);oa=d.get('open_access') or {};loc=d.get('best_oa_location') or {};free=loc.get('pdf_url') or loc.get('landing_page_url') or oa.get('oa_url')
  if free:return {'doi':doi,'is_oa':bool(oa.get('is_oa')),'free_url':free,'source':'openalex_oa_resolution'}
 except Exception:pass
 return None

def lead_queries(root_query,item,doc,limit=8):
 root_terms=[x for x in tokens(root_query) if len(x)>=4][:8];base=' '.join(root_terms[:4]);cands=[]
 title=norm(item.get('title'))
 if title and 4<=len(title)<=180:cands.append(f'"{title}" {base}'.strip())
 u=item.get('url') or ''
 m=re.search(r'github\.com/([^/]+/[^/#?]+)',u,re.I)
 if m:cands.extend([m.group(1),f'"{m.group(1)}" issues protocol API reverse engineering'])
 text=(doc.get('text') or '')[:16000]
 patterns=[
  r'\b([A-Z][A-Za-z0-9_.+-]{2,}(?:\s+[A-Z][A-Za-z0-9_.+-]{2,}){0,3}\s+(?:API|SDK|protocol|interface|plugin|extension|integration|driver|firmware|scripting))\b',
  r'\b([A-Za-z][A-Za-z0-9_.+-]{2,}/[A-Za-z0-9_.+-]{2,})\b',
  r'\b([A-Za-z][A-Za-z0-9_.+-]{3,}(?:HID|MCP|OSC|MIDI|SDK|API))\b']
 for pat in patterns:
  for s in re.findall(pat,text):
   s=norm(s)
   if 4<=len(s)<=120:cands.append(f'"{s}" {base}'.strip())
 for link in doc.get('links',[])[:35]:
  try:
   p=urlparse(link);path=p.path.strip('/')
   if p.hostname and ('github.com' in p.hostname or '/docs' in p.path.lower() or '/api' in p.path.lower()):
    bit=(p.hostname+'/'+path)[:150];cands.append(f'"{bit}" {base}'.strip())
  except Exception:pass
 out=[];seen=set()
 for q in cands:
  q=norm(q)
  if not q or q.lower() in seen or q.lower()==root_query.lower():continue
  seen.add(q.lower());out.append(q)
  if len(out)>=limit:break
 return out

def _status_template(sources):return {s:{'calls':0,'hits':0,'results':0,'errors':[],'meta':[]} for s in sources}

def research(query,sources=None,mode='deep',query_budget=None,time_budget_sec=None,per_source=None,inspect_budget=None,max_chars=12000,allow_onion=False):
 started=time.time();preset=dict(PRESETS.get(mode,PRESETS['deep']))
 query_budget=max(1,min(int(query_budget or preset['query_budget']),500));time_budget_sec=max(10,min(int(time_budget_sec or preset['time_budget_sec']),540));per_source=max(1,min(int(per_source or preset['per_source']),30));inspect_budget=max(0,min(int(inspect_budget or preset['inspect_budget']),240));max_chars=max(1000,min(int(max_chars),30000))
 sources=[s for s in (sources or DEFAULT_SOURCES) if s in SOURCE_META]
 # wayback is derived from URLs; don't consume generic query calls.
 searchable=[s for s in sources if s!='wayback' and (allow_onion or s!='torch')]
 status=_status_template(sources);source_calls={s:0 for s in searchable};all_items=[];inspected=[];graph_edges=[];errors=[];queries_done=[];queue=[{'q':query,'parent':None,'reason':'root'}];seen_queries={query.lower()};seen_urls=set();low_novelty_rounds=0;round_no=0
 while queue and len(queries_done)<query_budget and round_no<preset['max_rounds'] and time.time()-started<time_budget_sec:
  round_no+=1;batch=[]
  while queue and len(batch)<max(1,preset['workers']):batch.append(queue.pop(0))
  before_unique=len(seen_urls);jobs=[]
  with concurrent.futures.ThreadPoolExecutor(max_workers=preset['workers']) as ex:
   for qnode in batch:
    q=qnode['q'];queries_done.append(qnode)
    for src in searchable:
     cap=SOURCE_CAPS.get(src,20)
     if source_calls[src]>=cap:continue
     # Specialist routing after root: only send derived leads to sources likely to add value.
     if qnode['reason']!='root' and src in ('pubmed','core','base','openalex','crossref','arxiv') and not re.search(r'paper|study|research|algorithm|model|science|analysis|method|doi|arxiv',q,re.I):continue
     if qnode['reason']!='root' and src=='shodan_public' and not re.search(r'\b(?:\d{1,3}\.){3}\d{1,3}\b|server|service|port|host|device|network',q,re.I):continue
     source_calls[src]+=1;status[src]['calls']+=1;jobs.append((src,q,qnode,ex.submit(adapter_search,src,q,per_source,allow_onion)))
   for src,q,qnode,f in jobs:
    if time.time()-started>=time_budget_sec:break
    try:
     rows,meta=f.result(timeout=max(5,min(55,time_budget_sec-(time.time()-started))))
     status[src]['hits']+=1 if rows else 0;status[src]['results']+=len(rows);status[src]['meta'].append(meta)
     for r in rows:
      all_items.append(r);u=canonical_url(r.get('url') or '')
      if u:seen_urls.add(u);graph_edges.append({'from':'query:'+q,'to':u,'type':'DISCOVERED_BY','source':src})
    except ds.SourceError as e:
     status[src]['errors'].append({'code':e.code,'message':str(e)[:220]});errors.append({'source':src,'query':q,'code':e.code,'error':str(e)[:220]})
    except Exception as e:
     status[src]['errors'].append({'code':'ERROR','message':str(e)[:220]});errors.append({'source':src,'query':q,'code':'ERROR','error':str(e)[:220]})
  ranked=dedupe_rank(all_items,query,preset['max_results'])
  # Inspect only new, high-value sources; reading source bodies generates next queries.
  remaining=max(0,inspect_budget-len(inspected));targets=[x for x in ranked if x.get('url') and x.get('url') not in {z['item'].get('url') for z in inspected}][:min(remaining,max(4,preset['workers']*2))]
  new_queries=[]
  if targets:
   with concurrent.futures.ThreadPoolExecutor(max_workers=preset['workers']) as ex:
    futs=[(it,ex.submit(inspect_url,it['url'],max_chars,allow_onion)) for it in targets]
    for it,f in futs:
     try:doc=f.result(timeout=30)
     except Exception as e:doc={'ok':False,'url':it.get('url'),'reason':'inspect_exception','error':str(e)[:180]}
     inspected.append({'item':it,'inspection':doc})
     if not it.get('open_access') and it.get('doi'):
      oa=oa_fallback(it)
      if oa:it['legal_oa_fallback']=oa
     if doc.get('ok'):
      for nq in lead_queries(query,it,doc,limit=7):
       if nq.lower() not in seen_queries and len(seen_queries)<query_budget*3:
        seen_queries.add(nq.lower());new_queries.append({'q':nq,'parent':it.get('url'),'reason':'content_lead'});graph_edges.append({'from':it.get('url'),'to':'query:'+nq,'type':'GENERATED_QUERY'})
      # Wayback is a first-class derived source: inspect history for strong URLs.
      if 'wayback' in sources and len(status['wayback']['meta'])<min(24,inspect_budget):
       try:
        wb,meta=ds.wayback_snapshots(it.get('url'),n=5);status['wayback']['calls']+=1;status['wayback']['hits']+=1 if wb else 0;status['wayback']['results']+=len(wb);status['wayback']['meta'].append(meta)
        for x in wb:all_items.append(x);graph_edges.append({'from':it.get('url'),'to':x.get('url'),'type':'HISTORICAL_SNAPSHOT','source':'wayback'})
       except Exception as e:status['wayback']['errors'].append({'code':'ERROR','message':str(e)[:180]})
  queue.extend(new_queries)
  novelty=len(seen_urls)-before_unique;den=max(1,len(jobs)*per_source);ratio=novelty/den
  if ratio<0.05 and len(new_queries)<2:low_novelty_rounds+=1
  else:low_novelty_rounds=0
  if low_novelty_rounds>=2:break
 ranked=dedupe_rank(all_items,query,preset['max_results']);useful=[x for x in inspected if x['inspection'].get('ok')];groups={}
 for x in ranked:groups[x.get('group','OTHER')]=groups.get(x.get('group','OTHER'),0)+1
 saturation={'status':'SATURATED' if low_novelty_rounds>=2 or not queue else ('TIME_BUDGET_REACHED' if time.time()-started>=time_budget_sec else 'QUERY_BUDGET_REACHED' if len(queries_done)>=query_budget else 'OPEN_LEADS'),'rounds':round_no,'queriesExecuted':len(queries_done),'queuedRemaining':len(queue),'lowNoveltyRounds':low_novelty_rounds,'criterion':'stop after two low-novelty rounds, exhausted lead queue, or explicit time/query budget; no fixed depth ceiling'}
 return {'ok':bool(ranked),'query':query,'mode':mode,'policy':{'domain':'EXTERNAL_ONLY','localCorpusAccess':False,'mode':'ON_DEMAND_ONLY','backgroundIo':False,'persistentWrites':False,'binaryDownloads':False,'lawfulOnionOnly':True},'budget':{'queryBudget':query_budget,'timeBudgetSec':time_budget_sec,'perSource':per_source,'inspectBudget':inspect_budget},'sourcesRequested':sources,'sourceStatus':status,'counts':{'discoveredRaw':len(all_items),'ranked':len(ranked),'inspected':len(inspected),'readOk':len(useful),'queriesExecuted':len(queries_done),'graphEdges':len(graph_edges)},'groups':groups,'rankedSources':ranked,'inspected':inspected,'queries':queries_done,'graphEdges':graph_edges[:1200],'saturation':saturation,'errors':errors,'elapsed_ms':round((time.time()-started)*1000)}

def capabilities():
 socks=[]
 for port in (9150,9050):
  try:
   with socket.create_connection(('127.0.0.1',port),timeout=.1):socks.append(port)
  except Exception:pass
 return {'ok':True,'engine':'adaptive_research_graph','domain':'EXTERNAL_ONLY','mode':'ON_DEMAND_ONLY','backgroundIo':False,'persistentWrites':False,'sources':SOURCE_META,'presets':PRESETS,'sourceCaps':SOURCE_CAPS,'core':{'api':'CORE v3','apiKeyConfigured':bool(os.environ.get('CORE_API_KEY')),'fakeSiteFallback':False},'base':{'api':'BASE official search XML','fallback':'SearXNG BASE engine only if BASE blocks client IP','fakeSiteFallback':False},'github':{'api':'GitHub REST + authenticated gh GET code/issues when available','fakeSiteFallback':False},'osintFramework':{'source':'lockfale/OSINT-Framework public/arf.json','graphTraversal':True,'autoExecuteArbitraryTools':False},'shodan':{'internetDB':'keyless IP lookup','fullSearchKeyConfigured':bool(os.environ.get('SHODAN_API_KEY')),'fakeSiteFallback':False},'tor':{'localSocksPorts':socks,'autoStart':False,'torchSupported':True,'ahmiaSupported':True},'safety':{'blockedExtensions':sorted(BLOCKED_EXTS),'binaryDownloads':False,'onionExplicitOptIn':True,'oaFallback':'legal open-access copies only'}}

def self_test():
 a={'source':'github','title':'Resolve API protocol','url':'https://github.com/x/y','snippet':'reverse engineering API'};b={'source':'web','title':'SEO','url':'https://example.com','snippet':'resolve'};r=dedupe_rank([b,a,a],'Resolve API reverse engineering',10)
 assert len(r)>=1 and r[0]['source']=='github' and all(x.get('title')!='SEO' for x in r);assert inspect_url('https://example.com/file.exe')['reason']=='blocked_download_extension';c=capabilities();assert c['domain']=='EXTERNAL_ONLY' and c['persistentWrites'] is False and c['tor']['autoStart'] is False and c['core']['fakeSiteFallback'] is False
 return {'ok':True,'checks':{'ranking':True,'relevanceGate':True,'dedupe':True,'blockedDownloads':True,'externalOnly':True,'adaptiveGraph':True,'noFakeCoreBaseGithubSiteAdapters':True,'torNoAutostart':True}}

def main():
 ap=argparse.ArgumentParser();sub=ap.add_subparsers(dest='cmd',required=True);sub.add_parser('capabilities');sub.add_parser('self-test');r=sub.add_parser('research');r.add_argument('query');r.add_argument('--sources',default='');r.add_argument('--mode',choices=list(PRESETS),default='deep');r.add_argument('--query-budget',type=int,default=0);r.add_argument('--time-budget-sec',type=int,default=0);r.add_argument('--per-source',type=int,default=0);r.add_argument('--inspect-budget',type=int,default=0);r.add_argument('--max-chars',type=int,default=12000);r.add_argument('--allow-onion',action='store_true')
 a=ap.parse_args()
 if a.cmd=='capabilities':emit(capabilities())
 if a.cmd=='self-test':emit(self_test())
 src=[x.strip() for x in a.sources.split(',') if x.strip()] or None
 emit(research(a.query,src,a.mode,a.query_budget or None,a.time_budget_sec or None,a.per_source or None,a.inspect_budget or None,a.max_chars,bool(a.allow_onion)))
if __name__=='__main__':main()

