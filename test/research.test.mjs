import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root=path.resolve(import.meta.dirname,'..');
const engine=path.join(root,'integrations','fastweb','research_engine.py');
const adapters=path.join(root,'integrations','fastweb','deep_sources.py');
const mcpBridge=path.join(root,'integrations','fastweb','mcp-research-bridge.mjs');
const server=fs.readFileSync(path.join(root,'server.mjs'),'utf8');
const src=fs.readFileSync(engine,'utf8');
const adapterSrc=fs.readFileSync(adapters,'utf8');
const bridgeSrc=fs.readFileSync(mcpBridge,'utf8');

test('deep research is external-only, adaptive and uses true source adapters',()=>{
  for(const name of ['web','searxng','core','base','openalex','crossref','arxiv','pubmed','internet_archive','wayback','github','osint_framework','shodan_public','ahmia','torch']) assert.match(src,new RegExp("'"+name+"'"));
  for(const forbidden of ['setInterval(','setTimeout(','watchdog','schedule.every','while True:']) assert.equal(src.includes(forbidden),false,forbidden);
  assert.match(src,/adaptive_research_graph/);
  assert.match(src,/EXTERNAL_ONLY/);
  assert.match(src,/persistentWrites/);
  assert.match(src,/blocked_download_extension/);
  assert.match(src,/onion_requires_explicit_allow_onion/);
  assert.match(src,/PRESETS/);
  assert.match(src,/query_budget/);
  assert.match(src,/lowNoveltyRounds/);
  assert.doesNotMatch(src,/--depth/);

  assert.match(adapterSrc,/api\.core\.ac\.uk\/v3\/search\/works/);
  assert.match(adapterSrc,/api\.base-search\.net\/cgi-bin\/BaseHttpSearchInterface\.fcgi/);
  assert.match(adapterSrc,/lockfale\/OSINT-Framework\/master\/public\/arf\.json/);
  assert.match(adapterSrc,/api\.github\.com\/search\/repositories/);
  assert.match(adapterSrc,/search\/code/);
  assert.match(adapterSrc,/search\/issues/);
  assert.match(adapterSrc,/internetdb\.shodan\.io/);
  assert.match(adapterSrc,/web\.archive\.org\/cdx\/search\/cdx/);
  assert.match(adapterSrc,/TORCH_ONION/);
  assert.doesNotMatch(adapterSrc,/site:core\.ac\.uk|site:base-search\.net|site:github\.com|site:shodan\.io|site:osintframework\.com/);

  assert.match(server,/fast_research_capabilities/);
  assert.match(server,/fast_external_research/);
  assert.match(server,/quick','deep','exhaustive/);
  assert.doesNotMatch(server,/fast_crawler_research/);
  const extStart=server.indexOf("server.registerTool('fast_external_research'");
  const extEnd=server.indexOf("server.registerTool('fast_web_search'",extStart);
  const extBlock=server.slice(extStart,extEnd);
  assert.doesNotMatch(extBlock,/buildContext|crawlerOpenInternal|crawlerOpenReadInternal|fast_context_build/);
  assert.match(extBlock,/EXTERNAL_ONLY/);
  assert.match(extBlock,/localCorpusAccess:false/);
});

test('deep research offline self-test passes when Python is available',(t)=>{
  const probes=process.platform==='win32'?['python.exe','python']:['python3','python'];
  let result=null;
  for(const exe of probes){const r=spawnSync(exe,[engine,'self-test'],{cwd:root,encoding:'utf8'});if(!r.error){result=r;break}}
  if(!result){t.skip('optional Python runtime unavailable');return}
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout.trim());
  assert.equal(out.ok,true);
  assert.equal(out.checks.externalOnly,true);
  assert.equal(out.checks.adaptiveGraph,true);
  assert.equal(out.checks.noFakeCoreBaseGithubSiteAdapters,true);
});

