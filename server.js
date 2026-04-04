import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json());

// ── Rentvine proxy ────────────────────────────────────────────────────────────
app.post('/proxy/rentvine', async (req, res) => {
  const { tool, input, apiKey, baseUrl } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'No Rentvine API key' });
  const base = baseUrl || 'https://api.rentvine.com/v1';
  let url = base;
  try {
    if (tool === 'search_available_units') {
      url += '/units?status=available';
      if (input.bedrooms) url += `&bedrooms=${input.bedrooms}`;
      if (input.max_rent) url += `&max_rent=${input.max_rent}`;
      if (input.city) url += `&city=${encodeURIComponent(input.city)}`;
    } else if (tool === 'get_property_details') {
      url += `/properties/${input.property_id}`;
    } else if (tool === 'get_tenant_info') {
      url += `/tenants?q=${encodeURIComponent(input.query)}`;
    } else if (tool === 'get_work_orders') {
      url += '/work-orders?';
      if (input.property_id) url += `property_id=${input.property_id}&`;
      if (input.status) url += `status=${input.status}`;
    } else if (tool === 'get_owner_info') {
      url += `/owners?q=${encodeURIComponent(input.query)}`;
    }
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Zinspector proxy ──────────────────────────────────────────────────────────
app.post('/proxy/zinspector', async (req, res) => {
  const { tool, input, apiKey, baseUrl } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'No Zinspector API key' });
  const base = baseUrl || 'https://api.zinspector.com/v1';
  let url = base;
  try {
    if (tool === 'get_scheduled_inspections') {
      url += `/inspections?status=scheduled&days=${input.days_ahead || 7}`;
      if (input.property_address) url += `&address=${encodeURIComponent(input.property_address)}`;
    } else if (tool === 'get_inspection_report') {
      url += input.inspection_id ? `/inspections/${input.inspection_id}` : `/inspections?address=${encodeURIComponent(input.property_address)}&limit=1`;
    } else if (tool === 'get_property_inspections') {
      url += `/inspections?address=${encodeURIComponent(input.property_address)}`;
    }
    const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Serve the entire React app as inline HTML — no build step needed ──────────
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aloe Assistant</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f9f9f7}
    @keyframes ab{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
    @keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
    .chip:hover{background:#f0f0ee!important}
    .chip-sc:hover{opacity:0.85!important}
    textarea:focus,input:focus{outline:none}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-thumb{background:#ddd;border-radius:2px}
  </style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
const { useState, useRef, useEffect } = React;

const PASSCODE = "aloe2024";

const SYSTEM_PROMPT = \`You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to six live data sources:
1. NOTION (MCP) — SOPs, policies, leasing procedures, checklists. Search first for any policy question.
2. APTLY (MCP) — Leads pipeline, workflow boards, contacts, marketing.
3. SLACK (MCP) — Team messages, announcements, decisions.
4. RENTVINE (tools) — Live properties, leases, tenants, owners, work orders.
5. ZINSPECTOR (tools) — Inspection reports, schedules, property condition.
6. GOOGLE DRIVE (MCP if connected) — Docs, templates, contracts, forms.

Rules: Be concise and direct. Use numbered steps for procedures. Always cite your source. Never guess on property availability — use Rentvine. If unsure say: "Check with Randi or Persia directly." Never speculate on legal matters. Tone: professional, helpful senior colleague.\`;

const SUGGESTIONS = [
  {icon:"🏠", text:"What homes are available right now?"},
  {icon:"👥", text:"What new leads came in today?"},
  {icon:"📋", text:"What's our lease break policy?"},
  {icon:"🔧", text:"How do I handle a maintenance emergency?"},
  {icon:"🔍", text:"Inspections scheduled this week?"},
  {icon:"💬", text:"Any recent team updates in Slack?"},
  {icon:"📂", text:"Find our lease agreement template"},
  {icon:"🏢", text:"Walk me through the HOA violation procedure"},
];

const SOURCES = {
  notion:     {label:"Notion",      bg:"#f5f5f5", border:"#d0d0d0"},
  aptly:      {label:"Aptly",       bg:"#EAF3DE", border:"#97C459"},
  slack:      {label:"Slack",       bg:"#f0e6f6", border:"#c17edb"},
  rentvine:   {label:"Rentvine",    bg:"#e6f0fb", border:"#85B7EB"},
  zinspector: {label:"Zinspector",  bg:"#FAEEDA", border:"#EF9F27"},
  gdrive:     {label:"Google Drive",bg:"#fce8e8", border:"#F09595"},
};

function renderMd(text) {
  if (!text) return null;
  const bold = s => s.split(/\\*\\*(.*?)\\*\\*/).map((p,i) => i%2===1 ? React.createElement('strong',{key:i,style:{fontWeight:500}},p) : p);
  return text.split("\\n").map((line,key) => {
    if (!line.trim()) return React.createElement('div',{key,style:{height:6}});
    if (line.match(/^#{1,3}\\s/)) return React.createElement('p',{key,style:{fontWeight:500,marginBottom:4,marginTop:8}},bold(line.replace(/^#+\\s/,"")));
    if (line.match(/^[-•]\\s/)) return React.createElement('div',{key,style:{display:"flex",gap:8,marginBottom:3}},React.createElement('span',{style:{color:"#888",flexShrink:0}},"•"),React.createElement('span',null,bold(line.replace(/^[-•]\\s/,""))));
    if (line.match(/^\\d+\\.\\s/)) return React.createElement('div',{key,style:{display:"flex",gap:8,marginBottom:3}},React.createElement('span',{style:{color:"#888",flexShrink:0,minWidth:18}},line.match(/^(\\d+)/)[1]+"."),React.createElement('span',null,bold(line.replace(/^\\d+\\.\\s/,""))));
    return React.createElement('p',{key,style:{marginBottom:3,lineHeight:1.6}},bold(line));
  });
}

function Dots() {
  return React.createElement('div',{style:{display:"flex",gap:4,padding:"2px 0"}},
    [0,1,2].map(i => React.createElement('div',{key:i,style:{width:6,height:6,borderRadius:"50%",background:"#3B6D11",animation:\`ab 1.2s ease-in-out \${i*0.18}s infinite\`}}))
  );
}

function PasscodeGate({onUnlock}) {
  const [val,setVal] = useState("");
  const [error,setError] = useState(false);
  const [shake,setShake] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const attempt = () => {
    if (val === PASSCODE) { onUnlock(); }
    else { setError(true); setShake(true); setVal(""); setTimeout(()=>setShake(false),500); }
  };
  return (
    <div style={{height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#f9f9f7"}}>
      <div style={{animation:"fadeUp 0.4s ease",display:"flex",flexDirection:"column",alignItems:"center",gap:24,width:"100%",maxWidth:340,padding:"0 24px"}}>
        <div style={{textAlign:"center"}}>
          <div style={{width:56,height:56,borderRadius:16,background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,margin:"0 auto 10px"}}>🌿</div>
          <div style={{fontSize:18,fontWeight:600,color:"#1a1a1a"}}>Aloe Assistant</div>
          <div style={{fontSize:12,color:"#888",marginTop:2}}>Aloe Property Management · Internal</div>
        </div>
        <div style={{width:"100%",background:"white",border:"1px solid #e5e5e5",borderRadius:12,padding:"24px 20px",animation:shake?"shake 0.4s ease":"none"}}>
          <p style={{fontSize:13,color:"#666",marginBottom:12,textAlign:"center"}}>Enter your team passcode</p>
          <input ref={ref} type="password" value={val} onChange={e=>{setVal(e.target.value);setError(false);}} onKeyDown={e=>e.key==="Enter"&&attempt()} placeholder="Passcode" style={{width:"100%",fontSize:15,padding:"10px 14px",textAlign:"center",letterSpacing:"0.15em",border:\`1px solid \${error?"#e53e3e":"#e5e5e5"}\`,borderRadius:8,background:"#f9f9f9",color:"#1a1a1a",fontFamily:"inherit",marginBottom:error?8:12}}/>
          {error && <p style={{fontSize:12,color:"#e53e3e",textAlign:"center",marginBottom:10}}>Incorrect passcode — try again</p>}
          <button onClick={attempt} style={{width:"100%",padding:"10px",background:"#3B6D11",border:"none",borderRadius:8,color:"white",fontSize:14,fontWeight:600,cursor:"pointer"}}>Sign in</button>
        </div>
        <p style={{fontSize:11,color:"#aaa",textAlign:"center"}}>For access, contact Randi</p>
      </div>
    </div>
  );
}

function Assistant() {
  const [messages,setMessages] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [showSettings,setShowSettings] = useState(false);
  const [lastError,setLastError] = useState("");
  const [cfg,setCfg] = useState({rvKey:"",rvBase:"https://api.rentvine.com/v1",ziKey:"",ziBase:"https://api.zinspector.com/v1",gdUrl:""});
  const endRef = useRef(null);
  const taRef = useRef(null);

  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:"smooth"}); },[messages,loading]);
  const upd = (k,v) => setCfg(c=>({...c,[k]:v}));

  const mcps = () => {
    const s = [
      {type:"url",url:"https://mcp.notion.com/mcp",name:"notion"},
      {type:"url",url:"https://mcp.getaptly.com/mcp",name:"aptly"},
      {type:"url",url:"https://mcp.slack.com/mcp",name:"slack"},
    ];
    if (cfg.gdUrl) s.push({type:"url",url:cfg.gdUrl,name:"gdrive"});
    return s;
  };

  const rvTools = cfg.rvKey ? [
    {name:"search_available_units",description:"Search for available/vacant rental units in Rentvine",input_schema:{type:"object",properties:{bedrooms:{type:"number"},max_rent:{type:"number"},city:{type:"string"}}}},
    {name:"get_property_details",description:"Get full details for a Rentvine property by ID",input_schema:{type:"object",properties:{property_id:{type:"string"}},required:["property_id"]}},
    {name:"get_tenant_info",description:"Look up tenant by name, email, or lease ID",input_schema:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
    {name:"get_work_orders",description:"Fetch maintenance work orders from Rentvine",input_schema:{type:"object",properties:{property_id:{type:"string"},status:{type:"string"}}}},
    {name:"get_owner_info",description:"Look up owner info by name or property ID",input_schema:{type:"object",properties:{query:{type:"string"}},required:["query"]}},
  ] : [];

  const ziTools = cfg.ziKey ? [
    {name:"get_scheduled_inspections",description:"Get upcoming inspections from Zinspector",input_schema:{type:"object",properties:{days_ahead:{type:"number"},property_address:{type:"string"}}}},
    {name:"get_inspection_report",description:"Get a full inspection report",input_schema:{type:"object",properties:{inspection_id:{type:"string"},property_address:{type:"string"}}}},
    {name:"get_property_inspections",description:"Get all inspection history for a property",input_schema:{type:"object",properties:{property_address:{type:"string"}},required:["property_address"]}},
  ] : [];

  const execTool = async ({name, input:inp}) => {
    try {
      const allRv = rvTools.map(t=>t.name);
      const allZi = ziTools.map(t=>t.name);
      if (allRv.includes(name)) {
        const r = await fetch('/proxy/rentvine',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool:name,input:inp,apiKey:cfg.rvKey,baseUrl:cfg.rvBase})});
        return JSON.stringify(await r.json());
      }
      if (allZi.includes(name)) {
        const r = await fetch('/proxy/zinspector',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool:name,input:inp,apiKey:cfg.ziKey,baseUrl:cfg.ziBase})});
        return JSON.stringify(await r.json());
      }
    } catch(e) { return \`Tool error: \${e.message}\`; }
    return "Tool not configured";
  };

  const callClaude = async (msgs, withTools) => {
    const allTools = [...rvTools,...ziTools];
    const res = await fetch("https://api.anthropic.com/v1/messages",{
      method:"POST",
      headers:{"Content-Type":"application/json","anthropic-beta":"mcp-client-2025-04-04"},
      body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:SYSTEM_PROMPT,messages:msgs,mcp_servers:mcps(),...(withTools&&allTools.length>0&&{tools:allTools})}),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message||JSON.stringify(data.error));
    return data;
  };

  const send = async (text) => {
    const msg = (text||input).trim();
    if (!msg||loading) return;
    setInput(""); setLastError("");
    if (taRef.current) taRef.current.style.height="auto";
    const next = [...messages,{role:"user",content:msg}];
    setMessages(next); setLoading(true);
    try {
      const api = next.map(m=>({role:m.role,content:m.content}));
      let data = await callClaude(api,true);
      const tbs = (data.content||[]).filter(b=>b.type==="tool_use");
      if (tbs.length>0) {
        const results = await Promise.all(tbs.map(async tb=>({type:"tool_result",tool_use_id:tb.id,content:await execTool(tb)})));
        data = await callClaude([...api,{role:"assistant",content:data.content},{role:"user",content:results}],false);
      }
      const txt = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\\n")||"Sorry, try again.";
      setMessages([...next,{role:"assistant",content:txt}]);
    } catch(e) { setLastError(e.message); setMessages([...next,{role:"assistant",content:"Something went wrong."}]); }
    setLoading(false);
  };

  const connected = [true,true,true,!!cfg.rvKey,!!cfg.ziKey,!!cfg.gdUrl].filter(Boolean).length;

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh"}}>
      {lastError && <div style={{padding:"8px 16px",background:"#fff5f5",borderBottom:"1px solid #fed7d7",display:"flex",justifyContent:"space-between",flexShrink:0}}><span style={{fontSize:12,color:"#c53030"}}>⚠ {lastError}</span><button onClick={()=>setLastError("")} style={{background:"none",border:"none",cursor:"pointer",color:"#c53030",fontSize:16}}>×</button></div>}

      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"white",borderBottom:"1px solid #f0f0f0",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:36,height:36,borderRadius:8,background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🌿</div>
          <div>
            <div style={{fontSize:15,fontWeight:600,color:"#1a1a1a"}}>Aloe Assistant</div>
            <div style={{fontSize:11,color:"#888"}}>{connected} of 6 sources active</div>
          </div>
        </div>
        <button onClick={()=>setShowSettings(s=>!s)} style={{fontSize:13,padding:"5px 12px",border:"1px solid #e5e5e5",borderRadius:8,background:"white",cursor:"pointer",color:"#555"}}>{showSettings?"Close":"Settings"}</button>
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          <div style={{flex:1,overflowY:"auto",padding:"20px 16px"}}>
            {messages.length===0 ? (
              <div style={{minHeight:400,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:24}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:36,marginBottom:10}}>🌿</div>
                  <div style={{fontSize:20,fontWeight:600,color:"#1a1a1a",marginBottom:6}}>Hi, I'm Aloe</div>
                  <div style={{fontSize:14,color:"#666",maxWidth:380,lineHeight:1.6}}>Your all-in-one assistant — pulling from Notion, Aptly, Slack, Rentvine, Zinspector, and Google Drive.</div>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,justifyContent:"center",maxWidth:440}}>
                  {Object.entries(SOURCES).map(([key,s]) => {
                    const on = ["notion","aptly","slack"].includes(key)||(key==="rentvine"&&cfg.rvKey)||(key==="zinspector"&&cfg.ziKey)||(key==="gdrive"&&cfg.gdUrl);
                    return <div key={key} style={{padding:"3px 9px",borderRadius:20,background:on?s.bg:"#f5f5f5",border:\`1px solid \${on?s.border:"#e5e5e5"}\`,fontSize:12,color:on?"#333":"#aaa"}}>{s.label}</div>;
                  })}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(2, minmax(0, 1fr))",gap:8,width:"100%",maxWidth:520}}>
                  {SUGGESTIONS.map((s,i) => (
                    <button key={i} className="chip" onClick={()=>send(s.text)} style={{background:"white",border:"1px solid #f0f0f0",borderRadius:8,padding:"10px 12px",cursor:"pointer",textAlign:"left",fontSize:13,color:"#666",lineHeight:1.4,display:"flex",alignItems:"flex-start",gap:6,transition:"background 0.1s"}}>
                      <span style={{fontSize:14,flexShrink:0}}>{s.icon}</span>{s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{maxWidth:660,width:"100%",margin:"0 auto"}}>
                {messages.map((m,i) => (
                  <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
                    {m.role==="assistant" && <div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0,marginRight:8,marginTop:2}}>🌿</div>}
                    <div style={{maxWidth:"78%",padding:"10px 14px",borderRadius:m.role==="user"?"12px 12px 4px 12px":"12px 12px 12px 4px",background:m.role==="user"?"#EAF3DE":"white",border:\`1px solid \${m.role==="user"?"#97C459":"#f0f0f0"}\`,color:m.role==="user"?"#173404":"#1a1a1a",fontSize:14,lineHeight:1.6}}>
                      {m.role==="assistant" ? renderMd(m.content) : m.content}
                    </div>
                  </div>
                ))}
                {loading && <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>🌿</div><div style={{padding:"10px 14px",background:"white",border:"1px solid #f0f0f0",borderRadius:"12px 12px 12px 4px"}}><Dots/></div></div>}
                <div ref={endRef}/>
              </div>
            )}
          </div>

          <div style={{padding:"12px 16px",background:"white",borderTop:"1px solid #f0f0f0",flexShrink:0}}>
            <div style={{maxWidth:660,margin:"0 auto",display:"flex",gap:8,alignItems:"flex-end"}}>
              <textarea ref={taRef} value={input} onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Ask about homes, leads, policies, inspections, documents, or any situation..." rows={1} style={{flex:1,padding:"9px 12px",background:"#f9f9f7",border:"1px solid #e5e5e5",borderRadius:8,color:"#1a1a1a",fontSize:14,fontFamily:"inherit",resize:"none",lineHeight:1.5,minHeight:38,maxHeight:120}}/>
              <button onClick={()=>send()} disabled={!input.trim()||loading} style={{width:38,height:38,borderRadius:8,background:input.trim()&&!loading?"#3B6D11":"#f0f0f0",border:"none",cursor:input.trim()&&!loading?"pointer":"default",color:input.trim()&&!loading?"white":"#aaa",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>↑</button>
            </div>
          </div>
        </div>

        {showSettings && (
          <div style={{width:280,flexShrink:0,background:"white",borderLeft:"1px solid #f0f0f0",overflowY:"auto",padding:16}}>
            <p style={{fontSize:11,fontWeight:600,color:"#888",marginBottom:14,letterSpacing:"0.06em"}}>CONNECTIONS</p>
            {["Notion","Aptly","Slack"].map(s => (
              <div key={s} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 10px",background:"#f9f9f7",borderRadius:8,marginBottom:6,border:"1px solid #f0f0f0"}}>
                <span style={{fontSize:13,fontWeight:500}}>{s}</span>
                <span style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:"#EAF3DE",color:"#3B6D11",border:"1px solid #97C459"}}>✓ Live</span>
              </div>
            ))}
            <div style={{borderTop:"1px solid #f0f0f0",margin:"12px 0"}}/>
            {[["Rentvine API Key","rvKey"],["Zinspector API Key","ziKey"]].map(([label,key]) => (
              <div key={key} style={{marginBottom:14}}>
                <div style={{fontSize:13,fontWeight:500,marginBottom:6}}>{label}</div>
                <input type="password" value={cfg[key]} onChange={e=>upd(key,e.target.value)} placeholder="Paste key..." style={{width:"100%",fontSize:12,padding:"7px 10px",border:"1px solid #e5e5e5",borderRadius:6,background:"#f9f9f7",color:"#1a1a1a",fontFamily:"inherit"}}/>
              </div>
            ))}
            <div>
              <div style={{fontSize:13,fontWeight:500,marginBottom:6}}>Google Drive MCP URL</div>
              <input type="text" value={cfg.gdUrl} onChange={e=>upd("gdUrl",e.target.value)} placeholder="https://gdrive.mcp.claude.com/mcp" style={{width:"100%",fontSize:11,padding:"7px 10px",border:"1px solid #e5e5e5",borderRadius:6,background:"#f9f9f7",color:"#1a1a1a",fontFamily:"inherit"}}/>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [unlocked,setUnlocked] = useState(false);
  return unlocked ? <Assistant/> : <PasscodeGate onUnlock={()=>setUnlocked(true)}/>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aloe Assistant running on port ${PORT}`));
