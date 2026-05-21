
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';

import { initPlaidRoutes } from './plaid-integration.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
  res.sendFile(new URL('./public/vendor-resources.html', import.meta.url).pathname);
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
const KB_URL              = process.env.KB_URL || 'https://aloe-knowledge-sync.onrender.com';
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
    fetchAllPages('/properties', { isActive: true }, 5),
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

app.get('*', function(req, res) {
  res.status(404).send('Not found');
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
