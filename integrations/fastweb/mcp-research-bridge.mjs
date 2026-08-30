import fssync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OPTIONAL_HOME = process.env.FAST_HANDS_DEEP_RESEARCH_HOME ? path.resolve(process.env.FAST_HANDS_DEEP_RESEARCH_HOME) : path.resolve(ROOT, '..', '..', '..', 'DeepResearchMCP');
const TOOL_SEARCH_ENTRY = process.env.FAST_HANDS_DEEP_TOOL_SEARCH || path.join(OPTIONAL_HOME, 'mcp-tool-search', 'dist', 'index.js');
const TOOL_SEARCH_CATALOG = process.env.FAST_HANDS_DEEP_TOOL_CATALOG || path.join(OPTIONAL_HOME, 'mcp-tool-search', 'catalog.json');
const MAGG_PYTHON = process.env.FAST_HANDS_DEEP_MAGG_PYTHON || path.join(OPTIONAL_HOME, 'magg', process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const MAGG_CONFIG = process.env.FAST_HANDS_DEEP_MAGG_CONFIG || path.join(OPTIONAL_HOME, 'magg', '.magg', 'config.json');

function safeEnv(extra={}) {
  const keep=['PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','USERPROFILE','HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','COMSPEC','PATHEXT'];
  const env={};
  for(const k of keep) if(process.env[k]) env[k]=process.env[k];
  return {...env,...extra};
}
function textContent(result){ return (result?.content||[]).filter(x=>x?.type==='text').map(x=>String(x.text||'')).join('\n').slice(0,120000); }
async function stdioCall({command,args=[],env={},tool,arguments:toolArgs={},timeoutMs=60000}){
  if(!fssync.existsSync(command)) return {ok:false,error:`missing command: ${command}`};
  const client=new Client({name:'fast-hands-deep-research-mcp',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  const transport=new StdioClientTransport({command,args,env:safeEnv(env),stderr:'ignore'});
  let timer;
  try{
    await client.connect(transport);
    const tools=(await client.listTools(undefined,{cacheMode:'refresh'})).tools||[];
    if(!tools.some(t=>t.name===tool)) return {ok:false,error:`tool not found: ${tool}`,available:tools.map(t=>t.name)};
    const call=client.callTool({name:tool,arguments:toolArgs});
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`timeout ${timeoutMs}ms`)),timeoutMs)});
    const r=await Promise.race([call,timeout]);
    return {ok:!r.isError,isError:!!r.isError,text:textContent(r),structuredContent:r.structuredContent??null};
  }catch(error){return {ok:false,error:String(error?.message||error).slice(0,1000)};}
  finally{clearTimeout(timer);await client.close().catch(()=>{});}
}
function toolSearchCall(tool,arguments_,timeoutMs=60000){
  return stdioCall({command:process.execPath,args:[TOOL_SEARCH_ENTRY],env:{MCP_TOOL_SEARCH_CATALOG:TOOL_SEARCH_CATALOG},tool,arguments:arguments_,timeoutMs});
}
function parseFoundTools(text){
  const rows=[];
  for(const m of String(text||'').matchAll(/\*\*([^:*\n]+):([^*\n]+)\*\*\s+Ă˘â‚¬â€ť\s+([^\n]+)/g)) rows.push({server:m[1].trim(),tool:m[2].trim(),description:m[3].trim()});
  return rows.slice(0,30);
}
export function deepMcpCapabilities(){
  return {
    ok:fssync.existsSync(TOOL_SEARCH_ENTRY)&&fssync.existsSync(TOOL_SEARCH_CATALOG),
    domain:'EXTERNAL_ONLY',onDemand:true,persistentWrites:false,
    toolSearch:{entry:TOOL_SEARCH_ENTRY,catalog:TOOL_SEARCH_CATALOG,available:fssync.existsSync(TOOL_SEARCH_ENTRY)&&fssync.existsSync(TOOL_SEARCH_CATALOG)},
    magg:{python:MAGG_PYTHON,config:MAGG_CONFIG,available:fssync.existsSync(MAGG_PYTHON)},
  };
}
export async function deepMcpResearch(query,{mode='deep'}={}){
  const started=Date.now();
  const result={ok:false,domain:'EXTERNAL_ONLY',persistentWrites:false,query,mode,toolDiscovery:null,academicEvidence:null,academicSpecialistEvidence:null,mcpCandidates:null,errors:[]};
  if(!fssync.existsSync(TOOL_SEARCH_ENTRY)||!fssync.existsSync(TOOL_SEARCH_CATALOG)){
    result.errors.push('deep-tool-search not installed'); return {...result,elapsedMs:Date.now()-started};
  }
  const maxResults=mode==='quick'?8:mode==='exhaustive'?24:16;
  const discovery=await toolSearchCall('search_tools',{query,max_results:maxResults},45000);
  result.toolDiscovery={ok:discovery.ok,tools:parseFoundTools(discovery.text),raw:discovery.text?.slice(0,16000)||null,error:discovery.error||null};

  const per=mode==='quick'?2:mode==='exhaustive'?8:4;
  const queries=[
    {searcher:'semantic',query,max_results:per},
    {searcher:'crossref',query,max_results:per},
  ];
  const academic=await toolSearchCall('call_tool',{server:'academic-mcp',tool:'paper_search',arguments:{query_list:queries}},mode==='exhaustive'?150000:90000);
  result.academicEvidence={ok:academic.ok,text:academic.text?.slice(0,50000)||null,error:academic.error||null};

  // Explicitly call only the zero-persistence read-only specialist search tool.
  // The catalog entry sets ACADEMIC_CACHE_DISABLED=1, so this path performs
  // no SQLite cache/review reads or writes and never imports into LOCAL corpus.
  const specialist=await toolSearchCall('call_tool',{server:'academic-research',tool:'smart_search',arguments:{query,num_results:per,sources:['openalex','crossref','pubmed'],include_preprints:true,brief:true}},mode==='exhaustive'?150000:90000);
  result.academicSpecialistEvidence={ok:specialist.ok,text:specialist.text?.slice(0,50000)||null,error:specialist.error||null};
  if(mode!=='quick' && fssync.existsSync(MAGG_PYTHON)){
    const magg=await stdioCall({command:MAGG_PYTHON,args:['-m','magg.cli','--config',MAGG_CONFIG,'serve'],tool:'magg_search_servers',arguments:{query,limit:mode==='exhaustive'?5:3},timeoutMs:60000});
    result.mcpCandidates={ok:magg.ok,text:magg.text?.slice(0,20000)||null,structuredContent:magg.structuredContent??null,error:magg.error||null};
  }
  result.ok=!!(result.toolDiscovery?.ok||result.academicEvidence?.ok||result.academicSpecialistEvidence?.ok||result.mcpCandidates?.ok);
  return {...result,elapsedMs:Date.now()-started};
}

