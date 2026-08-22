import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Pool } from "pg";
import { readConfig } from "./config.js";
import { loadRootEnv } from "./env.js";

loadRootEnv();

const configured = new URL(process.env.TEST_DATABASE_URL ?? readConfig().databaseUrl);
if (!process.env.TEST_DATABASE_URL) configured.pathname = "/onlylove_e2e";
const databaseName = decodeURIComponent(configured.pathname.slice(1));
if (!/^[a-z_][a-z0-9_]*$/i.test(databaseName) || !databaseName.endsWith("_e2e")) {
  throw new Error("E2E dashboard only accepts a dedicated *_e2e database");
}

const pool = new Pool({ connectionString: configured.toString() });
const app = Fastify({ logger: false });
const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const logs: string[] = [];
let child: ChildProcessWithoutNullStreams | null = null;
let testState: {
  status: "idle" | "running" | "passed" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
} = { status: "idle", startedAt: null, endedAt: null, exitCode: null };

function record(chunk: Buffer) {
  logs.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}

function signalChild(
  runningChild: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && runningChild.pid) {
    try {
      process.kill(-runningChild.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group has already exited.
    }
  }
  runningChild.kill(signal);
}

async function stopChild() {
  const runningChild = child;
  if (!runningChild) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => signalChild(runningChild, "SIGKILL"), 5_000);
    runningChild.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    signalChild(runningChild, "SIGTERM");
  });
}

async function snapshot() {
  const [members, portraits, evaluations, recommendations, jobs, audit] =
    await Promise.all([
      pool.query(`
        SELECT m.id, m.email, m.nickname, m.gender, m.birth_date, m.height_cm,
               m.city, m.occupation, m.created_at,
               COUNT(p.id)::int AS portrait_versions,
               MAX(p.version)::int AS latest_portrait_version
          FROM members m
          LEFT JOIN portrait_versions p ON p.member_id = m.id
         WHERE m.role = 'member'
         GROUP BY m.id
         ORDER BY m.created_at`),
      pool.query(`
        SELECT p.id, m.email, m.nickname, p.version, p.match_profile,
               p.persona_context, p.created_at,
               (s.published_version_id = p.id) AS published
          FROM portrait_versions p
          JOIN members m ON m.id = p.member_id
          LEFT JOIN portrait_member_states s ON s.member_id = m.id
         ORDER BY m.created_at, p.version`),
      pool.query(`
        SELECT e.id, a.email AS member_a, COALESCE(a.nickname, a.email) AS name_a,
               b.email AS member_b, COALESCE(b.nickname, b.email) AS name_b,
               e.result, e.rubric_version, e.created_at,
               r.actual_model, r.input_tokens, r.output_tokens,
               r.latency_ms, r.estimated_cost_micro_cny
          FROM pair_evaluations e
          JOIN members a ON a.id = e.member_a_id
          JOIN members b ON b.id = e.member_b_id
          LEFT JOIN LATERAL (
            SELECT actual_model, input_tokens, output_tokens, latency_ms,
                   estimated_cost_micro_cny
              FROM agent_runs
             WHERE job_id = e.agent_job_id
             ORDER BY created_at DESC LIMIT 1
          ) r ON true
         ORDER BY e.created_at DESC`),
      pool.query(`
        SELECT r.id, m.email AS member_email,
               COALESCE(m.nickname, m.email) AS member_name,
               c.email AS candidate_email,
               COALESCE(c.nickname, c.email) AS candidate_name,
               r.reason, r.status, r.created_at
          FROM candidate_recommendations r
          JOIN members m ON m.id = r.member_id
          JOIN members c ON c.id = r.candidate_member_id
         ORDER BY r.created_at DESC`),
      pool.query(`
        SELECT j.id, m.email, COALESCE(m.nickname, m.email) AS nickname,
               j.role, j.task, j.status, j.retry_count, j.error,
               j.created_at, j.started_at, j.completed_at,
               r.actual_model, r.input_tokens, r.output_tokens,
               r.latency_ms, r.estimated_cost_micro_cny
          FROM agent_jobs j
          JOIN members m ON m.id = j.member_id
          LEFT JOIN LATERAL (
            SELECT actual_model, input_tokens, output_tokens, latency_ms,
                   estimated_cost_micro_cny
              FROM agent_runs
             WHERE job_id = j.id
             ORDER BY created_at DESC LIMIT 1
          ) r ON true
         ORDER BY j.created_at DESC
         LIMIT 250`),
      pool.query(`
        SELECT COUNT(*)::int AS calls,
               COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
               COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
               COALESCE(SUM(latency_ms), 0)::bigint AS latency_ms,
               COALESCE(SUM(estimated_cost_micro_cny), 0)::bigint AS cost_micro_cny
          FROM agent_runs`),
    ]);
  return {
    ready: true,
    database: databaseName,
    updatedAt: new Date().toISOString(),
    members: members.rows,
    portraits: portraits.rows,
    evaluations: evaluations.rows,
    recommendations: recommendations.rows,
    jobs: jobs.rows,
    audit: audit.rows[0],
  };
}

app.get("/", async (_request, reply) => {
  reply
    .header(
      "content-security-policy",
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    )
    .header("x-content-type-options", "nosniff")
    .type("text/html; charset=utf-8");
  return dashboardPage;
});

app.get("/api/snapshot", async (_request, reply) => {
  try {
    return await snapshot();
  } catch {
    reply.code(503);
    return {
      ready: false,
      database: databaseName,
      updatedAt: new Date().toISOString(),
      message: "测试数据库尚未准备好，请先运行测试。",
    };
  }
});

app.get("/api/test-state", async () => ({ ...testState, logs }));

app.post("/api/run", async (request, reply) => {
  if (request.headers["x-onlylove-e2e"] !== "run") {
    return reply.code(403).send({ message: "Forbidden" });
  }
  if (child) return reply.code(409).send({ message: "测试正在运行" });

  logs.length = 0;
  testState = {
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
  };
  child = spawn("npm", ["run", "test:matching:e2e:ark"], {
    cwd: serverDirectory,
    detached: process.platform !== "win32",
    env: { ...process.env, RUN_ARK_E2E: "1" },
    stdio: "pipe",
  });
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.on("error", (error) => record(Buffer.from(error.message)));
  child.on("close", (code) => {
    testState = {
      ...testState,
      status: code === 0 ? "passed" : "failed",
      endedAt: new Date().toISOString(),
      exitCode: code,
    };
    child = null;
  });
  return reply.code(202).send({ status: "running" });
});

app.addHook("onClose", async () => {
  await stopChild();
  await pool.end();
});

const dashboardPage = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OnlyLove E2E 测试看板</title>
  <style>
    :root { color:#2e2527; background:#f3eee7; font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif; font-synthesis:none; }
    * { box-sizing:border-box; }
    body { margin:0; min-width:320px; background:radial-gradient(circle at 92% 0,#dcc6cb 0,transparent 30rem),#f3eee7; }
    button { font:inherit; cursor:pointer; }
    .shell { width:min(1440px,100%); margin:auto; padding:28px; }
    header { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:22px; }
    .eyebrow { margin:0 0 7px; color:#8d5966; font-size:11px; font-weight:800; letter-spacing:.18em; }
    h1 { margin:0; color:#521326; font:600 clamp(30px,5vw,48px)/1.08 Georgia,"Songti SC",serif; letter-spacing:-.04em; }
    .subtitle { margin:10px 0 0; color:#75676a; }
    .actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:flex-end; }
    .pill { padding:9px 13px; border-radius:999px; color:#6d5c60; background:#e8dfd7; font-size:12px; font-weight:700; }
    .pill[data-state=running] { color:#704b00; background:#f2df9e; }
    .pill[data-state=passed] { color:#17603a; background:#cce6d4; }
    .pill[data-state=failed] { color:#8d1e34; background:#f1cbd2; }
    .primary,.secondary { min-height:42px; padding:0 16px; border:0; border-radius:12px; font-weight:750; }
    .primary { color:#fff9f2; background:#6f1831; }
    .secondary { color:#5f4249; background:#e5d8d1; }
    button:disabled { cursor:wait; opacity:.55; }
    .notice { display:none; margin-bottom:18px; padding:16px 18px; border:1px solid #d7c5bc; border-radius:14px; color:#7b4b20; background:#fff7df; }
    .metrics { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; margin-bottom:22px; }
    .metric,.panel { border:1px solid rgba(87,47,55,.1); background:rgba(255,251,246,.76); box-shadow:0 16px 44px rgba(72,42,47,.06); }
    .metric { padding:18px; border-radius:18px; }
    .metric span { display:block; color:#89777a; font-size:12px; }
    .metric strong { display:block; margin-top:7px; color:#4d2832; font:600 28px/1 Georgia,serif; }
    .layout { display:grid; grid-template-columns:260px minmax(0,1fr); gap:16px; align-items:start; }
    .panel { padding:20px; border-radius:20px; }
    .members { position:sticky; top:18px; }
    .panel h2 { margin:0 0 5px; color:#50212e; font-size:18px; }
    .panel-note { margin:0 0 16px; color:#8a777a; font-size:12px; line-height:1.5; }
    .member-button { width:100%; margin-top:8px; padding:13px; border:1px solid transparent; border-radius:13px; text-align:left; color:#58484b; background:transparent; }
    .member-button strong,.member-button span { display:block; }
    .member-button span { margin-top:4px; color:#9a898b; font-size:11px; }
    .member-button.active { border-color:#d6b8c0; color:#6f1831; background:#f2e2e5; }
    .content { display:grid; gap:16px; }
    .tabs { display:flex; gap:6px; overflow:auto; }
    .tab { min-height:38px; padding:0 14px; border:0; border-radius:10px; color:#725e62; background:transparent; font-weight:700; white-space:nowrap; }
    .tab.active { color:#fff9f2; background:#6f1831; }
    .compare { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .version { padding:16px; border:1px solid #e1d5cd; border-radius:15px; background:#fffaf5; }
    .version-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:14px; }
    .tag { padding:4px 8px; border-radius:999px; color:#815361; background:#f0dde2; font-size:10px; font-weight:800; }
    .dimension { margin-top:9px; padding:12px; border-radius:12px; background:#f5eee8; }
    .dimension.changed { box-shadow:inset 3px 0 #8f2744; }
    .dimension h3 { margin:0 0 8px; color:#633744; font-size:13px; }
    .slot { display:grid; grid-template-columns:76px 1fr; gap:8px; margin-top:6px; font-size:12px; line-height:1.55; }
    .slot b { color:#9a7c83; font-weight:650; }
    .slot span { overflow-wrap:anywhere; }
    .empty { padding:36px; border:1px dashed #cebfc0; border-radius:14px; color:#8e7e80; text-align:center; }
    .pairs { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:12px; }
    .pair { padding:17px; border:1px solid #dfd3cc; border-radius:15px; background:#fffaf5; }
    .pair-head { display:flex; justify-content:space-between; gap:14px; }
    .score { display:grid; place-items:center; flex:0 0 68px; height:68px; border-radius:50%; color:#fff; background:#712039; font:600 20px Georgia,serif; }
    .scores { display:flex; gap:10px; margin:14px 0; color:#79686b; font-size:12px; }
    .scores b { color:#4f3339; }
    .bar-row { display:grid; grid-template-columns:74px 1fr 72px; align-items:center; gap:8px; margin-top:8px; font-size:11px; }
    .bar { height:7px; overflow:hidden; border-radius:99px; background:#e4d9d2; }
    .bar i { display:block; height:100%; border-radius:99px; background:#9b4b61; }
    .reason { margin:13px 0 0; color:#6f6062; font-size:12px; line-height:1.6; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th,td { padding:10px 8px; border-bottom:1px solid #e7dcd5; text-align:left; vertical-align:top; }
    th { color:#917c80; font-size:10px; letter-spacing:.05em; }
    td { color:#58494c; }
    .state { font-weight:750; }
    .state.completed { color:#21714a; }.state.failed { color:#a32640; }.state.running { color:#a26800; }
    pre { max-height:360px; margin:0; padding:16px; overflow:auto; border-radius:14px; color:#e9dbd5; background:#2d2527; font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; }
    .hidden { display:none; }
    @media (max-width:900px) { .metrics{grid-template-columns:repeat(2,1fr)} .layout{grid-template-columns:1fr}.members{position:static}.compare{grid-template-columns:1fr} }
    @media (max-width:560px) { .shell{padding:18px 14px} header{display:block}.actions{justify-content:flex-start;margin-top:18px}.metrics{grid-template-columns:1fr 1fr}.metric:last-child{grid-column:1/-1}.panel{padding:15px}.slot{grid-template-columns:1fr}.table-wrap{overflow:auto} }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <div><p class="eyebrow">ONLYLOVE · LOCAL E2E</p><h1>匹配测试看板</h1><p class="subtitle" id="subtitle">正在连接 onlylove_e2e…</p></div>
      <div class="actions"><span class="pill" id="test-status">未运行</span><button class="secondary" id="download">下载 JSON</button><button class="primary" id="run">运行完整测试</button></div>
    </header>
    <div class="notice" id="notice"></div>
    <section class="metrics" id="metrics"></section>
    <div class="layout">
      <aside class="panel members"><h2>测试账号</h2><p class="panel-note">选择账号查看真实基线与 AI 微调结果。</p><div id="members"></div></aside>
      <section class="content">
        <div class="panel"><nav class="tabs" id="tabs"><button class="tab active" data-tab="portraits">形象槽位</button><button class="tab" data-tab="matching">匹配效果</button><button class="tab" data-tab="process">执行过程</button><button class="tab" data-tab="logs">请求日志</button></nav></div>
        <div class="panel" id="view"></div>
      </section>
    </div>
  </main>
  <script>
    let data = null, test = {status:'idle',logs:[]}, selected = '', tab = 'portraits';
    const dimensions = {long_term_planning:'长期规划',values:'价值观',relationship_boundaries:'关系边界',communication:'沟通方式',conflict_repair:'冲突修复',emotional_support:'情绪支持',lifestyle:'生活方式',family_and_finance:'家庭与财务'};
    const fields = {selfTendency:'本人倾向',partnerExpectation:'伴侣期待',hardBoundary:'硬边界',importance:'重要度',confidence:'置信度'};
    function e(value){return String(value ?? '').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function date(value){return value ? new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value)) : '—'}
    function money(micro){return '¥'+(Number(micro||0)/1000000).toFixed(4)}
    function same(a,b){return JSON.stringify(a)===JSON.stringify(b)}
    function stateText(value){return ({idle:'未运行',running:'运行中',passed:'通过',failed:'失败'})[value]||value}
    function renderMetrics(){
      const a=data&&data.audit||{};
      document.getElementById('metrics').innerHTML=[['测试账号',data?data.members.length:0],['形象版本',data?data.portraits.length:0],['配对评估',data?data.evaluations.length:0],['模型调用',a.calls||0],['预估费用',money(a.cost_micro_cny)]].map(function(x){return '<article class="metric"><span>'+e(x[0])+'</span><strong>'+e(x[1])+'</strong></article>'}).join('');
    }
    function renderMembers(){
      const box=document.getElementById('members');
      if(!data||!data.members.length){box.innerHTML='<div class="empty">暂无测试账号</div>';return}
      if(!selected) selected=data.members[0].email;
      box.innerHTML=data.members.map(function(m){return '<button class="member-button '+(m.email===selected?'active':'')+'" data-email="'+e(m.email)+'"><strong>'+e(m.nickname||m.email)+'</strong><span>'+e(m.email)+' · '+e(m.portrait_versions)+' 个版本</span></button>'}).join('');
      box.querySelectorAll('button').forEach(function(button){button.onclick=function(){selected=button.dataset.email;renderMembers();renderView()}});
    }
    function slots(version,other){
      const current=version&&version.match_profile&&version.match_profile.dimensions||{};
      const previous=other&&other.match_profile&&other.match_profile.dimensions||{};
      return Object.keys(dimensions).map(function(key){const slot=current[key]||{}, before=previous[key]||{}, changed=other&&!same(slot,before);return '<div class="dimension '+(changed?'changed':'')+'"><h3>'+e(dimensions[key])+(changed?' · 已变化':'')+'</h3>'+Object.keys(fields).map(function(field){let value=slot[field];if(Array.isArray(value))value=value.join('、');return '<div class="slot"><b>'+e(fields[field])+'</b><span>'+e(value===null||value===undefined?'—':value)+'</span></div>'}).join('')+'</div>'}).join('');
    }
    function renderPortraits(){
      const versions=data.portraits.filter(function(p){return p.email===selected});
      if(!versions.length)return '<div class="empty">该账号还没有生成形象。</div>';
      const v1=versions.find(function(p){return p.version===1}),v2=versions.find(function(p){return p.version===2});
      function card(v,label,other){return '<article class="version"><div class="version-head"><div><strong>'+e(label)+'</strong><div class="panel-note">'+(v?date(v.created_at):'等待生成')+'</div></div>'+(v&&v.published?'<span class="tag">已发布</span>':'')+'</div>'+(v?slots(v,other):'<div class="empty">等待测试写入</div>')+'</article>'}
      return '<h2>'+e((data.members.find(function(m){return m.email===selected})||{}).nickname||selected)+' · 形象演进</h2><p class="panel-note">左侧为真实测试账号完成固定访谈后生成的初始形象；右侧为补充对话与校准反馈后的 AI 微调版本。红线表示槽位发生变化。</p><div class="compare">'+card(v1,'V1 访谈基线',null)+card(v2,'V2 AI 微调',v1)+'</div>';
    }
    function renderMatching(){
      const list=data.evaluations.filter(function(x){return x.member_a===selected||x.member_b===selected});
      if(!list.length)return '<div class="empty">该账号还没有配对评估。</div>';
      return '<h2>匹配效果</h2><p class="panel-note">互惠分使用双向分的调和平均；每个槽位同时保留 A→B 与 B→A 判断。</p><div class="pairs">'+list.map(function(x){const r=x.result||{},other=x.member_a===selected?x.name_b:x.name_a;return '<article class="pair"><div class="pair-head"><div><strong>'+e(other)+'</strong><p class="panel-note">'+e(r.eligibility||'—')+' · '+date(x.created_at)+'</p></div><div class="score">'+e(r.reciprocalScore===null||r.reciprocalScore===undefined?'—':r.reciprocalScore)+'</div></div><div class="scores"><span>A→B <b>'+e(r.aToBScore)+'</b></span><span>B→A <b>'+e(r.bToAScore)+'</b></span></div>'+(r.dimensions||[]).map(function(d){return '<div class="bar-row"><span>'+e(dimensions[d.dimension]||d.dimension)+'</span><div class="bar"><i style="width:'+Math.max(0,Math.min(100,Number(d.aToB)||0))+'%"></i></div><span>'+e(d.aToB)+' / '+e(d.bToA)+'</span></div>'}).join('')+'<p class="reason">'+e(r.safeRecommendationReason||'')+'</p></article>'}).join('')+'</div>';
    }
    function renderProcess(){
      const rows=data.jobs||[];if(!rows.length)return '<div class="empty">还没有 Agent 任务。</div>';
      return '<h2>Agent 执行过程</h2><p class="panel-note">按创建时间倒序显示，页面每 2 秒从数据库刷新。</p><div class="table-wrap"><table><thead><tr><th>时间</th><th>账号</th><th>任务</th><th>状态</th><th>耗时</th><th>Token</th><th>费用</th></tr></thead><tbody>'+rows.map(function(j){return '<tr><td>'+date(j.created_at)+'</td><td>'+e(j.nickname)+'</td><td>'+e(j.task)+'</td><td class="state '+e(j.status)+'">'+e(j.status)+(j.error?' · '+e(j.error):'')+'</td><td>'+e(j.latency_ms===null||j.latency_ms===undefined?'—':(j.latency_ms/1000).toFixed(1)+'s')+'</td><td>'+e((j.input_tokens||0)+(j.output_tokens||0))+'</td><td>'+money(j.estimated_cost_micro_cny)+'</td></tr>'}).join('')+'</tbody></table></div>';
    }
    function renderLogs(){return '<h2>完整请求日志</h2><p class="panel-note">从本页启动测试时实时捕获；最近保留 500 行。</p><pre id="console">'+e((test.logs||[]).join('\n')||'尚未从本页启动测试。')+'</pre>'}
    function renderView(){const html=tab==='portraits'?renderPortraits():tab==='matching'?renderMatching():tab==='process'?renderProcess():renderLogs();document.getElementById('view').innerHTML=html;const consoleBox=document.getElementById('console');if(consoleBox)consoleBox.scrollTop=consoleBox.scrollHeight}
    function render(){
      document.getElementById('subtitle').textContent=data&&data.ready?'数据库 '+data.database+' · 更新于 '+date(data.updatedAt):'等待测试数据库';
      const pill=document.getElementById('test-status');pill.textContent=stateText(test.status);pill.dataset.state=test.status;
      document.getElementById('run').disabled=test.status==='running';
      renderMetrics();renderMembers();renderView();
    }
    async function refresh(){
      const results=await Promise.all([fetch('/api/snapshot'),fetch('/api/test-state')]);
      const snapshot=await results[0].json();test=await results[1].json();
      const notice=document.getElementById('notice');
      if(snapshot.ready){data=snapshot;notice.style.display='none'}else{data={ready:false,database:snapshot.database,members:[],portraits:[],evaluations:[],recommendations:[],jobs:[],audit:{}};notice.textContent=snapshot.message;notice.style.display='block'}
      render();
    }
    document.getElementById('run').onclick=async function(){if(!confirm('这会调用真实 Ark 模型并产生费用，确认运行完整测试？'))return;const response=await fetch('/api/run',{method:'POST',headers:{'x-onlylove-e2e':'run'}});if(!response.ok)alert((await response.json()).message||'启动失败');await refresh()};
    document.getElementById('download').onclick=function(){if(!data||!data.ready)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='onlylove-e2e-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();URL.revokeObjectURL(a.href)};
    document.querySelectorAll('.tab').forEach(function(button){button.onclick=function(){tab=button.dataset.tab;document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x===button)});renderView()}});
    refresh().catch(function(error){document.getElementById('notice').textContent=error.message;document.getElementById('notice').style.display='block'});
    setInterval(function(){refresh().catch(function(){})},2000);
  </script>
</body>
</html>`;

const port = Number(process.env.E2E_DASHBOARD_PORT ?? 3200);
await app.listen({ host: "127.0.0.1", port });
console.info(`OnlyLove E2E dashboard: http://127.0.0.1:${port}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
