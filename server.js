
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';

import { initPlaidRoutes } from './plaid-integration.js';

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use('/api/chat', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/vacancy', (req, res) => {
    res.sendFile(new URL('./vacancy.html', import.meta.url).pathname);
});

app.get('/vacancy-risk', (req, res) => {
  res.sendFile(new URL('./vacancy-risk.html', import.meta.url).pathname);
});
// Route to serve the HOA filler UI
app.get('/media-analyzer', (req, res) => res.sendFile(new URL('./media-analyzer.html', import.meta.url).pathname));

app.get('/hoa', (req, res) =>
  res.sendFile(new URL('./hoa-filler.html', import.meta.url).pathname));

app.post('/api/hoa/fill', async (req, res) => {
  const input = JSON.stringify(req.body);
  const py = spawn('python3', ['hoa_filler.py']);
  let out = '', err = '';
  py.stdin.write(input);
  py.stdin.end();
  py.stdout.on('data', d => out += d);
  py.stderr.on('data', d => err += d);
  py.on('close', code => {
    if (code !== 0) return res.status(500).json({ error: err });
    try { res.json(JSON.parse(out)); }
    catch(e) { res.status(500).json({ error: 'Parse error: ' + out.slice(0,200) }); }
  });
});

app.get('/api/hoa/leases', async (req, res) => {
  try {
    let allLeases = [];
    let page = 1;
    while (page <= 20) {
      const data = await rvFetch('/leases/export', { pageSize: 200, page });
      const batch = Array.isArray(data) ? data : [];
      if (batch.length === 0) break;
      allLeases = allLeases.concat(batch);
      if (batch.length < 200) break;
      page++;
    }
    const now = new Date();
    const mapped = allLeases
      .filter(d => {
        const end = d.lease?.endDate;
        return !end || new Date(end) >= now;
      })
      .map(d => ({
        leaseID: d.lease?.leaseID,
        tenant: d.lease?.tenants?.[0]?.name || '—',
        address: d.unit?.address || d.property?.address || '—',
        city: d.unit?.city || d.property?.city || '',
      }));
    const byAddress = {};
    mapped.forEach(l => {
      if (!byAddress[l.address] || l.leaseID > byAddress[l.address].leaseID) {
        byAddress[l.address] = l;
      }
    });
    const leases = Object.values(byAddress).sort((a,b) => (a.address||'').localeCompare(b.address||''));
    res.json({ leases });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hoa/templates', async (req, res) => {
  const { default: fs } = await import('fs');
  const { default: path } = await import('path');
  const dir = path.join(process.cwd(), 'templates');
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
    res.json({ templates: files.map(f => ({ id: f.replace('.pdf',''), name: f.replace('.pdf','').replace(/_/g,' ') })) });
  } catch(e) {
    console.error('Templates dir error:', e.message, 'cwd:', process.cwd(), 'dir:', dir);
    res.json({ templates: [], debug: e.message });
  }
});
app.get('/vendors', (req, res) => {
     res.sendFile(new URL('./vendors.html', import.meta.url).pathname);
});
app.get('/resources/vendors', (req, res) => {
  res.sendFile(new URL('./vendor-resources.html', import.meta.url).pathname);
});

app.get('/api/vendors', async (req, res) => {
  try {
    res.json({ vendors: [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/renewals', (req, res) =>
  res.sendFile(new URL('./renewals.html', import.meta.url).pathname));
app.get('/api/pet-policy', async function(req, res) {
  const addr = (req.query.address || '').toLowerCase().trim();
  if (!addr) return res.json({ error: 'address param required' });
  try {
    const schema = await unitsFetch('/api/schema/unit');
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
    let allCards = [];
    let page = 0;
    while (page < 10) {
      const data = await unitsFetch('/api/board/unit', { page, pageSize: 100 });
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allCards = allCards.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const numMatch = addr.match(/\d+/) ? addr.match(/\d+/)[0] : null;
    const words = addr.replace(/\d+/g,'').replace(/\b(court|ct|drive|dr|street|st|avenue|ave|lane|ln|way|road|rd|place|pl|blvd|circle|cir|trail|trl)\b/gi,'').trim().split(/\s+/).filter(function(w){ return w.length > 2; });
    const match = allCards.find(function(c) {
      const s = (c.street || '').toLowerCase();
      const hasNum = numMatch && s.includes(numMatch);
      const hasWord = words.some(function(w){ return s.includes(w); });
      return hasNum && hasWord;
    });
    if (!match) {
      const partial = allCards.filter(function(c){ return numMatch && (c.street||'').toLowerCase().includes(numMatch); }).slice(0,5).map(function(c){ return c.street||'?'; });
      return res.json({ found: false, partial });
    }
    const restrictions = Array.isArray(match.petRestrictions) ? match.petRestrictions : [];
    const petsAllowed = match.petsAllowed;
    const noDogs = restrictions.some(function(r){ return /no dog/i.test(r); });
    const noCats = restrictions.some(function(r){ return /no cat/i.test(r); });
    const dogsOk = restrictions.some(function(r){ return /dog.*allow/i.test(r); });
    const catsOk = restrictions.some(function(r){ return /cat.*allow/i.test(r); });
    const noPets = petsAllowed === false || (noDogs && noCats);
    const fullyOk = (petsAllowed === true || dogsOk || catsOk) && !noDogs && !noCats;
    var verdict;
    if (noPets) verdict = '🚫 No pets allowed at this property.';
    else if (noDogs && !noCats) verdict = '⚠️ Cats allowed, but NO DOGS at this property.';
    else if (noCats && !noDogs) verdict = '⚠️ Dogs allowed, but NO CATS at this property.';
    else if (fullyOk) verdict = '✅ Pets allowed (dogs and cats).';
    else verdict = '⚠️ No specific restriction on file — standard Aloe policy applies.';
    const owners = Array.isArray(match.owners) ? match.owners.map(function(o){ return o.name||''; }).join(', ') : '';
    res.json({
      found: true,
      address: match.street || '?',
      stage: match.stage || '',
      beds: match.beds || '',
      baths: match.baths || '',
      rent: match.marketRent ? (match.marketRent.amount || '') : '',
      owner: owners,
      verdict,
      petRestrictions: restrictions,
      petsAllowed: petsAllowed,
      petDeposit: match.animalDeposit ? match.animalDeposit.amount : null,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/aptly/leads-rich', async function(req, res) {
  try {
    const token = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    const schemaRes = await fetch('https://core-api.getaptly.com/api/schema/4EMDSYKirhQaNdQKz', { headers: { 'x-token': token } });
    const schema = await schemaRes.json();
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
    let allLeads = [], page = 0;
    while (page < 5) {
      const r = await fetch(`https://core-api.getaptly.com/api/board/4EMDSYKirhQaNdQKz?page=${page}&pageSize=100`, { headers: { 'x-token': token } });
      if (!r.ok) break;
      const data = await r.json();
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allLeads = allLeads.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const mapped = allLeads.map(function(c) {
      const m = { cardId: c.cardId, stage: c.stage, createdAt: c.createdAt };
      Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
      const pref = m['Preferred Rental'] || m['Unit'] || '';
      let prefStr = '';
      if (Array.isArray(pref)) prefStr = pref.map(p => p.name || '').filter(Boolean).join(', ');
      else if (typeof pref === 'object' && pref) prefStr = pref.name || pref.address || '';
      else prefStr = String(pref || '');

      const contactRaw = m['Primary Contact'] || c.name || '';
      let contactStr = '';
      if (Array.isArray(contactRaw)) contactStr = contactRaw.map(p => p.name || '').filter(Boolean).join(', ');
      else if (typeof contactRaw === 'object' && contactRaw) contactStr = contactRaw.name || '';
      else contactStr = String(contactRaw || '');

      return {
        cardId: c.cardId,
        stage: c.stage,
        createdAt: c.createdAt,
        contact: contactStr,
        preferredRental: prefStr,
        address: prefStr,
        source: m['Source'] || '',
        showingInfo: m['Requested Showing Information'] || '',
        moveDate: m['Move Date'] || '',
        income: m['Household Income'] || '',
        pets: m['Pets'] || '',
        comments: Array.isArray(c.comments) ? c.comments.map(function(cm) {
          return { by: cm.userName || 'Unknown', note: cm.content || '', date: (cm.createdAt || '').slice(0,10) };
        }) : [],
      };
    });
    res.json({ leads: mapped, total: mapped.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/aptly/units', async function(req, res) {
 try {
    const token = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
    let allCards = [];
    let page = 0;
    while (page < 10) {
      const url = new URL('https://core-api.getaptly.com/api/board/unit');
      url.searchParams.set('page', page);
      url.searchParams.set('pageSize', 100);
      const r = await fetch(url.toString(), { headers: { 'x-token': token, 'Accept': 'application/json' } });
      if (!r.ok) break;
      const data = await r.json();
      const batch = Array.isArray(data) ? data : (data && data.data) || [];
      if (batch.length === 0) break;
      allCards = allCards.concat(batch);
      if (batch.length < 100) break;
      page++;
    }
    const published = allCards.filter(function(u) {
      return u.publishedForRent === true || u.syndicate === true || u['Published For Rent'] === 'checked';
    });
    const strVal = function(v) {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(function(i) { return typeof i === 'object' ? (i.name || '') : String(i); }).filter(Boolean).join(', ');
      if (typeof v === 'object') return v.name || v.label || v.address || '';
      return String(v);
    };
    const sanitized = published.map(function(u) {
      return {
        cardId: u.cardId || '',
        street: u.street || '',
        city: u.city || (u.address && typeof u.address === 'object' ? u.address.city : '') || '',
        beds: u.beds || 0,
        baths: u.baths || 0,
        totalArea: u.totalArea || 0,
        marketRent: u.marketRent || null,
        availableDate: u.availableDate || null,
        publishedForRent: u.publishedForRent || false,
        syndicate: u.syndicate || false,
        rentReady: u.rentReady || false,
        lockboxNumber: strVal(u.lockboxNumber),
        virtualTourUrl: strVal(u.virtualTourUrl),
        applicationUrl: strVal(u.applicationUrl),
        petsAllowed: u.petsAllowed || false,
        petRestrictions: Array.isArray(u.petRestrictions) ? u.petRestrictions : [],
        animalDeposit: u.animalDeposit || null,
        owners: Array.isArray(u.owners) ? u.owners.map(function(o) { return { name: strVal(o) }; }) : [],
        portfolio: Array.isArray(u.portfolio) ? u.portfolio.map(function(p) { return { name: strVal(p) }; }) : [],
        stage: u.stage || '',
        marketingName: strVal(u.marketingName),
      };
    });
    res.json({ units: sanitized, total: allCards.length, published: sanitized.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// Proxy: vendor knowledge base docs

app.get('/api/aptly/leads', async (req, res) => {
    try {
          const r = await fetch('https://api.getaptly.com/v1/boards?page=0&size=200', {
                  headers: { 'x-token': process.env.APTLY_TOKEN }
          });
          const data = await r.json();
          const cards = data.content || data.cards || data || [];
          res.json({ leads: cards, count: cards.length });
    } catch(e) {
          res.status(500).json({ error: e.message });
    }
});

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const RENTVINE_API_KEY    = process.env.RENTVINE_API_KEY;
const RENTVINE_API_SECRET = process.env.RENTVINE_API_SECRET;
const RENTVINE_ACCOUNT    = process.env.RENTVINE_ACCOUNT;
const APTLY_TOKEN         = process.env.APTLY_TOKEN;
const ZINSPECTOR_API_KEY  = process.env.ZINSPECTOR_API_KEY;
const SLACK_TOKEN         = process.env.SLACK_TOKEN;
const KB_URL              = process.env.KB_URL || 'https://kb.aloepm.com';
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const RENTVINE_BASE = `https://${RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
const RENTVINE_AUTH = Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString('base64');

const KB_TOPIC_CACHE = {};
const KB_CACHE_TTL_MS = 30 * 60 * 1000;

async function kbSearch(query, opts = {}) {
  const params = new URLSearchParams({ q: query, limit: String(opts.limit || 5) });
  if (opts.audience) params.set('audience', opts.audience);
  if (opts.department) params.set('department', opts.department);
  try {
    const r = await fetch(`${KB_URL}/search?${params.toString()}`);
    if (!r.ok) return { error: `KB ${r.status}`, results: [] };
    const data = await r.json();
    return { results: data.results || [] };
  } catch (e) {
    console.error('kbSearch error:', e.message);
    return { error: e.message, results: [] };
  }
}

async function getKbTopic(cacheKey, query, opts = {}) {
  const now = Date.now();
  const cached = KB_TOPIC_CACHE[cacheKey];
  if (cached && (now - cached.loadedAt) < KB_CACHE_TTL_MS) return cached.text;
  const { results } = await kbSearch(query, { limit: opts.limit || 3, audience: opts.audience, department: opts.department });
  if (!results || results.length === 0) return '';
  const byDoc = new Map();
  for (const r of results) {
    if (!byDoc.has(r.document_id) || r.content.length > byDoc.get(r.document_id).content.length) {
      byDoc.set(r.document_id, r);
    }
  }
  const text = Array.from(byDoc.values())
    .map(r => `=== ${r.document_title} ===\n${r.content}`)
    .join('\n\n');
  KB_TOPIC_CACHE[cacheKey] = { text, loadedAt: now };
  return text;
}

const KB_TOPIC_ROUTES = [
  { test: /water.*leak|leak.*water|leaking|flooded|burst.*pipe|pipe.*burst|water.*damage/, key: 'water_leaks', q: 'water leak troubleshooting shut off valve' },
  { test: /pest|scorpion|roach|termite|rodent|bee|ant.*infestat|bug.*infestat/, key: 'pest_sop', q: 'pest control SOP scorpions bees rodents owner tenant' },
  { test: /toilet|toilet.*leak|toilet.*clog|toilet.*flush/, key: 'toilet', q: 'toilet troubleshooting running toilet flush' },
  { test: /washer|dryer|washing machine|laundry/, key: 'washer_dryer', q: 'washer dryer troubleshooting' },
  { test: /kitchen sink|sink.*drain|drain.*clog|slow.*drain/, key: 'kitchen_sink', q: 'kitchen sink drain clog prevention' },
  { test: /garbage disposal|disposal/, key: 'disposal', q: 'garbage disposal jams troubleshooting' },
  { test: /mold|mildew/, key: 'mold', q: 'mold mildew prevention moisture' },
  { test: /dishwasher/, key: 'dishwasher', q: 'dishwasher troubleshooting not draining cleaning' },
  { test: /\bhvac\b|\bac\b|air.?condition|heat.*not.*work|ac.*not.*work|furnace/, key: 'hvac', q: 'HVAC AC heat troubleshooting filter' },
  { test: /water softener|softener/, key: 'water_softener', q: 'water softener salt operation maintenance' },
  { test: /water bill|high.*bill.*water|leak.*prevent/, key: 'high_water_bill', q: 'high water bill leak prevention conservation' },
  { test: /mailbox/, key: 'mailbox', q: 'mailbox issues lost key USPS' },
  { test: /lock.*out|locked.*out|lost.*key|\bkey\b|rekey/, key: 'keys_lockouts', q: 'keys lockouts tenant rekey lockbox' },
  { test: /cost|price|quote|charge|expensive|too much|fair price|good price|benchmark|should i approve|approve.*quote|how much.*should|is.*\$.*too|within range/, key: 'cost_benchmarks', q: 'maintenance cost benchmarks Phoenix repair pricing' },
];

async function getKbContext(msg) {
  const m = (msg || '').toLowerCase();
  for (const route of KB_TOPIC_ROUTES) {
    if (route.test.test(m)) {
      const text = await getKbTopic(route.key, route.q);
      if (text) return { key: route.key, text, label: route.key.replace(/_/g, ' ') };
      return null;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

APTLY — Source of truth for listings and availability:
- Units board (ID: unit) — ALL published listings with beds, baths, rent, available date, Published For Rent field. THIS IS THE ONLY SOURCE for "what units are available" questions. Never use Rentvine for availability.
- Renter leads pipeline (board ID: 4EMDSYKirhQaNdQKz)
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards
- Contact and lead details
- EMERGENCY DETECTION: When showing work orders, always scan descriptions for: water leak, gas leak, no heat, no AC in summer, flood, sewage backup, burst pipe. Flag them as EMERGENCY.

RENTVINE — Source of truth for tenant and accounting data.
ZINSPECTOR — Inspection platform synced with Rentvine.
ALOE KNOWLEDGE BASE — Single source of truth for ALL company policies, procedures, training materials, vendor information, cost benchmarks, troubleshooting guides, and SOPs.
SLACK — Team communications.

Rules:
- Always use tools to get live data — never guess or make up numbers
- Be concise. Lead with the answer, then details
- Never speculate on legal or fair housing matters
- Tone: professional, helpful, like the most knowledgeable senior colleague on the team`;

const ALL_TOOLS = [
  { name: 'rv_get_leases', description: 'Search leases from Rentvine with tenant info, balances, unpaid charges, and property details.', input_schema: { type: 'object', properties: { search: { type: 'string' }, status: { type: 'string' }, page: { type: 'number' } } } },
  { name: 'rv_get_ledger', description: 'Get the full accounting ledger for a lease.', input_schema: { type: 'object', properties: { leaseId: { type: 'number' } }, required: ['leaseId'] } },
  { name: 'rv_get_transactions', description: 'Get full transaction history for a lease.', input_schema: { type: 'object', properties: { leaseId: { type: 'number' } }, required: ['leaseId'] } },
  { name: 'rv_get_properties', description: 'Get properties in the portfolio.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_units', description: 'Get units with rent, deposit, beds, baths, availability.', input_schema: { type: 'object', properties: { search: { type: 'string' }, propertyId: { type: 'number' } } } },
  { name: 'rv_get_owners', description: 'Get owner/landlord contact info.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_work_orders', description: 'Get maintenance work orders.', input_schema: { type: 'object', properties: { status: { type: 'string' }, propertyId: { type: 'number' }, page: { type: 'number' } } } },
  { name: 'rv_get_property_work_order_history', description: 'Get ALL work orders for a specific property.', input_schema: { type: 'object', properties: { address: { type: 'string' }, propertyId: { type: 'number' } } } },
  { name: 'rv_get_work_order_detail', description: 'Get full details for a specific work order by ID.', input_schema: { type: 'object', properties: { workOrderId: { type: 'number' } }, required: ['workOrderId'] } },
  { name: 'rv_get_recurring_issues', description: 'Find properties with recurring work orders.', input_schema: { type: 'object', properties: { category: { type: 'string' }, daysBack: { type: 'number' }, minCount: { type: 'number' } } } },
  { name: 'rv_get_inspections', description: 'Get property inspections from Rentvine.', input_schema: { type: 'object', properties: { propertyId: { type: 'number' }, page: { type: 'number' } } } },
  { name: 'rv_get_inspection_detail', description: 'Get full details of a specific inspection by ID.', input_schema: { type: 'object', properties: { inspectionId: { type: 'number' } }, required: ['inspectionId'] } },
  { name: 'rv_get_tenants', description: 'Search for tenant contacts in Rentvine.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'rv_get_vendors', description: 'Get vendor/contractor list from Rentvine.', input_schema: { type: 'object', properties: { search: { type: 'string' } } } },
  { name: 'aptly_get_board_cards', description: 'Get cards from an Aptly board.', input_schema: { type: 'object', properties: { boardId: { type: 'string' }, page: { type: 'number' } }, required: ['boardId'] } },
  { name: 'aptly_list_boards', description: 'List all available Aptly boards.', input_schema: { type: 'object', properties: {} } },
  { name: 'aptly_search_cards', description: 'Search for specific leads or cards in an Aptly board.', input_schema: { type: 'object', properties: { boardId: { type: 'string' }, query: { type: 'string' } }, required: ['boardId', 'query'] } },
  { name: 'aptly_get_applicant', description: 'Get full details and comments for a specific applicant.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'aptly_get_leads', description: 'Get renter leads from the Renter Leads board.', input_schema: { type: 'object', properties: { daysBack: { type: 'number' }, property: { type: 'string' }, stage: { type: 'string' }, includeArchived: { type: 'boolean' } } } },
  { name: 'aptly_get_work_orders', description: 'PRIMARY source for ALL work order questions.', input_schema: { type: 'object', properties: { status: { type: 'string' }, property: { type: 'string' }, includeArchived: { type: 'boolean' }, includeComments: { type: 'boolean' } } } },
  { name: 'rv_get_work_order_notes', description: 'Get notes/comments for work orders from Rentvine.', input_schema: { type: 'object', properties: { workOrderId: { type: 'string' } } } },
  { name: 'compare_work_orders', description: 'Compare work orders between Aptly and Rentvine.', input_schema: { type: 'object', properties: {} } },
  { name: 'kb_search', description: 'Search the Aloe Knowledge Base.', input_schema: { type: 'object', properties: { query: { type: 'string' }, audience: { type: 'string' }, department: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_search', description: 'Search Slack for team messages.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'slack_get_channel_messages', description: 'Get recent messages from a specific Slack channel.', input_schema: { type: 'object', properties: { channelId: { type: 'string' }, limit: { type: 'number' } }, required: ['channelId'] } },
  { name: 'slack_list_channels', description: 'List all Slack channels.', input_schema: { type: 'object', properties: {} } },
];

function normalizeAddr(str) {
  return (str || '').toLowerCase()
    .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's')
    .replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
    .replace(/\bstreet\b/g, 'st').replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln').replace(/\bcourt\b/g, 'ct')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd').replace(/\bplace\b/g, 'pl')
    .replace(/[.,#]/g, '').replace(/\s+/g, ' ').trim();
}

function fuzzyMatch(query, target) {
  const q = normalizeAddr(query);
  const t = normalizeAddr(target);
  if (t.includes(q)) return true;
  const streetNum = query.match(/\d{3,6}/)?.[0];
  const words = q.split(' ').filter(w => w.length > 2 && !/^\d+$/.test(w));
  if (streetNum && t.includes(streetNum) && words.some(w => t.includes(w))) return true;
  if (words.length > 0 && words.filter(w => t.includes(w)).length / words.length >= 0.6) return true;
  return false;
}

async function rvFetch(path, params = {}) {
  const url = new URL(`${RENTVINE_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });
  const r = await fetch(url.toString(), { headers: { Authorization: `Basic ${RENTVINE_AUTH}` } });
  if (!r.ok) {
    const txt = await r.text();
    console.error('Rentvine error', r.status, txt.slice(0, 200));
    return { error: 'Rentvine ' + r.status + ': ' + txt.slice(0, 100) };
  }
  return r.json();
}

async function aptlyFetch(path, params = {}) {
  const url = new URL('https://app.getaptly.com/api' + path);
  url.searchParams.set('x-token', APTLY_TOKEN);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString());
  if (!r.ok) return { error: 'Aptly ' + r.status };
  return r.json();
}

let _unitsSchema = null;
async function unitsFetch(path, params = {}) {
  const url = new URL('https://core-api.getaptly.com' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
  const r = await fetch(url.toString(), { headers: { 'x-token': unitsToken, 'Accept': 'application/json' } });
  if (!r.ok) return { error: 'Units API ' + r.status, body: await r.text() };
  return r.json();
}

async function getUnitsSchema() {
  if (_unitsSchema) return _unitsSchema;
  const schema = await unitsFetch('/api/schema/unit');
  if (Array.isArray(schema)) {
    _unitsSchema = {};
    schema.forEach(function(f) { _unitsSchema[f.key] = f.label; });
  }
  return _unitsSchema || {};
}

async function getUnitsCards() {
  const schema = await getUnitsSchema();
  let allCards = [];
  let page = 0;
  while (true) {
    const data = await unitsFetch('/api/board/unit', { page, pageSize: 100 });
    const batch = Array.isArray(data) ? data : (data && data.cards) ? data.cards : (data && data.data) ? data.data : [];
    if (batch.length === 0) break;
    allCards = allCards.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  return allCards.map(function(card) {
    const mapped = { _cardId: card.cardId };
    Object.keys(card).forEach(function(k) {
      const label = schema[k] || k;
      const val = card[k];
      mapped[label] = (val && typeof val === 'object' && 'amount' in val) ? '$' + val.amount : val;
    });
    return mapped;
  });
}

let _applicantsSchema = null;
async function getApplicantsSchema() {
  if (_applicantsSchema) return _applicantsSchema;
  const schema = await unitsFetch('/api/schema/MJxaStgENouWrNEKd');
  if (Array.isArray(schema)) {
    _applicantsSchema = {};
    schema.forEach(function(f) { _applicantsSchema[f.key] = f.label; });
  }
  return _applicantsSchema || {};
}

async function getApplicantsCards() {
  const schema = await getApplicantsSchema();
  let allCards = [];
  let page = 0;
  while (true) {
    const data = await unitsFetch('/api/board/MJxaStgENouWrNEKd', { page, pageSize: 50 });
    const batch = Array.isArray(data) ? data : (data && data.data) ? data.data : (data && data.cards) ? data.cards : [];
    if (batch.length === 0) break;
    allCards = allCards.concat(batch);
    if (batch.length < 50) break;
    page++;
  }
  return allCards.map(function(card) {
    const extractName = function(v) {
      if (!v) return '';
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.length > 0 ? (v[0].name || '') : '';
      if (typeof v === 'object') {
        if ('amount' in v) return '$' + v.amount;
        if ('name' in v) return v.name;
        if ('value' in v) return v.value;
      }
      return String(v);
    };
    const mapped = {
      _cardId: card.cardId,
      'Title': card.name || '',
      'Stage': card.stage || '',
      'Application Complete': card.appInputCompleted || card.readyToReview || '',
      'appApproved': card.appApproved || false,
      'Created At': card.createdAt || '',
      'Primary Applicant': extractName(card.appPrimaryApplicant),
      'Application Location': extractName(card.appLocation),
      'Household': card.appHousehold || '',
      'Move-In Date': card.appMoveInDate || '',
      'Total Household Mo. Income': card.appIncome ? '$' + card.appIncome.amount : '',
      'Avg. Household Credit': card.appCreditRating || '',
      'comments': Array.isArray(card.comments) ? card.comments.map(function(c) {
        return { by: c.userName || c.name || 'Unknown', note: c.content || c.text || '', date: (c.createdAt || '').slice(0, 10) };
      }) : [],
    };
    Object.keys(card).forEach(function(k) {
      if (schema[k] && !mapped[schema[k]]) mapped[schema[k]] = extractName(card[k]);
    });
    return mapped;
  });
}

async function ziFetch(path, params = {}) {
  if (!ZINSPECTOR_API_KEY) return { error: 'ZINSPECTOR_API_KEY not set' };
  const bases = ['https://app.zinspector.com/api/v1', 'https://api.zinspector.com/v1'];
  for (const base of bases) {
    try {
      const url = new URL(base + path);
      Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString(), { headers: { 'Authorization': 'Bearer ' + ZINSPECTOR_API_KEY, 'x-api-key': ZINSPECTOR_API_KEY, 'Accept': 'application/json' } });
      if (r.ok) return { base, data: await r.json() };
    } catch(e) {}
  }
  return { error: 'zInspector API unreachable' };
}

async function slackFetch(path, params) {
  params = params || {};
  const url = new URL('https://slack.com/api' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + SLACK_TOKEN } });
  return r.json();
}

async function executeTool(name, input) {
  console.log('Tool: ' + name, JSON.stringify(input).slice(0, 80));
  try {
    switch (name) {
      case 'kb_search': {
        const { results, error } = await kbSearch(input.query, { limit: 5, audience: input.audience, department: input.department });
        if (error) return JSON.stringify({ error, message: 'Knowledge base unreachable' });
        if (!results || results.length === 0) return JSON.stringify({ message: 'No matching documents for: ' + input.query });
        return JSON.stringify({ total: results.length, results: results.map(r => ({ title: r.document_title, content: (r.content || '').slice(0, 1500) })) });
      }
      case 'rv_get_leases': {
        const params = { pageSize: 200, page: input.page || 1 };
        if (input.status === 'inactive') params['primaryLeaseStatusIDs[]'] = 2;
        else if (input.status !== 'all') params['primaryLeaseStatusIDs[]'] = 1;
        const data = await rvFetch('/leases/export', params);
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(item) {
            const tenantMatch = item.lease && item.lease.tenants && item.lease.tenants.some(t => (t.name||'').toLowerCase().includes(q));
            if (tenantMatch) return true;
            return fuzzyMatch(q, (item.property&&item.property.address||'') + ' ' + (item.property&&item.property.city||''));
          }));
        }
        return JSON.stringify(data);
      }
      case 'rv_get_ledger': return JSON.stringify(await rvFetch('/accounting/ledgers', { leaseID: input.leaseId, pageSize: 50 }));
      case 'rv_get_transactions': return JSON.stringify(await rvFetch('/accounting/transactions', { leaseID: input.leaseId, pageSize: 50 }));
      case 'rv_get_properties': {
        let allData = [], pg = 1;
        while (true) {
          const batch = await rvFetch('/properties/export', { pageSize: 200, page: pg });
          if (!Array.isArray(batch) || batch.length === 0) break;
          allData = allData.concat(batch);
          if (batch.length < 200) break;
          pg++;
        }
        if (input.search) {
          return JSON.stringify(allData.filter(item => fuzzyMatch(input.search, (item.property&&item.property.address||'') + ' ' + (item.property&&item.property.city||''))).slice(0,10).map(item => ({ propertyID: item.property&&item.property.propertyID, address: item.property&&item.property.address, city: item.property&&item.property.city })));
        }
        return JSON.stringify({ total: allData.length, message: 'Pass a search term to find specific properties.' });
      }
      case 'rv_get_units': {
        if (!input.propertyId && !input.search) return JSON.stringify({ error: 'propertyId or search required' });
        if (input.propertyId) {
          const units = await rvFetch('/properties/' + input.propertyId + '/units');
          return JSON.stringify(units);
        }
        const leases = await rvFetch('/leases/export', { pageSize: 200 });
        if (Array.isArray(leases)) return JSON.stringify(leases.filter(item => fuzzyMatch(input.search, (item.unit&&item.unit.address||'') + ' ' + (item.property&&item.property.city||''))));
        return JSON.stringify(leases);
      }
      case 'rv_get_owners': {
        const data = await rvFetch('/contacts/owners', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(o => (o.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'rv_get_work_orders': {
        const p = { pageSize: 100 };
        if (input.propertyId) p.propertyID = input.propertyId;
        let allWOs = [];
        for (let pg = 1; pg <= 10; pg++) {
          p.page = pg;
          const data = await rvFetch('/maintenance/work-orders', p);
          const rawBatch = Array.isArray(data) ? data : (data && data.data) || [];
          if (rawBatch.length === 0) break;
          const mapped = rawBatch.map(rec => rec.workOrder ? Object.assign({}, rec.workOrder, { unitAddress: (rec.unit&&(rec.unit.address||rec.unit.name))||'', vendorName: (rec.contact&&rec.contact.name)||'' }) : rec).filter(wo => wo.workOrderID);
          allWOs = allWOs.concat(mapped);
          if (rawBatch.length < 100) break;
        }
        const filtered = input.status === 'closed'
          ? allWOs.filter(wo => { const sid = parseInt(wo.primaryWorkOrderStatusID); return sid===4||sid===5||!!wo.closedDate||!!wo.dateClosed; })
          : allWOs.filter(wo => { const sid = parseInt(wo.primaryWorkOrderStatusID); return !(sid===4||sid===5||!!wo.closedDate||!!wo.dateClosed); });
        return JSON.stringify({ total: filtered.length, workOrders: filtered.slice(0, 50).map(wo => ({ num: wo.workOrderNumber, title: (wo.description||'?').slice(0,60), status: wo.primaryWorkOrderStatusID, prop: (wo.unitAddress||'').slice(0,40), vendor: (wo.vendorName||'').slice(0,30) })) });
      }
      case 'rv_get_property_work_order_history': {
        let propId = input.propertyId;
        if (!propId && input.address) {
          const props = await rvFetch('/properties/export', { pageSize: 200, page: 1 });
          const match = (Array.isArray(props)?props:[]).find(p => ((p.property&&p.property.address)||'').toLowerCase().includes(input.address.toLowerCase().split(' ').slice(0,3).join(' ')));
          if (match) propId = match.property && match.property.propertyID;
        }
        if (!propId) return JSON.stringify({ error: 'Property not found for: ' + input.address });
        const allPages = [];
        for (let pg = 1; pg <= 5; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg, propertyID: propId });
          const batch = Array.isArray(d) ? d : (d&&d.data)||[];
          allPages.push(...batch);
          if (batch.length < 100) break;
        }
        return JSON.stringify({ total: allPages.length, workOrders: allPages.slice(0,50) });
      }
      case 'rv_get_recurring_issues': return JSON.stringify({ message: 'Use rv_get_work_orders and filter client-side' });
      case 'rv_get_work_order_detail': return JSON.stringify(await rvFetch('/maintenance/work-orders/' + input.workOrderId));
      case 'rv_get_work_order_notes': {
        if (input.workOrderId) return JSON.stringify(await rvFetch('/maintenance/work-orders/' + input.workOrderId + '/statuses'));
        return JSON.stringify({ message: 'Pass a workOrderId' });
      }
      case 'rv_get_inspections': {
        const params = { pageSize: 20, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        return JSON.stringify(await rvFetch('/maintenance/inspections', params));
      }
      case 'rv_get_inspection_detail': return JSON.stringify(await rvFetch('/maintenance/inspections/' + input.inspectionId));
      case 'rv_get_tenants': {
        const data = await rvFetch('/contacts/tenants', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(t => (t.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'rv_get_vendors': {
        const data = await rvFetch('/contacts/vendors', { pageSize: 100 });
        if (input.search && Array.isArray(data)) return JSON.stringify(data.filter(v => (v.name||'').toLowerCase().includes(input.search.toLowerCase())));
        return JSON.stringify(data);
      }
      case 'aptly_get_board_cards': {
        const boardId = input.boardId;
        const schemaData = await unitsFetch('/api/schema/' + boardId);
        const schemaMap = {};
        if (Array.isArray(schemaData)) schemaData.forEach(f => { schemaMap[f.key] = f.label; });
        let allCards = [], pg = 0;
        while (true) {
          const data = await unitsFetch('/api/board/' + boardId, { page: pg, pageSize: 50 });
          const batch = Array.isArray(data) ? data : (data&&data.data)||[];
          allCards = allCards.concat(batch);
          if (batch.length < 50) break;
          pg++;
          if (pg > 10) break;
        }
        return JSON.stringify({ cards: allCards.map(card => { const m = { _cardId: card.cardId, stage: card.stage }; Object.keys(card).forEach(k => { m[schemaMap[k]||k] = card[k]; }); return m; }), total: allCards.length });
      }
      case 'aptly_list_boards': return JSON.stringify([{ id: 'unit', name: 'Units/Listings' }, { id: '4EMDSYKirhQaNdQKz', name: 'Renter Leads' }, { id: 'MJxaStgENouWrNEKd', name: 'Applicants' }, { id: 'workOrder', name: 'Work Orders' }]);
      case 'aptly_search_cards': {
        const q = input.query || '';
        const data = await aptlyFetch('/aptlet/' + input.boardId, { page: 0, query: q });
        const cards = (data&&data.cards)||(Array.isArray(data)?data:[]);
        return JSON.stringify(q ? cards.filter(c => JSON.stringify(c).toLowerCase().includes(q.toLowerCase())) : cards);
      }
      case 'aptly_get_applicant': {
        const q = (input.query||'').toLowerCase();
        const allCards = await getApplicantsCards();
        const matched = allCards.filter(c => JSON.stringify(c).toLowerCase().includes(q));
        return JSON.stringify(matched.length === 0 ? { message: 'No applicant found matching: ' + input.query } : matched.slice(0,5));
      }
      case 'aptly_get_leads': {
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100, includeArchived: input.includeArchived ? true : false });
        const allCards = Array.isArray(data) ? data : (data&&data.data)||[];
        let leads = allCards;
        if (input.daysBack) { const cutoff = Date.now() - input.daysBack*86400000; leads = leads.filter(c => { try { return new Date(c.createdAt).getTime() > cutoff; } catch(e) { return false; } }); }
        if (input.property) { const p = input.property.toLowerCase(); leads = leads.filter(c => JSON.stringify(c).toLowerCase().includes(p)); }
        return JSON.stringify({ total: leads.length, leads: leads.slice(0,50) });
      }
      case 'aptly_get_work_orders': {
        let allWOs = [];
        for (let page = 0; page <= 10; page++) {
          const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
          const batch = Array.isArray(data) ? data : (data&&data.data)||[];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
        }
        const activeWOs = allWOs.filter(c => !c.archived && !/^(closed|cancelled|completed|rejected)/i.test(c.stage||''));
        let filtered = activeWOs;
        if (input.status) filtered = activeWOs.filter(c => (c.stage||'').toLowerCase().includes(input.status.toLowerCase()));
        if (input.property) { const p = input.property.toLowerCase(); filtered = filtered.filter(c => JSON.stringify(c).toLowerCase().includes(p)); }
        const now = Date.now();
        const slim = filtered.map(c => {
          const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
          const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
          const address = normalizeAddr((locArr[0]&&locArr[0].name)||(unitArr[0]&&unitArr[0].name)||'');
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          const vendor = (vendorArr[0]&&vendorArr[0].name)||'Unassigned';
          const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
          return { address, num: c.workOrderNumber||'', issue: (c.description||c.name||'').replace(/<[^>]+>/g,' ').trim().slice(0,80), vendor, opened: (c.createdAt||'').slice(0,10), daysOpen: created ? Math.floor((now-created)/86400000) : null, status: c.stage||'' };
        });
        return JSON.stringify({ total: slim.length, workOrders: slim });
      }
      case 'compare_work_orders': return JSON.stringify({ message: 'Use rv_get_work_orders and aptly_get_work_orders separately' });
      case 'slack_search': {
        const data = await slackFetch('/search.messages', { query: input.query, count: 10 });
        if (data.messages&&data.messages.matches) return JSON.stringify(data.messages.matches.map(m => ({ channel: m.channel&&m.channel.name, user: m.username, text: m.text })));
        return JSON.stringify({ message: 'No results' });
      }
      case 'slack_get_channel_messages': {
        const data = await slackFetch('/conversations.history', { channel: input.channelId, limit: input.limit||20 });
        if (data.messages) return JSON.stringify(data.messages.map(m => ({ text: m.text })));
        return JSON.stringify({ error: data.error||'Could not fetch' });
      }
      case 'slack_list_channels': {
        const data = await slackFetch('/conversations.list', { limit: 100, exclude_archived: true });
        if (data.channels) return JSON.stringify(data.channels.map(c => ({ id: c.id, name: c.name })));
        return JSON.stringify({ error: data.error });
      }
      case 'zi_get_inspections': {
        const result = await ziFetch('/inspections', { limit: 10 });
        if (result.error) return JSON.stringify(await rvFetch('/maintenance/inspections', { pageSize: 50 }));
        return JSON.stringify(result);
      }
      default: return JSON.stringify({ error: 'Unknown tool: ' + name });
    }
  } catch (err) {
    console.error('Tool ' + name + ' error:', err.message);
    return JSON.stringify({ error: err.message });
  }
}

function getRelevantTools(msg) {
  msg = (msg || '').toLowerCase();
  const tools = new Set();
  if (msg.match(/tenant|owe|balance|ledger|payment|charge|rent|deposit|past.?due|unpaid|how much/)) ['rv_get_leases','rv_get_ledger','rv_get_transactions'].forEach(t => tools.add(t));
  if (msg.match(/availab|unit|vacant|propert|homes?|bed|bath|tour|showing/)) ['aptly_get_board_cards','aptly_search_cards'].forEach(t => tools.add(t));
  if (msg.match(/work.?order|maintenance|repair|fix|broken/)) tools.add('aptly_get_work_orders');
  if (msg.match(/inspect/)) ['rv_get_inspections','rv_get_inspection_detail'].forEach(t => tools.add(t));
  if (msg.match(/vendor|contractor/)) { tools.add('rv_get_vendors'); tools.add('kb_search'); }
  if (msg.match(/owner|landlord|portfolio/)) ['rv_get_owners','rv_get_properties'].forEach(t => tools.add(t));
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly/)) ['aptly_get_board_cards','aptly_list_boards','aptly_search_cards'].forEach(t => tools.add(t));
  if (msg.match(/applicant|application|applied|applying/)) { tools.add('aptly_get_applicant'); tools.add('aptly_search_cards'); }
  if (msg.match(/policy|procedure|sop|how do|lease.?break|fee|screen|criteria|cost|price|quote|benchmark/)) tools.add('kb_search');
  if (msg.match(/slack|team|announce/)) ['slack_search','slack_get_channel_messages','slack_list_channels'].forEach(t => tools.add(t));
  if (tools.size === 0) ['rv_get_leases','kb_search'].forEach(t => tools.add(t));
  return ALL_TOOLS.filter(t => Array.from(tools).includes(t.name));
}

app.post('/api/chat', async function(req, res) {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const messages = req.body.messages;
    const lastMsg = messages.slice().reverse().find(m => m.role === 'user');
    const tools = getRelevantTools(lastMsg ? lastMsg.content : '');
    const lastContent = messages[messages.length-1]?.content;
    const lowerMsg = (typeof lastContent==='string' ? lastContent : (Array.isArray(lastContent) ? lastContent.map(b=>b.text||'').join(' ') : '')).toLowerCase();
    const userMsg = typeof lastContent==='string' ? lastContent : (Array.isArray(lastContent) ? lastContent.map(b=>b.text||'').join(' ') : '');

    const isVendorQ = lowerMsg.match(/vendor|who.*assign|who.*call|preferred.*vendor|vendor.*list/);
    if (isVendorQ) {
      try {
        const vendorContext = await getKbTopic('vendor_list', 'preferred vendor list service type phone HVAC plumbing electrical landscaping pest', { limit: 4, audience: 'staff' });
        if (vendorContext) {
          const resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: 'You are Aloe Assistant. Answer the vendor question using ONLY the vendor reference provided.', messages: [{ role: 'user', content: 'VENDOR REFERENCE:\n\n' + vendorContext + '\n\n---\nQuestion: ' + userMsg }] }) });
          const data = await resp.json();
          const answer = (data.content&&data.content[0]&&data.content[0].text)||'';
          if (answer) return res.json({ content: [{ type: 'text', text: answer }] });
        }
      } catch(e) { console.error('Vendor shortcut error:', e.message); }
    }

    const isAvailabilityQ = !lowerMsg.match(/work.?order|maintenance|repair|vendor/) && lowerMsg.match(/availab|for rent|vacant|what unit|what prop|homes.*rent|\d\s*bed/) && !lowerMsg.match(/[0-9]{5,6}/);
    if (isAvailabilityQ) {
      try {
        const cards = await getUnitsCards();
        const published = cards.filter(c => c['Published For Rent']==='checked' || c['Published For Rent']===true || c['Syndicate']==='checked');
        if (published.length > 0) {
          const fmt = c => {
            let addr = c.Street || c.Address || c['Marketing Name'] || '?';
            addr = addr.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '');
            const rentRaw = c['Market Rent'] || '';
            const rent = rentRaw && typeof rentRaw==='object' && rentRaw.amount ? '$' + Number(rentRaw.amount).toLocaleString() : rentRaw;
            const beds = c.Beds ? c.Beds + 'bd/' + (c.Baths||'?') + 'ba' : '';
            return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '');
          };
          return res.json({ content: [{ type: 'text', text: 'Homes published for rent (' + published.length + '):\n\n' + published.map(fmt).join('\n') }] });
        }
      } catch(e) { console.error('Units shortcut error:', e.message); }
    }

    const isApplicationQ = lowerMsg.match(/application|applicant|applied|applying/) && !lowerMsg.match(/[0-9]{5,6}/);
    if (isApplicationQ) {
      try {
        const cards = await getApplicantsCards();
        const active = cards.filter(c => !c.archived && c.Stage !== 'Application Closed' && c.Stage !== 'Archived');
        if (active.length > 0) {
          const fmt = c => (c['Application Location']||'(no address)') + ' — ' + (c['Primary Applicant']||'?') + (c.appApproved ? ' APPROVED' : '');
          return res.json({ content: [{ type: 'text', text: 'Active applications (' + active.length + '):\n\n' + active.slice(0,20).map(fmt).join('\n') }] });
        }
      } catch(e) { console.error('Applications shortcut error:', e.message); }
    }

    let current = messages.slice();
    for (let i = 0; i < 10; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 1024,
          system: await (async function() {
            let sys = SYSTEM_PROMPT;
            if (i === 0) {
              const ctx = await getKbContext(lowerMsg);
              if (ctx && ctx.text) sys += '\n\n---\nRELEVANT KB CONTENT (' + ctx.label + '):\n' + ctx.text.slice(0, 4000);
            }
            return sys;
          })(),
          messages: current,
          tools: tools,
        }),
      });
      const data = await r.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      if (data.stop_reason !== 'tool_use') return res.json(data);
      const tbs = data.content.filter(b => b.type === 'tool_use');
      const results = await Promise.all(tbs.map(async tb => {
        let result = await executeTool(tb.name, tb.input);
        if (typeof result === 'string' && result.length > 15000) result = result.slice(0, 15000) + '...[truncated]';
        return { type: 'tool_result', tool_use_id: tb.id, content: result };
      }));
      current = current.concat([{ role: 'assistant', content: data.content }, { role: 'user', content: results }]);
    }
    res.status(500).json({ error: 'Too many steps — try a more specific question' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/rentvine', async function(req, res) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  const rvPath = req.path;
  const query = new URLSearchParams(req.query).toString();
  const url = `${RENTVINE_BASE}${rvPath}${query ? '?' + query : ''}`;
  try {
    const opts = { headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'Content-Type': 'application/json' } };
    if (req.method === 'POST') { opts.method = 'POST'; opts.body = JSON.stringify(req.body); }
    const r = await fetch(url, opts);
    res.json(await r.json());
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ── WO Sync: Auto-close in Rentvine WOs that are closed/cancelled in Aptly ──
async function fetchAllAptlyClosedWOs() {
  const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
  const schemaResp = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
  const schema = await schemaResp.json();
  const schemaMap = {};
  if (Array.isArray(schema)) schema.forEach(f => { schemaMap[f.key] = f.label; });
  const woNumKey = Object.entries(schemaMap).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || null;
  const isClosedKey = Object.entries(schemaMap).find(([k,v]) => /^is.?closed$/i.test(v))?.[0] || null;
  const closedDateKey = Object.entries(schemaMap).find(([k,v]) => /^closed.?date$/i.test(v))?.[0] || null;
  console.log('WO Sync schema keys:', { woNumKey, isClosedKey, closedDateKey });

  let all = [];
  for (const archived of ['false', 'true']) {
    let page = 0;
    while (page < 50) {
      const resp = await fetch(
        'https://core-api.getaptly.com/api/board/workOrder?page=' + page + '&pageSize=100&includeArchived=' + archived,
        { headers: { 'x-token': APTLY_TOK } }
      );
      if (!resp.ok) break;
      const raw = await resp.json();
      const items = Array.isArray(raw) ? raw : (raw && raw.data) || (raw && raw.cards) || [];
      if (!items.length) break;
      const existingIds = new Set(all.map(c => c._id));
      items.forEach(c => { if (!existingIds.has(c._id)) all.push(c); });
      if (items.length < 100) break;
      page++;
    }
  }
  console.log('WO Sync: fetched ' + all.length + ' total Aptly WO cards');

  const cutoff = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days
  return all.filter(c => {
    const woNum = c[woNumKey] || c.workOrderNumber;
    const stage = (c.stage || c.Stage || '').toLowerCase();
    const isClosedStage = /^(completed|cancelled|closed|done)/.test(stage) && !/^(scheduled|requested|open|pending|waiting|home warranty|unit turn|internal)/.test(stage);
    const hasClosedDate = !!(c.dateClosed || c['Closed Date'] || (closedDateKey && c[closedDateKey]));
    const hasWONumber = !!(woNum && String(woNum).trim());
    const isRecent = c.stageUpdatedAt ? new Date(c.stageUpdatedAt).getTime() > cutoff : (c.createdAt ? new Date(c.createdAt).getTime() > cutoff : true);
    // Only use closedDate signal if stage is also terminal — avoids flagging Scheduled WOs with a closed date
    const isTrulyDone = isClosedStage || (hasClosedDate && isClosedStage);
    return hasWONumber && isRecent && isTrulyDone;
  }).map(c => {
    const woNum = c[woNumKey] || c.workOrderNumber;
    return Object.assign({}, c, { _woNumber: String(woNum).trim() });
  });
}

async function fetchAllRVOpenWOs() {
  let all = [], pg = 1;
  while (pg <= 20) {
    const data = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
    const rawBatch = Array.isArray(data) ? data : (data && data.data) || [];
    if (!rawBatch.length) break;
    rawBatch.forEach(rec => {
      const wo = rec.workOrder || rec;
      if (!wo.workOrderID) return;
      wo._unitAddress = (rec.unit && (rec.unit.address || rec.unit.name)) || (rec.property && rec.property.address) || wo.unitAddress || '';
      const sid = parseInt(wo.primaryWorkOrderStatusID || 0);
      // 3=Closed only — keep Pending(1), Open(2), OnHold(4) as "open"
      // primaryWorkOrderStatusID: 3=Closed, 5=Cancelled — both are terminal
      const isClosed = sid === 3 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
      if (!isClosed) all.push(wo);
    });
    if (rawBatch.length < 100) break;
    pg++;
  }
  return all;
}

async function closeRVWorkOrder(workOrderId) {
  const url = RENTVINE_BASE + '/maintenance/work-orders/' + workOrderId;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Authorization': 'Basic ' + RENTVINE_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ primaryWorkOrderStatusID: 3 })
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch(e) { json = { raw: text }; }
  if (!resp.ok) {
    const putResp = await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': 'Basic ' + RENTVINE_AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryWorkOrderStatusID: 3 })
    });
    const putText = await putResp.text();
    let putJson; try { putJson = JSON.parse(putText); } catch(e) { putJson = { raw: putText }; }
    return { ok: putResp.ok, status: putResp.status, body: putJson };
  }
  return { ok: resp.ok, status: resp.status, body: json };
}

async function runWOSync(dryRun) {
  dryRun = dryRun === true;
  console.log('WO Sync: starting dryRun=' + dryRun);
  const [aptlyClosed, rvOpen] = await Promise.all([fetchAllAptlyClosedWOs(), fetchAllRVOpenWOs()]);
  const rvByNumber = {};
  rvOpen.forEach(wo => { const n = String(wo.workOrderNumber || '').trim(); if (n) rvByNumber[n] = wo; });
  const toClose = [];
 aptlyClosed.forEach(card => {
    const rvWO = rvByNumber[card._woNumber];
    if (rvWO) {
      const unitArr = Array.isArray(card.unit) ? card.unit : (card.unit ? [card.unit] : []);
      const locArr = Array.isArray(card.location) ? card.location : (card.location ? [card.location] : []);
      const aptlyAddr = (unitArr[0] && unitArr[0].name) || (locArr[0] && locArr[0].name) || card.name || '';
      const address = rvWO._unitAddress || aptlyAddr || '';
      toClose.push({
        woNumber: card._woNumber,
        rvWorkOrderId: rvWO.workOrderID,
        address: address.slice(0, 60),
        aptlyStage: card.stage || card.Stage || '',
        aptlyClosedDate: card.dateClosed || card['Closed Date'] || card['Stage Changed'] || ''
      });
    }
  });
  console.log('WO Sync: ' + aptlyClosed.length + ' closed in Aptly, ' + rvOpen.length + ' open in RV, ' + toClose.length + ' to close');
  if (dryRun) return { dryRun: true, aptlyClosedCount: aptlyClosed.length, rvOpenCount: rvOpen.length, wouldClose: toClose };

  if (SLACK_TOKEN && toClose.length > 0) {
    const lines = toClose.map(r =>
      '• <https://aloepm.rentvine.com/maintenance/work-orders/' + r.rvWorkOrderId + '|WO #' + r.woNumber + '> — ' + (r.address || 'see link') + ' — _' + r.aptlyStage + ' in Aptly_'
    ).join('\n');
    const slackText = '*🔧 WO Sync — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '*\n' +
      '*' + toClose.length + ' work order(s) closed/cancelled in Aptly but still open in Rentvine:*\n' + lines +
      '\n\n_Click each link → open in Rentvine → close · Runs nightly 11pm AZ_';
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C06BWVACZQF', text: slackText })
      });
      console.log('WO Sync: Slack alert sent for ' + toClose.length + ' WOs');
    } catch(e) { console.error('WO Sync Slack error:', e.message); }
  } else if (toClose.length === 0) {
    console.log('WO Sync: systems in sync');
  }
  // Reverse check: Aptly open WOs missing from Rentvine entirely
  const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
  const schemaResp2 = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
  const schema2 = await schemaResp2.json();
  const schemaMap2 = {};
  if (Array.isArray(schema2)) schema2.forEach(f => { schemaMap2[f.key] = f.label; });
  const woNumKey2 = Object.entries(schemaMap2).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || 'workOrderNumber';

  let aptlyOpen = [], page2 = 0;
  while (page2 < 50) {
    const resp2 = await fetch('https://core-api.getaptly.com/api/board/workOrder?page=' + page2 + '&pageSize=100&includeArchived=false', { headers: { 'x-token': APTLY_TOK } });
    if (!resp2.ok) break;
    const raw2 = await resp2.json();
    const items2 = Array.isArray(raw2) ? raw2 : (raw2 && raw2.data) || [];
    if (!items2.length) break;
    aptlyOpen = aptlyOpen.concat(items2);
    if (items2.length < 100) break;
    page2++;
  }

  const rvNumbers = new Set(rvOpen.map(wo => String(wo.workOrderNumber || '').trim()));
  const missingInRV = aptlyOpen.filter(c => {
    const woNum = c[woNumKey2] || c.workOrderNumber;
    const stage = (c.stage || c.Stage || '').toLowerCase();
    const isActiveStage = !/^(completed|cancelled|closed|done)/.test(stage);
    return woNum && isActiveStage && !rvNumbers.has(String(woNum).trim());
  }).map(c => {
    const woNum = c[woNumKey2] || c.workOrderNumber;
    const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
    const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
    const addr = (unitArr[0] && unitArr[0].name) || (locArr[0] && locArr[0].name) || c.name || '';
    return { woNumber: String(woNum).trim(), address: addr.slice(0, 60), aptlyStage: c.stage || c.Stage || '' };
  });

  if (SLACK_TOKEN && missingInRV.length > 0) {
    const lines2 = missingInRV.map(r =>
      '• WO #' + r.woNumber + ' — ' + (r.address || 'see Aptly') + ' — _' + r.aptlyStage + ' in Aptly_'
    ).join('\n');
    const slackText2 = '*⚠️ WO Sync — ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '*\n' +
      '*' + missingInRV.length + ' work order(s) open in Aptly but missing from Rentvine:*\n' + lines2 +
      '\n\n_These WOs may need to be created in Rentvine · Runs nightly 11pm AZ_';
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'C06BWVACZQF', text: slackText2 })
      });
      console.log('WO Sync: missing-in-RV alert sent for ' + missingInRV.length + ' WOs');
    } catch(e) { console.error('WO Sync missing-in-RV Slack error:', e.message); }
  }

  return { notified: toClose.length, items: toClose, missingInRentvine: missingInRV };
  }

app.get('/api/wo-sync/debug', async (req, res) => {
  try {
    const APTLY_TOK = process.env.APTLY_TOKEN || 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';
    const schemaResp = await fetch('https://core-api.getaptly.com/api/schema/workOrder', { headers: { 'x-token': APTLY_TOK } });
    const schema = await schemaResp.json();
    const schemaMap = {};
    if (Array.isArray(schema)) schema.forEach(f => { schemaMap[f.key] = f.label; });
    const woNumKey = Object.entries(schemaMap).find(([k,v]) => /work.?order.?num/i.test(v))?.[0] || null;
    const isClosedKey = Object.entries(schemaMap).find(([k,v]) => /^is.?closed$/i.test(v))?.[0] || null;
    const closedDateKey = Object.entries(schemaMap).find(([k,v]) => /^closed.?date$/i.test(v))?.[0] || null;
    const resp = await fetch('https://core-api.getaptly.com/api/board/workOrder?page=0&pageSize=10&includeArchived=true', { headers: { 'x-token': APTLY_TOK } });
    const raw = await resp.json();
    const items = Array.isArray(raw) ? raw : (raw && raw.data) || (raw && raw.cards) || [];
    const firstCardValues = items[0] ? Object.entries(items[0]).slice(0, 40).map(([k, v]) => ({
      key: k, label: schemaMap[k] || '(no label)',
      value: typeof v === 'object' ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)
    })) : [];
    const closed = await fetchAllAptlyClosedWOs();
    const rvOpen = await fetchAllRVOpenWOs();
    res.json({
      schemaFieldCount: Object.keys(schemaMap).length,
      woNumKey, isClosedKey, closedDateKey,
      firstCardValues,
      aptlyClosedCount: closed.length,
      aptlyClosedSample: closed.slice(0, 5).map(c => ({ woNumber: c._woNumber, stage: c.stage || c.Stage, isClosed: c['Is Closed'], closedDate: c['Closed Date'] })),
      rvOpenCount: rvOpen.length,
      rvSample: rvOpen.slice(0, 3).map(wo => ({ workOrderNumber: wo.workOrderNumber, statusID: wo.primaryWorkOrderStatusID, address: wo._unitAddress }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wo-sync/dry-run', async (req, res) => {
  try { res.json(await runWOSync(true)); } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/wo-sync/run', async (req, res) => {
  try { res.json(await runWOSync(false)); } catch(e) { res.status(500).json({ error: e.message }); }
});

function scheduleWOSync() {
  function msUntilNext11pm() {
    const now = new Date();
    const az = new Date(now.toLocaleString('en-US', { timeZone: 'America/Phoenix' }));
    const next = new Date(az); next.setHours(23, 0, 0, 0);
    if (az >= next) next.setDate(next.getDate() + 1);
    return next - az;
  }
  setTimeout(function tick() {
    runWOSync(false).catch(e => console.error('WO Sync nightly error:', e.message));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntilNext11pm());
  console.log('WO Sync: scheduled nightly at 11pm AZ time');
}
scheduleWOSync();
// ── End WO Sync ──
// ── End WO Sync ──
app.get('/api/test-slack', async (req, res) => {
  try {
    const r = await fetch('https://hooks.slack.com/services/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', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test from Aloe server — webhook working!' })
    });
    const text = await r.text();
    res.json({ status: r.status, response: text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/reload-kb-cache', function(req, res) {
  Object.keys(KB_TOPIC_CACHE).forEach(k => delete KB_TOPIC_CACHE[k]);
  res.json({ cleared: true });
});
app.get('/chat', (req, res) => res.sendFile(new URL('chat.html', import.meta.url).pathname));
app.get('/sandbox', (req, res) => res.sendFile(new URL('sandbox.html', import.meta.url).pathname));
app.get('/recon-bills', (req, res) => res.sendFile(new URL('recon-bills.html', import.meta.url).pathname));
app.get('/bank-setup', (req, res) => res.sendFile(new URL('plaid-setup.html', import.meta.url).pathname));
app.get('/logo.png', (req, res) => res.sendFile(new URL('AloePM-Logo_FullColor__2_.png', import.meta.url).pathname));
app.get('/rent-analysis', (req, res) => res.sendFile(new URL('./rent-analysis.html', import.meta.url).pathname));
app.get('/sale-analysis', (req, res) => res.sendFile(new URL('./sale-analysis.html', import.meta.url).pathname));
app.get('/owner-report', (req, res) => res.sendFile(new URL('./owner-report.html', import.meta.url).pathname));
app.get('/metrics', (req, res) => res.sendFile(new URL('./metrics.html', import.meta.url).pathname));

// ── Metrics helpers ────────────────────────────────────────────────────────
function monthKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function buildMonthBuckets(n = 12) {
  const buckets = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    buckets[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`] = 0;
  }
  return buckets;
}
function thisMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function daysAgo(dateStr, from = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return Math.floor((from - d) / 86400000);
}

let _metricsCache = null;
let _metricsCacheTime = 0;
const METRICS_CACHE_TTL = 15 * 60 * 1000;

app.get('/api/metrics/refresh', (req, res) => {
  _metricsCache = null; _metricsCacheTime = 0;
  res.json({ cleared: true });
});

async function buildMetricsData() {
  const fetchStart = Date.now();
  const TMK = thisMonthKey();
  const now = new Date();

  async function fetchAllPages(path, params = {}, maxPages = 10) {
    let all = [], pg = 1;
    while (pg <= maxPages) {
      const batch = await rvFetch(path, { ...params, pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all = all.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }
    return all;
  }

  const [allProps, allUnits, activeLeasesRaw, closedLeasesRaw, allPropsList] = await Promise.all([
    fetchAllPages('/properties/export', { isActive: true }, 5),
    fetchAllPages('/properties/units/export', { isActive: true }, 5),
    fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 2 }, 5),
    fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 3 }, 8),
fetchAllPages('/properties/export', { isActive: true }, 5),
  ]);

  const propContractDatesMap = {};
  allPropsList.forEach(p => { if (p.propertyID && p.dateContractBegins) propContractDatesMap[String(p.propertyID)] = p.dateContractBegins; });

  const unwrap = items => items.map(item => {
    const l = item.lease || item;
    l._unit = item.unit || {}; l._property = item.property || {};
    l._balances = item.balances || {}; l._unpaidCharges = item.unpaidCharges || {};
    return l;
  });

  const activeLeases = unwrap(activeLeasesRaw);
  const closedLeases = unwrap(closedLeasesRaw);
  const allLeases = [...activeLeases, ...closedLeases];

  const isUnitActive = u => u.isActive === true || u.isActive === 1 || u.isActive === '1';
  const isUnitVacant = u => u.isVacant === true || u.isVacant === 1 || u.isVacant === '1';
  const activeUnits = allUnits.filter(item => isUnitActive(item.unit || item));
  const totalUnits = activeUnits.length;
  const vacantUnits = activeUnits.filter(item => isUnitVacant(item.unit || item)).length;
  const occupiedUnits = totalUnits - vacantUnits;
  const occupancyRate = totalUnits > 0 ? +((occupiedUnits / totalUnits) * 100).toFixed(1) : 0;
  const activeUnitIDs = new Set(activeUnits.map(item => String((item.unit||item).unitID)).filter(Boolean));

  const allUnitRents = activeUnits.map(item => parseFloat((item.unit||item).rent||0)).filter(r => r > 0);
  const occupiedUnitRents = activeUnits.filter(item => !isUnitVacant(item.unit||item)).map(item => parseFloat((item.unit||item).rent||0)).filter(r => r > 0);
  const avgRent = allUnitRents.length ? Math.round(allUnitRents.reduce((a,b)=>a+b,0)/allUnitRents.length) : 0;
  const totalRentExpected = Math.round(occupiedUnitRents.reduce((a,b)=>a+b,0));
  const vacancyLoss = vacantUnits * 85;

  const propGainedByMonth = buildMonthBuckets(24);
  let propGainedMTD = 0;
  allProps.forEach(item => {
    const p = item.property || item;
    const contractBegins = propContractDatesMap[String(p.propertyID)] || p.dateContractBegins;
    const dateAdded = contractBegins || p.dateTimeCreated;
    const k = monthKey(dateAdded);
    if (k && propGainedByMonth[k] !== undefined) { propGainedByMonth[k]++; if (k === TMK) propGainedMTD++; }
  });

  const moveInsByMonth = buildMonthBuckets(24);
  const moveOutsByMonth = buildMonthBuckets(24);
  let moveInsMTD = 0, moveOutsMTD = 0;
  const pastDueTenants = [];
  let totalPastDue = 0;

  allLeases.forEach(l => {
    const mk = monthKey(l.moveInDate || l.startDate);
    if (mk && moveInsByMonth[mk] !== undefined) moveInsByMonth[mk]++;
    if (mk === TMK) moveInsMTD++;

    if (parseInt(l.primaryLeaseStatusID||0) === 3) {
      const unitStillActive = activeUnitIDs.has(String(l.unitID));
      const moveOutDate = l.expectedMoveOutDate || (l.moveOutDate && unitStillActive ? l.moveOutDate : null);
      const mok = monthKey(moveOutDate);
      if (moveOutDate && mok) {
        if (moveOutsByMonth[mok] !== undefined) moveOutsByMonth[mok]++;
        if (mok === TMK) moveOutsMTD++;
      }
    }

    if (parseInt(l.primaryLeaseStatusID||0) === 2 && l._balances) {
      const pastDueRent = parseFloat(l._balances.pastDueRentAmount || 0);
      if (pastDueRent > 0 && parseInt(l.leaseStatusID||0) !== 10) {
        const tenantName = Array.isArray(l.tenants) ? l.tenants.filter(t=>t.isActive).map(t=>t.name).join(', ') || '--' : (l.tenants||'--');
        pastDueTenants.push({ leaseID: l.leaseID, tenant: tenantName, address: l._unit.address||l._property.address||'', city: l._unit.city||l._property.city||'', pastDueRent });
        totalPastDue += pastDueRent;
      }
    }
  });

  // Aptly data
  const APTLY_BASE2 = 'https://core-api.getaptly.com';
  const APTLY_TOK = 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';

  async function fetchAptlyBoard(boardId, opts = {}) {
    let all = [], pg = 0;
    const max = opts.maxPages || 5;
    const extraParams = opts.params || {};
    while (pg < max) {
      const params = new URLSearchParams({ page: pg, pageSize: 100, ...extraParams });
      const resp = await fetch(APTLY_BASE2 + '/api/board/' + boardId + '?' + params.toString(), { headers: { 'x-token': APTLY_TOK } });
      if (!resp.ok) break;
      const batch = await resp.json();
      const items = Array.isArray(batch) ? batch : (batch&&batch.data)||[];
      if (items.length === 0) break;
      all = all.concat(items);
      if (items.length < 100) break;
      pg++;
    }
    return all;
  }

  async function fetchAptlySchema2(boardId) {
    try {
      const resp = await fetch(APTLY_BASE2 + '/api/schema/' + boardId, { headers: { 'x-token': APTLY_TOK } });
      if (!resp.ok) return {};
      const fields = await resp.json();
      const map = {};
      if (Array.isArray(fields)) fields.forEach(f => { map[f.key] = f.label; });
      return map;
    } catch(e) { return {}; }
  }

  const [offboardSchema, pmaSchema, renewalSchema] = await Promise.all([
    fetchAptlySchema2('BaMiriNFDZBtWd5rR'),
    fetchAptlySchema2('QySZ8yRWJ5KeYFcZt'),
    fetchAptlySchema2('86YrLPbwdkxtdyZoj'),
  ]);

  const resolveFields = (card, schemaMap) => {
    const resolved = Object.assign({}, card);
    Object.keys(schemaMap).forEach(uuid => { if (uuid in card) resolved[schemaMap[uuid]] = card[uuid]; });
    return resolved;
  };

  const [allApps, unitsCards, allLeadsRaw, allPMARaw, allOffboardRaw, allMoveOuts, allWOsRaw, allRenewalsRaw] = await Promise.all([
    fetchAptlyBoard('MJxaStgENouWrNEKd', { maxPages: 10, params: { includeArchived: true } }),
    getUnitsCards(),
    fetchAptlyBoard('4EMDSYKirhQaNdQKz', { maxPages: 2, params: { includeArchived: false } }),
    fetchAptlyBoard('QySZ8yRWJ5KeYFcZt', { maxPages: 15, params: { includeArchived: true } }),
    fetchAptlyBoard('BaMiriNFDZBtWd5rR', { maxPages: 2, params: { includeArchived: true } }),
    fetchAptlyBoard('YA3QWmPebvMwLwbB3', { maxPages: 2, params: { includeArchived: true } }),
    fetchAptlyBoard('workOrder', { maxPages: 2, params: { includeArchived: false } }),
    fetchAptlyBoard('86YrLPbwdkxtdyZoj', { maxPages: 5, params: { includeArchived: true } }),
  ]);

  const allPMA = allPMARaw.map(c => resolveFields(c, pmaSchema));
  const allOffboard = allOffboardRaw.map(c => resolveFields(c, offboardSchema));
  const allRenewals = allRenewalsRaw.map(c => resolveFields(c, renewalSchema));
  const allWOs = allWOsRaw.filter(c => !c.archived && !/closed|cancelled|complete/i.test(c.stage||''));

  const publishedListings = unitsCards.filter(c => c['Published For Rent']==='checked'||c['Published For Rent']===true||c['Syndicate']==='checked');
  const nowMs = Date.now();

  // Expirations from Tenant Renewals board
  const expirationsByMonth = buildMonthBuckets(24);
  let upcomingExpirations = 0;
  const in90 = new Date(); in90.setDate(in90.getDate() + 90);
  const renewalCardDetails = [];
  allRenewals.forEach(card => {
    let endDate = card['Mirror End Date'];
    if (!endDate && card.Title) { const m = card.Title.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) endDate = m[3]+'-'+m[1]+'-'+m[2]; }
    if (!endDate) return;
    const ek = monthKey(endDate);
    if (ek && expirationsByMonth[ek] !== undefined) expirationsByMonth[ek]++;
    if (new Date(endDate) >= now && new Date(endDate) <= in90 && !card['Is Won']) upcomingExpirations++;
    if (ek) renewalCardDetails.push({ address: card['Mirror Address']?card['Mirror Address'].address:'', endDate, monthKey: ek, stage: card.Stage||'', isWon: card['Is Won']||false });
  });

  // Applications
  const appsByMonth = buildMonthBuckets(24);
  const appsApprovedByMonth = buildMonthBuckets(24);
  let appsMTD = 0, appsApprovedMTD = 0;
  const appStatusCounts = {};
  let appRevenueMTD = 0;
  const appRevenueByMonth = buildMonthBuckets(24);

  allApps.forEach(card => {
    const createdDate = card.appCreated || card.createdAt;
    const k = monthKey(createdDate);
    if (k && appsByMonth[k] !== undefined) appsByMonth[k]++;
    if (k === TMK) appsMTD++;
    const statusObj = card.appStatus || card.Status || {};
    const statusLabel = statusObj.status || '';
    if (statusLabel) appStatusCounts[statusLabel] = (appStatusCounts[statusLabel]||0) + 1;
    const isApproved = (statusObj.uuid||'').includes('approved') || card.appStatusIsApproved === true;
    if (isApproved) { if (k && appsApprovedByMonth[k] !== undefined) appsApprovedByMonth[k]++; if (k===TMK) appsApprovedMTD++; }
    const payments = card.appPayments || [];
    if (Array.isArray(payments)) payments.forEach(p => { const amt = p.amount ? parseFloat(p.amount.amount||0)/100 : 0; if (amt>0&&k) { if (appRevenueByMonth[k]!==undefined) appRevenueByMonth[k]+=amt; if (k===TMK) appRevenueMTD+=amt; } });
  });

  // Owner pipeline
  const newLeadsByMonth = buildMonthBuckets(24);
  let newLeadsMTD = 0;
  allPMA.forEach(card => { const k = monthKey(card.createdAt); if (k && newLeadsByMonth[k] !== undefined) newLeadsByMonth[k]++; if (k===TMK) newLeadsMTD++; });

  const pmaSignedByMonth = buildMonthBuckets(24);
  let pmaSignedMTD = 0;
  allPMA.filter(c => (c.stage||'') === 'PMA Signed').forEach(card => {
    const sk = monthKey(card.stageUpdatedAt || card.createdAt);
    if (sk && pmaSignedByMonth[sk] !== undefined) pmaSignedByMonth[sk]++;
    if (sk === TMK) pmaSignedMTD++;
  });

  const lostByMonth = buildMonthBuckets(48);
  const lostReasons = {};
  let lostMTD = 0;
  allPMA.filter(c => (c.stage||'') === 'Lost').forEach(card => {
    const k = monthKey(card.stageUpdatedAt || card.createdAt);
    if (k && lostByMonth[k] !== undefined) lostByMonth[k]++;
    if (k === TMK) lostMTD++;
    const reason = card['Lost Reason'] || card.lostReason || '';
    if (reason) lostReasons[reason] = (lostReasons[reason]||0) + 1;
  });

  // End management
  const endMgmtByMonth = buildMonthBuckets(24);
  const endMgmtReasons = {};
  let endMgmtMTD = 0;
  const seenEndMgmt = new Set();
  allOffboard.forEach(card => {
    const contractEnd = card['Mirror Date Contract Ends'];
    if (!contractEnd) return;
    const ek = monthKey(contractEnd);
    const title = (card.Title||card.name||'').trim();
    const streetNum = title.match(/^(\d+)/)?.[1] || title;
    const dedupKey = streetNum + '|' + ek;
    if (seenEndMgmt.has(dedupKey)) return;
    seenEndMgmt.add(dedupKey);
    if (ek && endMgmtByMonth[ek] !== undefined) endMgmtByMonth[ek]++;
    if (ek === TMK) endMgmtMTD++;
    const reason = card['Reason'] || '';
    if (reason) endMgmtReasons[reason] = (endMgmtReasons[reason]||0) + 1;
  });

  // Work orders
  const woByStage = {};
  allWOs.forEach(c => { const s = c.stage||'Unknown'; woByStage[s] = (woByStage[s]||0)+1; });
  const unassignedWOs = allWOs.filter(c => (Array.isArray(c.vendor)?c.vendor:(c.vendor?[c.vendor]:[])).length===0).length;

  // Comprehensive inspections
  let comprehensiveInspYes = 0, comprehensiveInspNo = 0;
  allMoveOuts.forEach(card => {
    const val = String(card['Comprehensive Inspection']||'').trim().toLowerCase();
    if (val==='yes') comprehensiveInspYes++; else if (val==='no') comprehensiveInspNo++;
  });

  const formatTrend = obj => Object.entries(obj).sort().map(([month, value]) => ({ month, value }));

  const propTrend = Object.keys(propGainedByMonth).sort().map(k => ({ month: k, gained: propGainedByMonth[k]||0, total: 0 }));
  let running = allProps.length;
  for (let i = propTrend.length-1; i >= 0; i--) { propTrend[i].total = running; running -= propTrend[i].gained; if (running < 0) running = 0; }

  const vacantUnitsList = activeUnits.filter(item => isUnitVacant(item.unit||item)).map(item => { const u = item.unit||item; const p2 = item.property||{}; return { address: u.address||p2.address||'—', city: u.city||p2.city||'', beds: u.bedrooms||u.beds||'', baths: u.bathrooms||u.baths||'', rent: parseFloat(u.marketRent||u.rent||0) }; }).sort((a,b) => (a.address||'').localeCompare(b.address||''));

  console.log('Metrics: fetched in', Math.round((Date.now()-fetchStart)/1000), 's');
  return {
    generatedAt: new Date().toISOString(),
    thisMonth: TMK,
    portfolio: {
      activeProperties: allProps.filter(i => { const p=i.property||i; return p.isActive===true||p.isActive===1||p.isActive==='1'; }).length,
      totalUnits, occupiedUnits, vacantUnits, occupancyRate, avgRent, vacancyLoss, totalRentExpected,
      pastDueTenants: pastDueTenants.sort((a,b)=>b.pastDueRent-a.pastDueRent),
      totalPastDue: Math.round(totalPastDue*100)/100,
      pastDueCount: pastDueTenants.length,
      gainedMTD: propGainedMTD,
      activeListings: publishedListings.length,
      propGainedTrend: formatTrend(propGainedByMonth),
      propTrend, vacantUnitsList,
    },
    leases: {
      active: activeLeases.length, moveInsMTD, moveOutsMTD, upcomingExpirations,
      moveInsByMonth: formatTrend(moveInsByMonth),
      moveOutsByMonth: formatTrend(moveOutsByMonth),
      expirationsByMonth: formatTrend(expirationsByMonth),
      renewalsDetail: renewalCardDetails.sort((a,b)=>(a.endDate||'').localeCompare(b.endDate||'')),
    },
    applications: {
      totalMTD: appsMTD, approvedMTD: appsApprovedMTD,
      revenueMTD: Math.round(appRevenueMTD*100)/100,
      totalAllTime: allApps.length,
      statusCounts: appStatusCounts,
      byMonth: formatTrend(appsByMonth),
      approvedByMonth: formatTrend(appsApprovedByMonth),
      revenueByMonth: formatTrend(appRevenueByMonth),
    },
    pipeline: {
      signedMTD: pmaSignedMTD, newLeadsMTD, lostMTD,
      signedByMonth: formatTrend(pmaSignedByMonth),
      newLeadsByMonth: formatTrend(newLeadsByMonth),
      lostByMonth: formatTrend(lostByMonth),
      lostReasons: Object.entries(lostReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
    },
    endManagement: {
      totalMTD: endMgmtMTD,
      byMonth: formatTrend(endMgmtByMonth),
      reasons: Object.entries(endMgmtReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
    },
    comprehensiveInspections: { yes: comprehensiveInspYes, no: comprehensiveInspNo, total: comprehensiveInspYes+comprehensiveInspNo },
    workOrders: {
      openTotal: allWOs.length, unassigned: unassignedWOs,
      byStage: Object.entries(woByStage).sort((a,b)=>b[1]-a[1]).map(([stage,count])=>({stage,count})),
    },
  };
}

app.get('/api/metrics', async (req, res) => {
  try {
    const now_cache = Date.now();
    if (_metricsCache && (now_cache - _metricsCacheTime) < METRICS_CACHE_TTL) return res.json(_metricsCache);
    const data = await buildMetricsData();
    _metricsCache = data; _metricsCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error('Metrics API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/metrics/refresh', (req, res) => { _metricsCache = null; _metricsCacheTime = 0; res.json({ cleared: true }); });
app.get('/api/metrics/debug-units', async (req, res) => { try { const data = await rvFetch('/properties/units/export', { pageSize: 5 }); res.json(data); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/metrics/debug-moveouts', async (req, res) => { try { const data = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 3, pageSize: 5 }); res.json(data); } catch(e) { res.status(500).json({ error: e.message }); } });
app.get('/api/metrics/debug', async (req, res) => { res.json({ status: 'ok', metrics: !!_metricsCache }); });

setTimeout(async () => {
  try {
    console.log('Metrics: warming cache on startup...');
    const data = await buildMetricsData();
    _metricsCache = data; _metricsCacheTime = Date.now();
    console.log('Metrics: cache warmed successfully');
  } catch(e) { console.log('Metrics: cache warm failed:', e.message); }
}, 8000);
app.get('/', (req, res, next) => {
  const host = req.hostname || '';
  if (host.startsWith('chat.')) return res.redirect(302, '/chat');
  if (host.startsWith('hoa.')) return res.redirect(302, '/hoa');
  if (host.startsWith('metrics.')) return res.redirect(302, '/metrics');
  if (host.startsWith('vacancy.')) return res.redirect(302, '/vacancy');
  next();
});



// --- Video Analyzer Proxy v2 (Multi-frame + Transcription) ---
app.post('/api/analyze-media', async (req, res) => {
  try {
    const { frames, imageBase64, mediaType, address, notes, mimeType, transcript, roomLabel } = req.body;
    const mediaTypeLabel = { maintenance: 'maintenance issue documentation', inspection: 'property inspection / walkthrough', 'move-in': 'move-in condition documentation', 'move-out': 'move-out condition documentation' }[mediaType] || mediaType;
    const contextNote = notes ? '\nProperty manager notes: ' + notes : '';
    const addrNote = address ? '\nProperty: ' + address : '';
    const roomNote = roomLabel ? '\nRoom/Area: ' + roomLabel : '';
    const transcriptNote = transcript ? '\n\nAUDIO TRANSCRIPT FROM VIDEO (the inspector/PM said this while recording):\n"' + transcript + '"\n\nIMPORTANT: The transcript contains critical observations spoken by the inspector. Extract EVERY issue mentioned verbally. Cross-reference what is spoken with what is visible in the frames.' : '';
    const prompt = 'You are a senior property inspector AI for Aloe Property Management in the Phoenix metro area. You are analyzing ' + (frames ? frames.length + ' frames from a video' : 'a photo') + ' showing a ' + mediaTypeLabel + '.' + addrNote + roomNote + contextNote + transcriptNote + '\n\nINSPECTION INSTRUCTIONS:\nExamine every frame carefully. Look for ALL of the following:\n- Paint condition (scuffs, marks, peeling, discoloration, nail holes, patching needed, full repaint needed)\n- Flooring condition (carpet stains, tears, pet damage, tile cracks, vinyl damage, needs replacement vs cleaning)\n- Walls and baseboards (damage, water stains, mold, pet damage, scratches)\n- Ceiling condition (stains, cracks, texture damage, fan/light condition)\n- Fixtures and hardware (outlet covers, light switches, door handles, hinges, towel bars)\n- Window coverings (blinds condition, missing slats, broken)\n- Doors (condition, operation, damage, stops)\n- Appliances (visible condition, age, damage)\n- Plumbing fixtures (faucets, toilets, sinks, tubs, caulking)\n- HVAC (vents, filters, thermostat)\n- Cleaning level (overall cleanliness, grease, grime, cobwebs, debris)\n- Odor evidence (staining patterns suggesting pet urine, smoke damage, mold)\n- Safety issues (missing covers, exposed wiring, trip hazards, smoke detectors)\n- Cabinets and countertops (condition, hardware, damage)\n- Exterior if visible (siding, patio, landscaping, fencing)\n\nBE EXHAUSTIVE. A good inspection catches 15-30 items.\n\nRespond ONLY with a valid JSON object (no markdown, no backticks):\n{\n  "overall_condition_score": 1-10,\n  "overall_summary": "3-4 sentence overview",\n  "categories": [{"category": "Paint", "severity": "good|fair|poor|critical", "findings": "detailed description", "action_needed": "specific action", "estimated_scope": "Touch-up|Partial|Full replacement", "vendor_type": "Painter|Handyman|etc"}],\n  "transcript_issues": [{"spoken_observation": "what inspector said", "category": "category", "action_needed": "action"}],\n  "urgent_items": ["items needing immediate attention"],\n  "vendor_summary": [{"vendor_type": "e.g. Painter", "scope": "brief scope", "priority": "high|medium|low"}],\n  "turnover_estimate": "Light|Standard|Heavy|Full renovation",\n  "chargeback_items": ["items chargeable to tenant vs normal wear"],\n  "additional_notes": "any other observations"\n}\n\nInclude ALL categories. If a category looks fine, include it with severity good.';
    const contentParts = [];
    if (frames && frames.length > 0) {
      frames.forEach((frame, i) => {
        contentParts.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: frame.base64 } });
        contentParts.push({ type: 'text', text: '[Frame ' + (i + 1) + ' of ' + frames.length + ' - timestamp ' + (frame.timestamp || 'unknown') + ']' });
      });
    } else if (imageBase64) {
      contentParts.push({ type: 'image', source: { type: 'base64', media_type: mimeType || 'image/jpeg', data: imageBase64 } });
    }
    contentParts.push({ type: 'text', text: prompt });
    const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages: [{ role: 'user', content: contentParts }] }) });
    const data = await response.json();
    if (data.error) { console.error('Anthropic API error:', data.error); return res.status(500).json({ error: data.error.message || 'AI analysis failed' }); }
    const text = data.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    res.json(JSON.parse(clean));
  } catch (err) {
    console.error('analyze-media error:', err);
    res.status(500).json({ error: err.message });
  }
});


// --- Audio Transcription via OpenAI Whisper ---
app.post('/api/transcribe-audio', async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) return res.json({ transcript: null });
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    const FormData = (await import('node-fetch')).default ? null : null;
    const { Blob } = await import('buffer');
    const blob = new Blob([audioBuffer], { type: 'audio/wav' });
    const formData = new globalThis.FormData();
    formData.append('file', blob, 'audio.wav');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');
    formData.append('prompt', 'Property inspection walkthrough. Inspector is describing damage, maintenance issues, and condition of rooms including paint, carpet, flooring, blinds, plumbing, appliances, cleaning.');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: formData
    });
    const data = await response.json();
    if (data.text && data.text.trim().length > 5) {
      res.json({ transcript: data.text.trim() });
    } else {
      res.json({ transcript: null });
    }
  } catch (err) {
    console.error('transcribe-audio error:', err);
    res.json({ transcript: null });
  }
});
// --- End Audio Transcription ---

// --- End Video Analyzer v2 ---
app.get('*', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">


<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aloe PM — Internal Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#3CC3E1;--teal-dark:#4BB4D2;--teal-dim:rgba(60,195,225,0.12);--silver:#B4C3C3;--silver-dim:rgba(180,195,195,0.15);--bg:#F8FAFC;--bg2:#ffffff;--bg3:#f1f5f5;--border:rgba(180,195,195,0.3);--border2:rgba(60,195,225,0.25);--text:#1a2b2b;--text2:#4a6060;--text3:#8aa0a0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .logo-wrap{display:flex;align-items:center;gap:12px}
    .logo-text{font-size:15px;font-weight:600;color:var(--text)}
    .logo-sub{font-size:11px;color:var(--text3);margin-top:1px}
    .pill{font-size:11px;padding:3px 10px;border-radius:20px;background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2);font-weight:500}
    .hero{padding:48px 32px 32px;max-width:900px;margin:0 auto}
    .hero-title{font-size:30px;font-weight:700;color:var(--text);margin-bottom:8px}
    .hero-title span{color:var(--teal)}
    .hero-sub{font-size:14px;color:var(--text2)}
    .search-wrap{max-width:900px;margin:0 auto;padding:0 32px 32px}
    .search-box{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 16px}
    .search-box:focus-within{border-color:var(--teal)}
    .search-box input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;font-family:inherit}
    .search-box input::placeholder{color:var(--text3)}
    .section{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .section-label{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .section-label::after{content:'';flex:1;height:1px;background:var(--border)}
    .tool-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .tool-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:all 0.18s;text-decoration:none;color:inherit;display:block;position:relative;overflow:hidden}
    .tool-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;opacity:0;transition:opacity 0.18s}
    .tool-card:hover{border-color:var(--teal);transform:translateY(-2px);box-shadow:0 6px 20px rgba(60,195,225,0.1)}
    .tool-card:hover::before{opacity:1}
    .tool-card.primary::before{background:var(--teal)}
    .tool-card.purple-top::before{background:#a78bfa}
    .tool-card.silver-top::before{background:var(--silver)}
    .tool-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;font-size:18px;background:var(--teal-dim);border:1px solid var(--border2)}
    .tool-icon.silver{background:var(--silver-dim);border-color:var(--border)}
    .tool-icon.purple{background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.25)}
    .tool-icon.green{background:rgba(74,222,128,0.1);border-color:rgba(74,222,128,0.25)}
    .tool-name{font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px}
    .tool-desc{font-size:11px;color:var(--text3);line-height:1.5}
    .badge{position:absolute;top:14px;right:14px;font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px}
    .badge-live{background:rgba(74,222,128,0.12);color:#16a34a;border:1px solid rgba(74,222,128,0.25)}
    .badge-new{background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2)}
    .badge-soon{background:var(--silver-dim);color:var(--text3);border:1px solid var(--border)}
    .footer{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .footer-inner{border-top:1px solid var(--border);padding-top:20px;display:flex;align-items:center;justify-content:space-between}
    .footer-left{font-size:11px;color:var(--text3)}
    .source-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--bg3);color:var(--text3);border:1px solid var(--border);margin-left:4px}
    @media(max-width:640px){.tool-grid{grid-template-columns:1fr 1fr}.hero,.section,.search-wrap{padding-left:20px;padding-right:20px}}
  </style>
</head>
<body>
<div class="topbar">
  <div class="logo-wrap">
    <div>
      <div class="logo-text">Aloe PM Internal Hub</div>
      <div class="logo-sub">Phoenix Metro · All systems live</div>
    </div>
  </div>
  <div style="display:flex;gap:8px">
    <span class="pill">AI-Powered</span>
    <span class="pill" style="background:var(--silver-dim);color:var(--text2);border-color:var(--border)">Internal Only</span>
  </div>
</div>

<div class="hero">
  <div class="hero-title">Welcome back to <span>Aloe PM</span></div>
  <div class="hero-sub">Your internal command center for property management, AI agents, and team operations.</div>
</div>

<div class="search-wrap">
  <div class="search-box">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".4"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Search tools…" oninput="filterTools(this.value)"/>
  </div>
</div>

<div class="section">
  <div class="section-label">AI & Automation</div>
  <div class="tool-grid">
    <a href="/chat" class="tool-card primary" data-name="aloe assistant ai chat">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🤖</div>
      <div class="tool-name">Aloe Assistant</div>
      <div class="tool-desc">AI chat — Rentvine, Aptly, Knowledge Base, Slack all connected</div>
    </a>
    <a href="/sandbox" class="tool-card primary" data-name="sandbox agent training">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">✏️</div>
      <div class="tool-name">Agent Sandbox</div>
      <div class="tool-desc">Train and coach AI agents before going live</div>
    </a>
    <a href="/sms-queue" class="tool-card primary" data-name="sms queue drafts tenant messages">
      <span class="badge badge-new">NEW</span>
      <div class="tool-icon green">💬</div>
      <div class="tool-name">SMS Draft Queue</div>
      <div class="tool-desc">Review and approve AI-drafted responses before sending</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Accounting</div>
  <div class="tool-grid">
    <a href="/recon-bills" class="tool-card primary" data-name="recon bills invoices accounting reconcile">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🧾</div>
      <div class="tool-name">Recon — Bills</div>
      <div class="tool-desc">Reconcile vendor invoices against approved work orders</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Operations</div>
  <div class="tool-grid">
    <a href="https://vendor.aloepm.com" class="tool-card primary" data-name="vendor resources partner apply public">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">🔨</div>
      <div class="tool-name">Vendor Resources</div>
      <div class="tool-desc">Public vendor page — standards, requirements, vendor application</div>
    </a>
    <a href="https://resident.aloepm.com" class="tool-card primary" data-name="tenant resident resources portal help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Tenant Resources</div>
      <div class="tool-desc">Public tenant help portal — policies, maintenance, payments, move-out info</div>
    </a>
    <a href="https://owner.aloepm.com" class="tool-card primary" data-name="owner resources portal landlord help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Owner Resources</div>
      <div class="tool-desc">Public owner portal — fees, disbursements, leasing, guarantees, FAQs</div>
    </a>
    <a href="/renewals" class="tool-card primary" data-name="lease renewals persia renewal dashboard">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🔄</div>
      <div class="tool-name">Lease Renewals</div>
      <div class="tool-desc">Renewal pipeline, offers, calculator — Persia's dashboard</div>
    </a>
    <a href="/hoa" class="tool-card primary" data-name="hoa form filler registration juan">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📋</div>
      <div class="tool-name">HOA Form Filler</div>
      <div class="tool-desc">Auto-fill HOA registration PDFs with Rentvine tenant data</div>
    </a>
    <a href="/media-analyzer" class="tool-card primary" data-name="media analyzer video photo inspection transcribe">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🎥</div>
      <div class="tool-name">Property Media Analyzer</div>
      <div class="tool-desc">Upload video or photos — AI transcription, inspection report, vendor list</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Reports</div>
  <div class="tool-grid">
    <a href="/metrics" class="tool-card primary" data-name="metrics kpi dashboard portfolio occupancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📊</div>
      <div class="tool-name">KPI Metrics</div>
      <div class="tool-desc">Portfolio changes, occupancy rate, move-ins, lease activity</div>
    </a>
    <a href="/vacancy" class="tool-card primary" data-name="vacancy risk market intelligence">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Vacancy Risk</div>
      <div class="tool-desc">Risk scores, market comps, owner reports — all vacant units</div>
    </a>
    <a href="/owner-report" class="tool-card primary" data-name="owner report email generator vacancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📬</div>
      <div class="tool-name">Owner Report Generator</div>
      <div class="tool-desc">AI-drafted vacancy update email per property — one click</div>
    </a>
    <a href="/rent-analysis" class="tool-card primary" data-name="rent analysis market comps zillow">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏘️</div>
      <div class="tool-name">Rent Analysis</div>
      <div class="tool-desc">Live comps from Zillow, Redfin &amp; Realtor.com · STR/Airbnb</div>
    </a>
    <a href="/sale-analysis" class="tool-card purple-top" data-name="sale analysis comps zestimate owner equity">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon purple">🏡</div>
      <div class="tool-name">Sale Analysis</div>
      <div class="tool-desc">Zestimate + Redfin Estimate + sale comps · owner equity calculator</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Integrations</div>
  <div class="tool-grid">
    <a href="https://aloepm.rentvine.com" target="_blank" class="tool-card primary" data-name="rentvine property management tenants leases">
      <div class="tool-icon silver">🤝</div>
      <div class="tool-name">Rentvine</div>
      <div class="tool-desc">Tenant data, leases, work orders, accounting</div>
    </a>
    <a href="https://app.getaptly.com" target="_blank" class="tool-card primary" data-name="aptly crm workflow boards leads">
      <div class="tool-icon">📌</div>
      <div class="tool-name">Aptly</div>
      <div class="tool-desc">CRM, workflow boards, leads, move-ins, HOA</div>
    </a>
    <a href="https://my.quo.com/inbox/PNRRARIpQO" target="_blank" class="tool-card primary" data-name="quo openphone sms messaging calls">
      <div class="tool-icon silver">📱</div>
      <div class="tool-name">Quo / OpenPhone</div>
      <div class="tool-desc">SMS inbox, tenant messaging, call logs</div>
    </a>
    <a href="https://drive.google.com" target="_blank" class="tool-card primary" data-name="google drive files documents leases">
      <div class="tool-icon silver">📁</div>
      <div class="tool-name">Google Drive</div>
      <div class="tool-desc">Signed leases, inspection reports, owner docs</div>
    </a>
    <a href="https://slack.com" target="_blank" class="tool-card primary" data-name="slack team communications alerts">
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Slack</div>
      <div class="tool-desc">Team communications and escalation alerts</div>
    </a>
    <a href="https://zinspector.com/" target="_blank" class="tool-card primary" data-name="zinspector inspections property condition">
      <div class="tool-icon">🔎</div>
      <div class="tool-name">Zinspector</div>
      <div class="tool-desc">Property inspections and condition reports</div>
    </a>
  </div>
</div>

<div class="footer">
  <div class="footer-inner">
    <div class="footer-left">Aloe Property Management · Phoenix Metro · Internal use only</div>
    <div>
      <span class="source-pill">Rentvine</span>
      <span class="source-pill">Aptly</span>
      <span class="source-pill">Quo</span>
      <span class="source-pill">Knowledge Base</span>
      <span class="source-pill">Slack</span>
    </div>
  </div>
</div>

<script>
function filterTools(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.tool-card').forEach(function(card) {
    var name = (card.dataset.name||'') + ' ' + card.querySelector('.tool-name').textContent + ' ' + card.querySelector('.tool-desc').textContent;
    card.style.display = (!q || name.toLowerCase().includes(q)) ? 'block' : 'none';
  });
}
</script>
</body>
</html>`);
});
// Vendor application form submission
app.post('/api/vendor-apply', async (req, res) => {
  try {
    const { business, name, phone, email, trade, license, area, insurance, about, why, hourlyRate, employees, hasVehicle, hasTools, social, refs, additional } = req.body;
    const slackText = `New Vendor Application\nBusiness: ${business}\nContact: ${name} - ${phone} - ${email}\nTrade: ${trade}\nInsurance: ${insurance}`;
    let slackOk = false;
    if (process.env.SLACK_TOKEN) {
      try {
        const slackResp = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.SLACK_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'C07CY9SSF7D', text: slackText }) });
        const slackData = await slackResp.json();
        slackOk = slackData.ok;
      } catch(e) { console.error('Slack vendor error:', e.message); }
    }
    if (slackOk) return res.json({ ok: true });
    res.status(500).json({ error: 'Failed to deliver application' });
  } catch (err) {
    console.error('Vendor apply error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Plaid
app.get('*', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aloe PM — Internal Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{--teal:#3CC3E1;--teal-dark:#4BB4D2;--teal-dim:rgba(60,195,225,0.12);--silver:#B4C3C3;--silver-dim:rgba(180,195,195,0.15);--bg:#F8FAFC;--bg2:#ffffff;--bg3:#f1f5f5;--border:rgba(180,195,195,0.3);--border2:rgba(60,195,225,0.25);--text:#1a2b2b;--text2:#4a6060;--text3:#8aa0a0;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
    .topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .logo-wrap{display:flex;align-items:center;gap:12px}
    .logo-text{font-size:15px;font-weight:600;color:var(--text)}
    .logo-sub{font-size:11px;color:var(--text3);margin-top:1px}
    .pill{font-size:11px;padding:3px 10px;border-radius:20px;background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2);font-weight:500}
    .hero{padding:48px 32px 32px;max-width:900px;margin:0 auto}
    .hero-title{font-size:30px;font-weight:700;color:var(--text);margin-bottom:8px}
    .hero-title span{color:var(--teal)}
    .hero-sub{font-size:14px;color:var(--text2)}
    .search-wrap{max-width:900px;margin:0 auto;padding:0 32px 32px}
    .search-box{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 16px}
    .search-box:focus-within{border-color:var(--teal)}
    .search-box input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;font-family:inherit}
    .search-box input::placeholder{color:var(--text3)}
    .section{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .section-label{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .section-label::after{content:'';flex:1;height:1px;background:var(--border)}
    .tool-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .tool-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:all 0.18s;text-decoration:none;color:inherit;display:block;position:relative;overflow:hidden}
    .tool-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;opacity:0;transition:opacity 0.18s}
    .tool-card:hover{border-color:var(--teal);transform:translateY(-2px);box-shadow:0 6px 20px rgba(60,195,225,0.1)}
    .tool-card:hover::before{opacity:1}
    .tool-card.primary::before{background:var(--teal)}
    .tool-card.purple-top::before{background:#a78bfa}
    .tool-card.silver-top::before{background:var(--silver)}
    .tool-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;font-size:18px;background:var(--teal-dim);border:1px solid var(--border2)}
    .tool-icon.silver{background:var(--silver-dim);border-color:var(--border)}
    .tool-icon.purple{background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.25)}
    .tool-icon.green{background:rgba(74,222,128,0.1);border-color:rgba(74,222,128,0.25)}
    .tool-name{font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px}
    .tool-desc{font-size:11px;color:var(--text3);line-height:1.5}
    .badge{position:absolute;top:14px;right:14px;font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px}
    .badge-live{background:rgba(74,222,128,0.12);color:#16a34a;border:1px solid rgba(74,222,128,0.25)}
    .badge-new{background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2)}
    .badge-soon{background:var(--silver-dim);color:var(--text3);border:1px solid var(--border)}
    .footer{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .footer-inner{border-top:1px solid var(--border);padding-top:20px;display:flex;align-items:center;justify-content:space-between}
    .footer-left{font-size:11px;color:var(--text3)}
    .source-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--bg3);color:var(--text3);border:1px solid var(--border);margin-left:4px}
    @media(max-width:640px){.tool-grid{grid-template-columns:1fr 1fr}.hero,.section,.search-wrap{padding-left:20px;padding-right:20px}}
  </style>
</head>
<body>
<div class="topbar">
  <div class="logo-wrap">
    <div>
      <div class="logo-text">Aloe PM Internal Hub</div>
      <div class="logo-sub">Phoenix Metro · All systems live</div>
    </div>
  </div>
  <div style="display:flex;gap:8px">
    <span class="pill">AI-Powered</span>
    <span class="pill" style="background:var(--silver-dim);color:var(--text2);border-color:var(--border)">Internal Only</span>
  </div>
</div>

<div class="hero">
  <div class="hero-title">Welcome back to <span>Aloe PM</span></div>
  <div class="hero-sub">Your internal command center for property management, AI agents, and team operations.</div>
</div>

<div class="search-wrap">
  <div class="search-box">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity=".4"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Search tools…" oninput="filterTools(this.value)"/>
  </div>
</div>

<div class="section">
  <div class="section-label">AI & Automation</div>
  <div class="tool-grid">
    <a href="/chat" class="tool-card primary" data-name="aloe assistant ai chat">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🤖</div>
      <div class="tool-name">Aloe Assistant</div>
      <div class="tool-desc">AI chat — Rentvine, Aptly, Knowledge Base, Slack all connected</div>
    </a>
    <a href="/sandbox" class="tool-card primary" data-name="sandbox agent training">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">✏️</div>
      <div class="tool-name">Agent Sandbox</div>
      <div class="tool-desc">Train and coach AI agents before going live</div>
    </a>
    <a href="/sms-queue" class="tool-card primary" data-name="sms queue drafts tenant messages">
      <span class="badge badge-new">NEW</span>
      <div class="tool-icon green">💬</div>
      <div class="tool-name">SMS Draft Queue</div>
      <div class="tool-desc">Review and approve AI-drafted responses before sending</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Accounting</div>
  <div class="tool-grid">
    <a href="/recon-bills" class="tool-card primary" data-name="recon bills invoices accounting reconcile">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🧾</div>
      <div class="tool-name">Recon — Bills</div>
      <div class="tool-desc">Reconcile vendor invoices against approved work orders</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Operations</div>
  <div class="tool-grid">
  <a href="https://kb.aloepm.com" target="_blank" class="tool-card primary" data-name="knowledge base sops policies training">
<span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📚</div>
      <div class="tool-name">Knowledge Base</div>
      <div class="tool-desc">SOPs, policies, training, vendor list, cost benchmarks</div>
    </a>
    <a href="https://vendor.aloepm.com" class="tool-card primary" data-name="vendor resources partner apply public">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">🔨</div>
      <div class="tool-name">Vendor Resources</div>
      <div class="tool-desc">Public vendor page — standards, requirements, vendor application</div>
    </a>
    <a href="https://resident.aloepm.com" class="tool-card primary" data-name="tenant resident resources portal help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Tenant Resources</div>
      <div class="tool-desc">Public tenant help portal — policies, maintenance, payments, move-out info</div>
    </a>
    <a href="https://owner.aloepm.com" class="tool-card primary" data-name="owner resources portal landlord help">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Owner Resources</div>
      <div class="tool-desc">Public owner portal — fees, disbursements, leasing, guarantees, FAQs</div>
    </a>
    <a href="/renewals" class="tool-card primary" data-name="lease renewals persia renewal dashboard">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🔄</div>
      <div class="tool-name">Lease Renewals</div>
      <div class="tool-desc">Renewal pipeline, offers, calculator — Persia's dashboard</div>
    </a>
    <a href="/hoa" class="tool-card primary" data-name="hoa form filler registration juan">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📋</div>
      <div class="tool-name">HOA Form Filler</div>
      <div class="tool-desc">Auto-fill HOA registration PDFs with Rentvine tenant data</div>
    </a>
    <a href="/media-analyzer" class="tool-card primary" data-name="media analyzer video photo inspection transcribe">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🎥</div>
      <div class="tool-name">Property Media Analyzer</div>
      <div class="tool-desc">Upload video or photos — AI transcription, inspection report, vendor list</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Reports</div>
  <div class="tool-grid">
    <a href="/metrics" class="tool-card primary" data-name="metrics kpi dashboard portfolio occupancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📊</div>
      <div class="tool-name">KPI Metrics</div>
      <div class="tool-desc">Portfolio changes, occupancy rate, move-ins, lease activity</div>
    </a>
    <a href="/vacancy" class="tool-card primary" data-name="vacancy risk market intelligence">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏠</div>
      <div class="tool-name">Vacancy Risk</div>
      <div class="tool-desc">Risk scores, market comps, owner reports — all vacant units</div>
    </a>
    <a href="/owner-report" class="tool-card primary" data-name="owner report email generator vacancy">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📬</div>
      <div class="tool-name">Owner Report Generator</div>
      <div class="tool-desc">AI-drafted vacancy update email per property — one click</div>
    </a>
    <a href="/rent-analysis" class="tool-card primary" data-name="rent analysis market comps zillow">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon">🏘️</div>
      <div class="tool-name">Rent Analysis</div>
      <div class="tool-desc">Live comps from Zillow, Redfin &amp; Realtor.com · STR/Airbnb</div>
    </a>
    <a href="/sale-analysis" class="tool-card purple-top" data-name="sale analysis comps zestimate owner equity">
      <span class="badge badge-live">LIVE</span>
      <div class="tool-icon purple">🏡</div>
      <div class="tool-name">Sale Analysis</div>
      <div class="tool-desc">Zestimate + Redfin Estimate + sale comps · owner equity calculator</div>
    </a>
  </div>
</div>

<div class="section">
  <div class="section-label">Integrations</div>
  <div class="tool-grid">
    <a href="https://aloepm.rentvine.com" target="_blank" class="tool-card primary" data-name="rentvine property management tenants leases">
      <div class="tool-icon silver">🤝</div>
      <div class="tool-name">Rentvine</div>
      <div class="tool-desc">Tenant data, leases, work orders, accounting</div>
    </a>
    <a href="https://app.getaptly.com" target="_blank" class="tool-card primary" data-name="aptly crm workflow boards leads">
      <div class="tool-icon">📌</div>
      <div class="tool-name">Aptly</div>
      <div class="tool-desc">CRM, workflow boards, leads, move-ins, HOA</div>
    </a>
    <a href="https://my.quo.com/inbox/PNRRARIpQO" target="_blank" class="tool-card primary" data-name="quo openphone sms messaging calls">
      <div class="tool-icon silver">📱</div>
      <div class="tool-name">Quo / OpenPhone</div>
      <div class="tool-desc">SMS inbox, tenant messaging, call logs</div>
    </a>
<a href="https://kb.aloepm.com" target="_blank" class="tool-card primary" data-name="knowledge base sops policies training">
<span class="badge badge-live">LIVE</span>
      <div class="tool-icon">📚</div>
      <div class="tool-name">Knowledge Base</div>
      <div class="tool-desc">SOPs, policies, training, vendor list, cost benchmarks</div>
    </a>
    <a href="https://drive.google.com" target="_blank" class="tool-card primary" data-name="google drive files documents leases">
      <div class="tool-icon silver">📁</div>
      <div class="tool-name">Google Drive</div>
      <div class="tool-desc">Signed leases, inspection reports, owner docs</div>
    </a>
    <a href="https://slack.com" target="_blank" class="tool-card primary" data-name="slack team communications alerts">
      <div class="tool-icon silver">💼</div>
      <div class="tool-name">Slack</div>
      <div class="tool-desc">Team communications and escalation alerts</div>
    </a>
    <a href="https://zinspector.com/" target="_blank" class="tool-card primary" data-name="zinspector inspections property condition">
      <div class="tool-icon">🔎</div>
      <div class="tool-name">Zinspector</div>
      <div class="tool-desc">Property inspections and condition reports</div>
    </a>
  </div>
</div>

<div class="footer">
  <div class="footer-inner">
    <div class="footer-left">Aloe Property Management · Phoenix Metro · Internal use only</div>
    <div>
      <span class="source-pill">Rentvine</span>
      <span class="source-pill">Aptly</span>
      <span class="source-pill">Quo</span>
      <span class="source-pill">Knowledge Base</span>
      <span class="source-pill">Slack</span>
    </div>
  </div>
</div>

<script>
function filterTools(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.tool-card').forEach(function(card) {
    var name = (card.dataset.name||'') + ' ' + card.querySelector('.tool-name').textContent + ' ' + card.querySelector('.tool-desc').textContent;
    card.style.display = (!q || name.toLowerCase().includes(q)) ? 'block' : 'none';
  });
}
</script>
</body>
</html>`);
});
// Vendor application form submission
app.post('/api/vendor-apply', async (req, res) => {
  try {
    const { business, name, phone, email, trade, license, area, insurance, about, why, hourlyRate, employees, hasVehicle, hasTools, social, refs, additional } = req.body;
    const slackText = `New Vendor Application\nBusiness: ${business}\nContact: ${name} - ${phone} - ${email}\nTrade: ${trade}\nInsurance: ${insurance}`;
    let slackOk = false;
    if (process.env.SLACK_TOKEN) {
      try {
        const slackResp = await fetch('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { 'Authorization': `Bearer ${process.env.SLACK_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'C07CY9SSF7D', text: slackText }) });
        const slackData = await slackResp.json();
        slackOk = slackData.ok;
      } catch(e) { console.error('Slack vendor error:', e.message); }
    }
    if (slackOk) return res.json({ ok: true });
    res.status(500).json({ error: 'Failed to deliver application' });
  } catch (err) {
    console.error('Vendor apply error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Plaid
initPlaidRoutes(app);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Aloe Assistant running on port ' + PORT));
