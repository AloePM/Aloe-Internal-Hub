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
     res.sendFile(new URL('./vendor-resources.html', import.meta.url).pathname);
});

app.get('/api/vendors', async (req, res) => {
   try {
        let allVendors = [];
        let page = 0;
        while (page < 20) {
               const data = await rvFetch('/api/vendor', { page, pageSize: 100 });
               const batch = Array.isArray(data) ? data : (data && data.data) || [];
               if (batch.length === 0) break;
               allVendors = allVendors.concat(batch);
               if (batch.length < 100) break;
               page++;
        }
   app.get('/api/vendor-docs', async (req, res) => {
  try {
    const kbBase = process.env.KB_URL || 'https://aloe-knowledge-sync.onrender.com';
    // Try both possible endpoint formats
    let response = await fetch(`${kbBase}/api/documents`);
    if (!response.ok) response = await fetch(`${kbBase}/documents`);
    if (!response.ok) throw new Error(`KB returned ${response.status}`);
    const data = await response.json();
    // Data may be array or { documents: [] }
    const all = Array.isArray(data) ? data : (data.documents || data.docs || data.data || []);
    // Filter to vendor audience - field may be array or string
    const vendorDocs = all.filter(doc => {
      const aud = doc.audience || doc.audiences || [];
      if (Array.isArray(aud)) return aud.includes('vendor');
      if (typeof aud === 'string') return aud.includes('vendor');
      return false;
    });
    console.log(`Vendor docs: ${vendorDocs.length} of ${all.length} total`);
    res.json(vendorDocs);
  } catch (err) {
    console.error('Vendor docs proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
        const vendors = allVendors.map(v => ({
               vendorID: v.vendorID || v.id || '',
               name: v.name || v.vendorName || '',
               companyName: v.companyName || '',
               category: v.vendorType || v.category || v.tradeType || '',
               phone: v.phone || v.phoneNumber || v.primaryPhone || '',
               email: v.email || v.emailAddress || '',
               isActive: v.isActive !== false && v.status !== 'Inactive',
               workOrderCount: v.workOrderCount || v.totalWorkOrders || 0,
               openWorkOrders: v.openWorkOrders || v.openWorkOrderCount || 0,
        }));
        res.json({ vendors, total: vendors.length });
   } catch (err) {
        console.error('Vendors API error:', err);
        res.status(500).json({ error: err.message, vendors: [] });
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
    // Sanitize — strip all {_id, name, duogram} Aptly contact objects before sending to browser
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
app.get('/api/vendor-docs', async (req, res) => {
  try {
    const kbBase = process.env.KB_URL || 'https://aloe-knowledge-sync.onrender.com';
const response = await fetch(`${kbBase}/api/public/documents?audience=vendor`);
    if (!response.ok) {
      const text = await response.text();
      console.error('Vendor docs KB error:', response.status, text.slice(0, 200));
      return res.status(500).json({ error: 'KB returned error', status: response.status });
    }
    const data = await response.json();
    console.log('Vendor docs raw:', JSON.stringify(data).slice(0, 300));
    res.json(data);
  } catch (err) {
    console.error('Vendor docs proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
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

// =============================================================================
// KNOWLEDGE BASE — the sole source of truth for policies, procedures, training
// =============================================================================
// Topic-cache: shortcuts call kb_search once, cache for 30 min, reuse.
// Same speed as the old Notion cache, but powered by the KB.
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

// Fetch a topic's content from KB (with caching). Returns concatenated content
// from the top matching docs as a single string for system-prompt injection.
async function getKbTopic(cacheKey, query, opts = {}) {
  const now = Date.now();
  const cached = KB_TOPIC_CACHE[cacheKey];
  if (cached && (now - cached.loadedAt) < KB_CACHE_TTL_MS) return cached.text;
  const { results } = await kbSearch(query, { limit: opts.limit || 3, audience: opts.audience, department: opts.department });
  if (!results || results.length === 0) return '';
  // De-dup chunks by document_id, take the longest content per doc
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

// Topic detection — same regex patterns the Notion cache used, but routes to kb_search.
// Each entry: { keys: regex, query: search query for the KB }
const KB_TOPIC_ROUTES = [
  { test: /water.*leak|leak.*water|leaking|flooded|burst.*pipe|pipe.*burst|water.*damage/, key: 'water_leaks',     q: 'water leak troubleshooting shut off valve' },
  { test: /text.*leak|sms.*leak|what.*say.*leak|what.*tell.*leak/,                          key: 'water_sms',        q: 'water leak tenant SMS templates' },
  { test: /pest|scorpion|roach|termite|rodent|bee|ant.*infestat|bug.*infestat/,             key: 'pest_sop',         q: 'pest control SOP scorpions bees rodents owner tenant' },
  { test: /text.*pest|sms.*pest|what.*say.*pest|what.*tell.*pest/,                          key: 'pest_sms',         q: 'pest control tenant SMS templates' },
  { test: /toilet|toilet.*leak|toilet.*clog|toilet.*flush/,                                 key: 'toilet',           q: 'toilet troubleshooting running toilet flush' },
  { test: /washer|dryer|washing machine|laundry/,                                           key: 'washer_dryer',     q: 'washer dryer troubleshooting' },
  { test: /kitchen sink|sink.*drain|drain.*clog|slow.*drain/,                               key: 'kitchen_sink',     q: 'kitchen sink drain clog prevention' },
  { test: /garbage disposal|disposal/,                                                      key: 'disposal',         q: 'garbage disposal jams troubleshooting' },
  { test: /mold|mildew/,                                                                    key: 'mold',             q: 'mold mildew prevention moisture' },
  { test: /dishwasher/,                                                                     key: 'dishwasher',       q: 'dishwasher troubleshooting not draining cleaning' },
  { test: /\bhvac\b|\bac\b|air.?condition|heat.*not.*work|ac.*not.*work|furnace/,           key: 'hvac',             q: 'HVAC AC heat troubleshooting filter' },
  { test: /water softener|softener/,                                                        key: 'water_softener',   q: 'water softener salt operation maintenance' },
  { test: /water bill|high.*bill.*water|leak.*prevent/,                                     key: 'high_water_bill',  q: 'high water bill leak prevention conservation' },
  { test: /mailbox/,                                                                        key: 'mailbox',          q: 'mailbox issues lost key USPS' },
  { test: /lock.*out|locked.*out|lost.*key|\bkey\b|rekey/,                                  key: 'keys_lockouts',    q: 'keys lockouts tenant rekey lockbox' },
  { test: /how.*creat.*work.?order|how.*submit.*work.?order|how.*make.*work.?order/,        key: 'wo_create',        q: 'creating work order tenant request stages' },
  { test: /work.?order.*process|process.*work.?order/,                                      key: 'wo_process',       q: 'work order process SOP issue types stages' },
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

// =============================================================================
// SYSTEM PROMPT — KB-only knowledge source
// =============================================================================
const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

APTLY — Source of truth for listings and availability:
- Units board (ID: unit) — ALL published listings with beds, baths, rent, available date, Published For Rent field. THIS IS THE ONLY SOURCE for "what units are available" questions. Never use Rentvine for availability.
- Renter leads pipeline (board ID: 4EMDSYKirhQaNdQKz)
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards
- Contact and lead details
- EMERGENCY DETECTION: When showing work orders, always scan descriptions for: water leak, gas leak, no heat, no AC in summer, flood, sewage backup, burst pipe. If found, flag them as 🚨 EMERGENCY regardless of how they are staged in Aptly. The water leak at 1774 E Tara Dr is an example — it must be surfaced even if not tagged emergency.

RENTVINE — Source of truth for tenant and accounting data:
ZINSPECTOR — Inspection platform synced with Rentvine. Use zi_get_inspections tool to get latest move-in, move-out, maintenance, and periodic inspection activity for any property. Falls back to Rentvine inspection data if zInspector API is unavailable.
- Tenant info, balances, ledger, payment history, unpaid charges with full breakdown
- Lease details, move-in/out dates, lease terms, rent amounts, deposit
- Owner info, portfolio details, contact information
- Work orders and maintenance requests
- Property inspections (move-in, move-out, periodic)
- Vendors and contractors
- NOTE: Do NOT use Rentvine for availability/listings — use Aptly Units board instead

ALOE KNOWLEDGE BASE — The single source of truth for ALL company policies, procedures, training materials, vendor information, cost benchmarks, troubleshooting guides, and SOPs:
- Use the kb_search tool for any policy, procedure, training, or operational question
- Filter by audience (tenant, owner, staff) when the question's audience is clear
- Filter by department (maintenance, leasing, resident_relations, owner_relations, hoa, accounting) when relevant
- The KB contains: lease break policy, fee schedules, screening criteria, late fee policy, notice to vacate, move-in/out procedures, maintenance SOPs (HVAC, plumbing, pest, roofing, appliances, etc.), vendor lists with phone numbers and coverage areas, Phoenix cost benchmarks, owner-facing materials (management fees, guarantees, rent-ready standards), and all training content
- For ANY policy, procedure, or training question — use kb_search FIRST, not your training data

Known Aptly board IDs:
- "unit" — Units/Listings board. Has Stage (Vacant/Occupied), beds, baths, sq ft, rent, deposit, available date, Published For Rent field. For availability questions use "qfBzBxfooJtfTQncd" instead (it has Mirror Published For Rent field and is the master listing board). IMPORTANT: The "Created At" field on each unit = the date the property was onboarded into the portfolio — use this to answer questions about recently onboarded properties.
- "qfBzBxfooJtfTQncd" — List Property / On Market board. Shows properties actively listed, showing start date, notes on occupancy, market status.
- "location" — Properties/Locations board. Has owner, address, property details for every property.
- "4EMDSYKirhQaNdQKz" — Renter Leads. Use aptly_get_leads for ANY question about leads, showings, tours, prospects, lead sources, conversion. Fields include: Primary Contact, Preferred Rental, Stage, Source, Requested Showing Information (contains date/time), Requested Showing Status, Tour Date/Time, Move Date, Household Income, Beds, Pets, Last Action, email counts, comments. Stages: Nurturing, Scheduled Tour, Tour Completed, Tour Canceled / No Show, Applied.
- "MJxaStgENouWrNEKd" — Applicants (Applications board). Use this for ANY question about applications. Has Application Location (property address), Primary Applicant, Stage, income, credit, household info. NEVER use Renter Leads for applications.
- For ANY question about a specific applicant, their comments, notes, status, income, credit, or history: use aptly_get_applicant tool with their name or address.
- "workOrder" — Work Orders board (Aptly). USE aptly_get_work_orders AS THE PRIMARY SOURCE for ALL work order questions. FORMAT: When listing work orders always use this exact format per line: "[address] — WO #[num] | [issue] | [status] | [daysOpen] days | [vendor]"
- "YA3QWmPebvMwLwbB3" — Move-Outs.
- "K9mMGGjKgQPqDykaa" — Move-Ins.
- "86YrLPbwdkxtdyZoj" — Tenant Renewals.

Property availability workflow (follow this order):
1. Check Aptly Applications board for approved applications on the property
2. If approved: check whether the earnest deposit has been paid — deposit paid = property is OFF the market
3. Check Rentvine → Future Leases for the property — confirm move-in is scheduled and deposit receipt exists
4. Check lease status: if Pending = future lease = off market
5. Only if none of the above apply = property is available

SLACK — Team communications:
- Recent team messages, announcements, decisions
- Search across all channels for specific topics

Rules:
- CRITICAL RATE LIMIT RULE: Never call more than 2 tools in the same loop. For property lookups: call rv_get_properties first, then rv_get_units with the propertyId — do NOT also call rv_get_inspections, rv_get_leases, or rv_get_work_orders in the same turn unless specifically asked. Calling 3+ tools at once causes rate limit errors.
- rv_get_inspections: ONLY call when user specifically asks about inspections. Never call it automatically during general property lookups.
- Always use tools to get live data — never guess or make up numbers
- For tenant balances always show the full breakdown (what charges, amounts, dates)
- Be concise. Lead with the answer, then details
- Use numbered steps for procedures
- Always cite your source (Rentvine, Aptly, Knowledge Base, or Slack)
- Never speculate on legal or fair housing matters
- ALWAYS include comments when showing card details from any Aptly board. Comments are in the comments array (standard boards) or formatted_comments field. Show them as: "Notes: [date] [person]: [comment]". If no comments, don't mention it.
- Ask clarifying questions when the request is genuinely ambiguous — for example, if someone asks about "the property" without specifying which one, or asks a vague question like "what's going on?" — respond conversationally like "Sure! Are you looking for maintenance issues, lease activity, or something else?" Keep clarifying questions short and give 2-3 specific options when possible.
- After answering a question, offer ONE relevant follow-up suggestion based on what was just shown. Keep it brief — e.g., "Would you also like to see which of these are past their scheduled date?" or "Want me to check if any of these have no comments yet?" Only suggest something genuinely useful in context, not generic offers.
- If a question is unclear or uses vague terms, ask for clarification before running tools — don't guess wrong and waste a data fetch.
- NEVER explain how a tool works or describe what it does. Always run the tool and report the actual results.
- NEVER say "you can use X tool" or "the results will show" — just use the tool and show the results directly.
- For ANY question about a specific property address: ALWAYS check Aptly Units board and Aptly List Property board FIRST using aptly_get_board_cards or aptly_search_cards to get the actual listing data. Only THEN supplement with kb_search for policy details. Never answer property-specific questions from the KB alone.
- For pet policy questions about a specific address: check the actual Aptly listing for that property first — look at the unit card fields for pet restrictions, HOA restrictions, or owner notes. Then state the standard policy from KB. Never assume the standard policy applies without checking the listing.
- For ANY policy, procedure, training, or operational question: use kb_search. The KB is the single source of truth.
- CRITICAL FEE FACTS — never get these wrong: Earnest deposit = $1,500 (NOT $500). Application fee = $65 per adult. Cleaning fee = $500 (move-out, non-refundable). Admin fee = $250. Pet fee = $250 per pet. Security deposit = 1x monthly rent. The $500 is the CLEANING FEE, not the earnest deposit.
- For pre-loaded topic content: when the user's question matches a topic with pre-loaded KB content (water leaks, pest control, HVAC, work orders, vendors, cost benchmarks, etc.), the relevant KB content is INJECTED into your context above as "RELEVANT KB CONTENT". Use that directly — do NOT call kb_search again for the same topic.
- For pet policy questions about a specific address: use aptly_search_cards with boardId "unit" and the address as the query. Look at the listing card for pet restrictions, HOA notes, or owner-specific rules. If the card shows no restrictions, then state the standard policy (pets allowed, $250/pet fee, max 4 pets, no breed restrictions unless owner requests). Do NOT answer from KB alone for specific property pet questions.
- For pest control: scorpion rule = 5+ inside in 30 days = owner responsibility. Bees/rodents/termites/birds = always owner. Under 30 days moved in = one-time goodwill service.
- For water leaks: ask where the leak is (appliance/sink/toilet/roof/exterior) and give shutoff instructions from KB content.
- For unknown policy topics: use kb_search. If kb_search returns no results, only THEN route to a team member.
- NEVER offer to "connect" the user with someone or ask what type of answer they want — just search the KB and answer.
- Only route to a team member when you genuinely cannot answer the question from the data. If the question has been fully answered, do NOT add a 'reach out to X' closer — just stop after the answer.
- When answering a question about a TENANT (what they owe, what they need to do, what their options are): only include information relevant to the tenant. Do NOT include owner fee splits, what the owner receives, re-leasing fees charged to owners, or any owner-facing financial details.
- When answering a question about an OWNER: only include owner-relevant information. Do not include tenant-facing language.
- Use the context of the question to determine audience and pass it to kb_search via the audience filter.
- If you cannot find something in the data after multiple searches, say so clearly and direct to the right person based on the topic:
  - Leasing questions (applications, showings, availability, move-ins) → "Reach out to Dhyana directly."
  - Maintenance issues (repairs, vendors, work orders) → "Reach out to Roberto directly."
  - HOA violations or HOA questions → "Reach out to Juan directly."
  - Move-out or lease renewal questions → "Reach out to Persia directly."
  - Any property in Maricopa if no one else can help → "Reach out to Teri directly."
  - Owner or landlord related issues → "Reach out to Alexes directly."
  - Accounting questions → "Reach out to Randi directly."
- NEVER say "check with Randi or Persia" as a blanket response — always route to the specific right person above.
- If an address is not found, say "I couldn't find [X] in Rentvine — the address may be formatted differently. For leasing questions reach out to Dhyana, or try searching with the full street name spelled out."
- NEVER say "I'm unable to access" or "I cannot access" any board or data source — you have Rentvine, Aptly, Knowledge Base, and Slack tools available. Always actually try them before concluding data isn't available.
- NEVER route to a team member as a substitute for using your tools. Always use all relevant tools first, then only route if the tools genuinely return no data.
- NEVER invent reasons or possibilities for why something is not found. Only report what the data actually shows.
- For ANY question about tours, showings, scheduling, or why a property isn't available, or what work is being done: check Rentvine for (1) active lease status, (2) latest inspections via rv_get_inspections — these are synced from zInspector and show the most recent move-in, move-out, or maintenance inspection with date and type. Then search Aptly for pipeline status. Report all three together.
- When reporting inspection activity: state the inspection type (move-in, move-out, maintenance, periodic), the date it was completed, and any notes.
- When reporting on a property: state the facts directly. Example: "17373 North Costa Brava is currently occupied — the lease runs through [date]. In Aptly it shows [status] with [showing info]." Do NOT suggest steps, do NOT give instructions.
- NEVER say things like "next steps would be" or "you should" or "I recommend" — only report what the data actually says.
- Tone: professional, helpful, like the most knowledgeable senior colleague on the team`;

const ALL_TOOLS = [
  {
    name: 'rv_get_leases',
    description: 'Search leases from Rentvine with tenant info, balances, unpaid charges, and property details. Best tool for tenant lookups and balance checks.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Tenant name, email, or property address to search' },
        status: { type: 'string', description: 'active, inactive, or all (default: active)' },
        page: { type: 'number', description: 'Page number (default: 1)' },
      },
    },
  },
  {
    name: 'rv_get_ledger',
    description: 'Get the full accounting ledger for a lease — all charges, payments, credits with dates.',
    input_schema: {
      type: 'object',
      properties: { leaseId: { type: 'number', description: 'Rentvine lease ID' } },
      required: ['leaseId'],
    },
  },
  {
    name: 'rv_get_transactions',
    description: 'Get full transaction history for a lease — all payments, fees, credits with dates.',
    input_schema: {
      type: 'object',
      properties: { leaseId: { type: 'number', description: 'Rentvine lease ID' } },
      required: ['leaseId'],
    },
  },
  {
    name: 'rv_get_properties',
    description: 'Get properties in the portfolio. Search by address, name, or city.',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Address, property name, or city' } },
    },
  },
  {
    name: 'rv_get_units',
    description: 'Get units with rent, deposit, beds, baths, availability.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Address or unit name (optional)' },
        propertyId: { type: 'number', description: 'Filter by property ID (optional)' },
      },
    },
  },
  {
    name: 'rv_get_owners',
    description: 'Get owner/landlord contact info, portfolio, and associated properties',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Owner name or email (optional)' } },
    },
  },
  {
    name: 'rv_get_work_orders',
    description: 'Get maintenance work orders. Filter by open/closed/all and optionally by property.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open, closed, or all (default: open)' },
        propertyId: { type: 'number', description: 'Filter by property ID (optional)' },
        page: { type: 'number', description: 'Page number (default: 1)' },
      },
    },
  },
  {
    name: 'rv_get_property_work_order_history',
    description: 'Get ALL work orders (open AND closed) for a specific property by address or property ID.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Property address to search for' },
        propertyId: { type: 'number', description: 'Rentvine property ID (use if known)' },
      },
    },
  },
  {
    name: 'rv_get_work_order_detail',
    description: 'Get full details for a specific work order by ID',
    input_schema: {
      type: 'object',
      properties: { workOrderId: { type: 'number', description: 'Work order ID' } },
      required: ['workOrderId'],
    },
  },
  {
    name: 'rv_get_recurring_issues',
    description: 'Find properties with recurring work orders of the same category within a time period.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Issue category: HVAC, Plumbing, Electrical, Appliance, Roofing, Landscaping, Pest Control, Pool, or blank for all' },
        daysBack: { type: 'number', description: 'Days to look back. Default 365.' },
        minCount: { type: 'number', description: 'Minimum same-category WOs. Default 2.' },
      },
    },
  },
  {
    name: 'rv_get_inspections',
    description: 'Get property inspections from Rentvine. Only call when user specifically asks about inspections.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'number', description: 'Filter by property ID (optional)' },
        page: { type: 'number', description: 'Page number (default: 1)' },
      },
    },
  },
  {
    name: 'rv_get_inspection_detail',
    description: 'Get full details of a specific inspection by ID',
    input_schema: {
      type: 'object',
      properties: { inspectionId: { type: 'number', description: 'Inspection ID' } },
      required: ['inspectionId'],
    },
  },
  {
    name: 'rv_get_tenants',
    description: 'Search for tenant contacts in Rentvine by name or email',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Tenant name or email' } },
    },
  },
  {
    name: 'rv_get_vendors',
    description: 'Get vendor/contractor list from Rentvine',
    input_schema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Vendor name (optional)' } },
    },
  },
  {
    name: 'aptly_get_board_cards',
    description: 'Get cards from an Aptly board. Renter Leads board ID: 4EMDSYKirhQaNdQKz.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Aptly board ID' },
        page: { type: 'number', description: 'Page number 0-indexed (default: 0)' },
      },
      required: ['boardId'],
    },
  },
  {
    name: 'aptly_list_boards',
    description: 'List all available Aptly boards to find board IDs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'aptly_search_cards',
    description: 'Search for specific leads or cards in an Aptly board by name, address, or keyword',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string', description: 'Board ID to search within' },
        query: { type: 'string', description: 'Search term — name, address, or keyword' },
      },
      required: ['boardId', 'query'],
    },
  },
  {
    name: 'aptly_get_applicant',
    description: 'Get full details and comments for a specific applicant by name or address.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Applicant name or property address' } },
      required: ['query'],
    },
  },
  {
    name: 'aptly_get_leads',
    description: 'Get renter leads from the Renter Leads board. Use for ANY question about leads, showings, prospects, tours.',
    input_schema: {
      type: 'object',
      properties: {
        daysBack: { type: 'number', description: 'Filter to leads created in last N days.' },
        property: { type: 'string', description: 'Filter by property address' },
        stage: { type: 'string', description: 'Filter by stage' },
        includeArchived: { type: 'boolean', description: 'Include archived leads. Default false.' },
      },
    },
  },
  {
    name: 'aptly_get_work_orders',
    description: 'PRIMARY source for ALL work order questions. Returns open work orders from Aptly with comments when requested.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status/stage' },
        property: { type: 'string', description: 'Filter by property address or name.' },
        includeArchived: { type: 'boolean', description: 'Include archived/closed work orders. Default false.' },
        includeComments: { type: 'boolean', description: 'Fetch comments for each WO. Default false.' },
      },
    },
  },
  {
    name: 'rv_get_work_order_notes',
    description: 'Get notes/comments for work orders from Rentvine.',
    input_schema: {
      type: 'object',
      properties: { workOrderId: { type: 'string', description: 'Specific work order ID (optional)' } },
    },
  },
  {
    name: 'compare_work_orders',
    description: 'Compare work orders between Aptly and Rentvine to find mismatches.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'kb_search',
    description: 'Search the Aloe Knowledge Base — the SINGLE source of truth for all company policies, procedures, training, vendor info, cost benchmarks, troubleshooting guides, and SOPs. ALWAYS use this tool for ANY policy, procedure, training, or operational question. Returns the top matching documents with their content.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — natural language question or topic' },
        audience: { type: 'string', description: 'Filter by audience: tenant, owner, staff' },
        department: { type: 'string', description: 'Filter by department: leasing, maintenance, resident_relations, owner_relations, hoa, accounting, general' },
      },
      required: ['query'],
    },
  },
  {
    name: 'slack_search',
    description: 'Search Slack for team messages, announcements, and decisions across all channels',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for in Slack' } },
      required: ['query'],
    },
  },
  {
    name: 'slack_get_channel_messages',
    description: 'Get recent messages from a specific Slack channel',
    input_schema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack channel ID' },
        limit: { type: 'number', description: 'Number of messages to fetch (default: 20)' },
      },
      required: ['channelId'],
    },
  },
  {
    name: 'slack_list_channels',
    description: 'List all Slack channels to find channel IDs',
    input_schema: { type: 'object', properties: {} },
  },
];

// ── Fuzzy address normalizer ──────────────────────────────────────────────────
function normalizeAddr(str) {
  return (str || '').toLowerCase()
    .replace(/\bnorth\b/g, 'n').replace(/\bn\.\b/g, 'n')
    .replace(/\bsouth\b/g, 's').replace(/\bs\.\b/g, 's')
    .replace(/\beast\b/g, 'e').replace(/\be\.\b/g, 'e')
    .replace(/\bwest\b/g, 'w').replace(/\bw\.\b/g, 'w')
    .replace(/\bstreet\b/g, 'st').replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln').replace(/\bcourt\b/g, 'ct')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd').replace(/\bplace\b/g, 'pl')
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

// ── API helpers ───────────────────────────────────────────────────────────────
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
    const batch = Array.isArray(data) ? data :
      (data && data.cards) ? data.cards :
      (data && data.data) ? data.data :
      (data && data.results) ? data.results :
      (data && data.items) ? data.items : [];
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
    const batch = Array.isArray(data) ? data :
      (data && data.data) ? data.data :
      (data && data.cards) ? data.cards : [];
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
      if (schema[k] && !mapped[schema[k]]) {
        mapped[schema[k]] = extractName(card[k]);
      }
    });
    return mapped;
  });
}

async function ziFetch(path, params = {}) {
  if (!ZINSPECTOR_API_KEY) return { error: 'ZINSPECTOR_API_KEY not set' };
  const bases = [
    'https://app.zinspector.com/api/v1',
    'https://api.zinspector.com/v1',
    'https://sandbox.zinspector.com/api/v1',
  ];
  for (const base of bases) {
    try {
      const url = new URL(base + path);
      Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString(), {
        headers: {
          'Authorization': 'Bearer ' + ZINSPECTOR_API_KEY,
          'x-api-key': ZINSPECTOR_API_KEY,
          'Accept': 'application/json',
        }
      });
      if (r.ok) return { base, data: await r.json() };
      if (r.status !== 404 && r.status !== 403) return { base, status: r.status, error: await r.text() };
    } catch(e) {}
  }
  return { error: 'zInspector API unreachable from all base URLs' };
}

async function slackFetch(path, params) {
  params = params || {};
  const url = new URL('https://slack.com/api' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + SLACK_TOKEN },
  });
  return r.json();
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  console.log('Tool: ' + name, JSON.stringify(input).slice(0, 80));
  try {
    switch (name) {

      case 'kb_search': {
        const { results, error } = await kbSearch(input.query, {
          limit: 5,
          audience: input.audience,
          department: input.department,
        });
        if (error) return JSON.stringify({ error, message: 'Knowledge base unreachable' });
        if (!results || results.length === 0) {
          return JSON.stringify({ message: 'No matching documents in the knowledge base for: ' + input.query });
        }
        const slim = results.map(function(r) {
          return {
            title: r.document_title,
            audience: r.audience,
            department: r.department,
            content: (r.content || '').slice(0, 1500),
          };
        });
        return JSON.stringify({ total: results.length, results: slim });
      }

      case 'rv_get_leases': {
        if (!input.tenantName && !input.address && !input.leaseId && !input.unit && input.status !== 'all') {
          return JSON.stringify({ error: 'A search term (address, tenantName, or leaseId) is required.' });
        }
        const params = { pageSize: 200, page: input.page || 1 };
        if (input.status === 'inactive') params['primaryLeaseStatusIDs[]'] = 2;
        else if (input.status !== 'all') params['primaryLeaseStatusIDs[]'] = 1;
        const data = await rvFetch('/leases/export', params);
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(item) {
            const tenantMatch = item.lease && item.lease.tenants && item.lease.tenants.some(function(t) {
              return (t.name || '').toLowerCase().includes(q) || (t.email || '').toLowerCase().includes(q);
            });
            if (tenantMatch) return true;
            const propAddr = (item.property && item.property.address) || '';
            const unitAddr = (item.unit && item.unit.address) || '';
            return fuzzyMatch(q, propAddr + ' ' + (item.property && item.property.city || '')) ||
                   fuzzyMatch(q, unitAddr);
          }));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_ledger': {
        return JSON.stringify(await rvFetch('/accounting/ledgers', { leaseID: input.leaseId, pageSize: 50 }));
      }

      case 'rv_get_transactions': {
        return JSON.stringify(await rvFetch('/accounting/transactions', { leaseID: input.leaseId, pageSize: 50 }));
      }

      case 'rv_get_properties': {
        let allData = [];
        let pg = 1;
        while (true) {
          const batch = await rvFetch('/properties/export', { pageSize: 200, page: pg });
          if (!Array.isArray(batch) || batch.length === 0) break;
          allData = allData.concat(batch);
          if (batch.length < 200) break;
          pg++;
        }
        if (input.search) {
          const matches = allData.filter(function(item) {
            const p = item.property || {};
            const full = (p.address || '') + ' ' + (p.city || '') + ' ' + (p.name || '');
            return fuzzyMatch(input.search, full);
          });
          return JSON.stringify(matches.slice(0, 10).map(function(item) {
            const p = item.property || {};
            return {
              propertyID: p.propertyID,
              address: p.address,
              city: p.city,
              state: p.state,
              zip: p.zip,
              status: p.status,
              ownerName: item.owner && item.owner.name,
              portfolioName: p.portfolioName,
            };
          }));
        }
        return JSON.stringify({
          total: allData.length,
          message: 'Pass a search term to find specific properties.',
          sample: allData.slice(0, 5).map(function(item) {
            const p = item.property || {};
            return { id: p.propertyID, address: p.address, city: p.city };
          })
        });
      }

      case 'rv_get_units': {
        if (!input.propertyId && !input.search) {
          return JSON.stringify({ error: 'propertyId or search required' });
        }
        if (input.propertyId) {
          const units = await rvFetch('/properties/' + input.propertyId + '/units');
          const leases = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 1, pageSize: 200 });
          const occupiedIds = new Set(
            Array.isArray(leases) ? leases.map(function(l) { return l.lease && l.lease.unitID; }).filter(Boolean) : []
          );
          if (Array.isArray(units)) {
            return JSON.stringify(units.map(function(u) {
              return Object.assign({}, u, { isAvailable: !occupiedIds.has(u.unitID) });
            }));
          }
          return JSON.stringify(units);
        }
        const leases = await rvFetch('/leases/export', { pageSize: 200 });
        if (Array.isArray(leases)) {
          return JSON.stringify(leases.filter(function(item) {
            const full = (item.unit && item.unit.address || '') + ' ' + (item.property && item.property.city || '');
            return fuzzyMatch(input.search, full);
          }));
        }
        return JSON.stringify(leases);
      }

      case 'rv_get_owners': {
        const data = await rvFetch('/contacts/owners', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(o) {
            return (o.name || '').toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q);
          }));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_work_orders': {
  const p = { pageSize: 100 };
  if (input.propertyId) p.propertyID = input.propertyId;

  // Paginate all pages instead of just page 1
  let allWOs = [];
  for (let pg = 1; pg <= 10; pg++) {
    p.page = pg;
    const data = await rvFetch('/maintenance/work-orders', p);
    const rawBatch = Array.isArray(data) ? data : (data && data.data) || [];
    if (rawBatch.length === 0) break;
    const mapped = rawBatch.map(function(rec) {
      if (rec.workOrder) {
        return Object.assign({}, rec.workOrder, {
          unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
          vendorName: (rec.contact && rec.contact.name) || '',
        });
      }
      return rec;
    }).filter(function(wo) { return wo.workOrderID; });
    allWOs = allWOs.concat(mapped);
    if (rawBatch.length < 100) break;
  }

  let filtered = allWOs;
  if (input.status === 'closed') {
    filtered = allWOs.filter(function(wo) {
      const sid = parseInt(wo.primaryWorkOrderStatusID);
      return sid === 4 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
    });
  } else {
    // Open = not closed, not cancelled, no closedDate
    filtered = allWOs.filter(function(wo) {
      const sid = parseInt(wo.primaryWorkOrderStatusID);
      const isClosed = sid === 4 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
      return !isClosed;
    });
  }
        const unassigned = filtered.filter(function(wo) { return !wo.vendorContactID; });
        const now2 = Date.now();
        const slim2 = filtered.map(function(wo) {
          const created = wo.dateTimeCreated ? new Date(wo.dateTimeCreated).getTime() : null;
          return {
            num: wo.workOrderNumber,
            title: (wo.description || '?').slice(0, 60),
            status: wo.primaryWorkOrderStatusID,
            prop: (wo.unitAddress || '').slice(0, 40),
            vendor: (wo.vendorName || '').slice(0, 30),
            scheduled: (wo.scheduledStartDate || '').slice(0, 10),
            created: (wo.dateTimeCreated || '').slice(0, 10),
            days: created ? Math.floor((now2 - created) / 86400000) : null,
            assigned: !!wo.vendorContactID,
          };
        });
        return JSON.stringify({ total: filtered.length, unassigned: unassigned.length, workOrders: slim2 });
      }

      case 'rv_get_property_work_order_history': {
        let propId = input.propertyId;
        if (!propId && input.address) {
          const props = await rvFetch('/properties/export', { pageSize: 200, page: 1 });
          const propList = Array.isArray(props) ? props : (props && props.data) || [];
          const q = input.address.toLowerCase().replace(/\s+/g, ' ').trim();
          const match = propList.find(function(p) {
            const addr = ((p.property && p.property.address) || '').toLowerCase();
            return addr.includes(q.split(' ').slice(0, 3).join(' '));
          });
          if (match) propId = match.property && match.property.propertyID;
        }
        if (!propId) return JSON.stringify({ error: 'Property not found for: ' + input.address });
        const allPages = [];
        for (let pg = 1; pg <= 5; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg, propertyID: propId });
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          allPages.push(...batch);
          if (batch.length < 100) break;
        }
        const wos = allPages.map(function(rec) {
          const wo = rec.workOrder || rec;
          const statusMap = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '4': 'Completed', '5': 'Cancelled' };
          return {
            num: wo.workOrderNumber,
            description: (wo.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
            status: statusMap[String(wo.primaryWorkOrderStatusID)] || wo.primaryWorkOrderStatusID,
            vendor: (rec.contact && rec.contact.name) || 'Unassigned',
            created: (wo.dateTimeCreated || '').slice(0, 10),
            closed: (wo.dateClosed || '').slice(0, 10),
          };
        }).sort(function(a, b) { return (b.created || '').localeCompare(a.created || ''); });
        const open = wos.filter(function(w) { return w.status !== 'Completed' && w.status !== 'Cancelled'; });
        const closed = wos.filter(function(w) { return w.status === 'Completed' || w.status === 'Cancelled'; });
        return JSON.stringify({ propertyId: propId, address: input.address, total: wos.length, open: open.length, closed: closed.length, workOrders: wos });
      }

      case 'rv_get_recurring_issues': {
        const daysBack = input.daysBack || 365;
        const minCount = input.minCount || 2;
        const targetCat = (input.category || '').toLowerCase();
        const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
        const categorizeRV = function(desc) {
          const d = (desc || '').toLowerCase();
          if (/ac|hvac|heat|cool|air.?condition|furnace|duct|compressor/i.test(d)) return 'HVAC';
          if (/roof|shingle|tile.*roof|roof.*leak/i.test(d)) return 'Roofing';
          if (/plumb|toilet|drain|faucet|water.*heat|pipe|sewage|clog|leak/i.test(d)) return 'Plumbing';
          if (/electric|outlet|light|breaker|switch|wir/i.test(d)) return 'Electrical';
          if (/appliance|dishwasher|washer|dryer|refrig|microwave|oven|stove|ice.?mak/i.test(d)) return 'Appliance';
          if (/pest|bug|termite|rodent|insect/i.test(d)) return 'Pest Control';
          if (/landscap|lawn|yard|tree|palm|sprinkler|irrigation/i.test(d)) return 'Landscaping';
          if (/pool|spa/i.test(d)) return 'Pool';
          return 'General';
        };
        let allWOs = [];
        for (let pg = 1; pg <= 10; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
        }
        const byAddrCat = {};
        allWOs.forEach(function(rec) {
          const wo = rec.workOrder || rec;
          const addr = (rec.unit && (rec.unit.address || rec.unit.name)) || '';
          if (!addr) return;
          const created = wo.dateTimeCreated ? new Date(wo.dateTimeCreated).getTime() : 0;
          if (created < cutoffMs) return;
          const desc = (wo.description || '').replace(/<[^>]+>/g, ' ');
          const cat = categorizeRV(desc);
          if (targetCat && !cat.toLowerCase().includes(targetCat) && !targetCat.includes(cat.toLowerCase())) return;
          const key = addr + '||' + cat;
          if (!byAddrCat[key]) byAddrCat[key] = { addr, cat, wos: [] };
          const statusMap = { '1': 'New', '2': 'In Progress', '3': 'On Hold', '4': 'Completed', '5': 'Cancelled' };
          byAddrCat[key].wos.push({
            num: wo.workOrderNumber,
            desc: desc.replace(/\s+/g, ' ').trim().slice(0, 60),
            status: statusMap[String(wo.primaryWorkOrderStatusID)] || 'Unknown',
            date: (wo.dateTimeCreated || '').slice(0, 10),
            vendor: (rec.contact && rec.contact.name) || 'Unassigned',
          });
        });
        const flagged = Object.values(byAddrCat)
          .filter(function(e) { return e.wos.length >= minCount; })
          .sort(function(a, b) { return b.wos.length - a.wos.length; });
        if (flagged.length === 0) {
          return JSON.stringify({ message: 'No properties found with ' + minCount + '+ ' + (targetCat || '') + ' work orders in the last ' + daysBack + ' days.' });
        }
        return JSON.stringify({ total: flagged.length, daysBack, category: targetCat || 'all', results: flagged });
      }

      case 'rv_get_work_order_detail': {
        const detail = await rvFetch('/maintenance/work-orders/' + input.workOrderId);
        const statuses = await rvFetch('/maintenance/work-order-statuses', { workOrderID: input.workOrderId, pageSize: 50, page: 1 });
        return JSON.stringify({ detail, statuses });
      }

      case 'rv_get_work_order_notes': {
        if (input.workOrderId) {
          const data = await rvFetch('/maintenance/work-orders/' + input.workOrderId + '/statuses');
          return JSON.stringify(data);
        }
        const woData = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: 1 });
        const rawWOs = Array.isArray(woData) ? woData : (woData && woData.data) || [];
        const openWOs = rawWOs.map(function(rec) {
          return rec.workOrder ? Object.assign({}, rec.workOrder, { vendorName: (rec.contact && rec.contact.name) || '' }) : rec;
        }).filter(function(wo) {
          const sid = parseInt(wo.primaryWorkOrderStatusID);
          return wo.workOrderID && sid !== 4 && sid !== 5;
        });
        const notesResults = await Promise.all(openWOs.slice(0, 30).map(async function(wo) {
          try {
            const notes = await rvFetch('/maintenance/work-orders/' + wo.workOrderID + '/statuses');
            return { workOrderID: wo.workOrderID, workOrderNumber: wo.workOrderNumber, description: wo.description, notes: Array.isArray(notes) ? notes : [] };
          } catch(e) { return { workOrderID: wo.workOrderID, workOrderNumber: wo.workOrderNumber, description: wo.description, notes: [] }; }
        }));
        const withNotes = notesResults.filter(function(r) { return r.notes.length > 0; });
        const noNotes = notesResults.filter(function(r) { return r.notes.length === 0; });
        return JSON.stringify({ total: notesResults.length, withNotes: withNotes.length, noNotes: noNotes.length, workOrdersWithNoNotes: noNotes, workOrdersWithNotes: withNotes });
      }

      case 'rv_get_inspections': {
        const params = { pageSize: 20, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        const inspData = await rvFetch('/maintenance/inspections', params);
        const inspList = Array.isArray(inspData) ? inspData : (inspData && inspData.data) || [];
        return JSON.stringify(inspList.map(function(i) {
          return {
            inspectionID: i.inspectionID,
            type: i.inspectionType && i.inspectionType.name,
            status: i.inspectionStatus && i.inspectionStatus.name,
            scheduledDate: i.scheduledDate,
            completedDate: i.completedDate,
            propertyID: i.propertyID,
            address: i.property && i.property.address,
            inspector: i.inspector && i.inspector.name,
            score: i.score,
          };
        }));
      }

      case 'rv_get_inspection_detail': {
        return JSON.stringify(await rvFetch('/maintenance/inspections/' + input.inspectionId));
      }

      case 'rv_get_tenants': {
        const data = await rvFetch('/contacts/tenants', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(t) {
            return (t.name || '').toLowerCase().includes(q) || (t.email || '').toLowerCase().includes(q);
          }));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_vendors': {
        const data = await rvFetch('/contacts/vendors', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(function(v) {
            return (v.name || '').toLowerCase().includes(q);
          }));
        }
        return JSON.stringify(data);
      }

      case 'aptly_get_board_cards': {
        const boardId = input.boardId;
        const coreApiBoards = ['4EMDSYKirhQaNdQKz', 'MJxaStgENouWrNEKd', 'K9mMGGjKgQPqDykaa', 'YA3QWmPebvMwLwbB3', '86YrLPbwdkxtdyZoj'];
        if (coreApiBoards.indexOf(boardId) !== -1) {
          const schemaData = await unitsFetch('/api/schema/' + boardId);
          const schemaMap = {};
          if (Array.isArray(schemaData)) schemaData.forEach(function(f) { schemaMap[f.key] = f.label; });
          let allCards = [];
          let pg = 0;
          while (true) {
            const params = { page: pg, pageSize: 50 };
            if (input.updatedAtMin) params.updatedAtMin = input.updatedAtMin;
            const data = await unitsFetch('/api/board/' + boardId, params);
            const batch = Array.isArray(data) ? data : (data && data.data) || [];
            allCards = allCards.concat(batch);
            if (batch.length < 50) break;
            pg++;
            if (pg > 10) break;
          }
          const withComments = allCards.map(function(card) {
            const m = { _cardId: card.cardId, stage: card.stage, createdAt: card.createdAt };
            Object.keys(card).forEach(function(k) { m[schemaMap[k] || k] = card[k]; });
            m.formatted_comments = Array.isArray(card.comments) && card.comments.length > 0
              ? card.comments.map(function(cm) { return (cm.userName || 'Unknown') + ' (' + (cm.createdAt || '').slice(0, 10) + '): ' + (cm.content || ''); })
              : [];
            return m;
          });
          return JSON.stringify({ cards: withComments, total: allCards.length });
        }
        const data = await aptlyFetch('/aptlet/' + boardId, { page: input.page || 0, query: input.query || '' });
        return JSON.stringify(data);
      }

      case 'aptly_list_boards': {
        return JSON.stringify([
          { id: 'unit', name: 'Units / Listings', description: 'All units with Stage, beds, baths, rent, available date.' },
          { id: 'qfBzBxfooJtfTQncd', name: 'List Property / On Market', description: 'Properties actively listed for rent.' },
          { id: 'location', name: 'Properties / Locations', description: 'All properties with owner, address, property details' },
          { id: '4EMDSYKirhQaNdQKz', name: 'Renter Leads', description: 'Prospect leads, showing pipeline' },
          { id: 'YA3QWmPebvMwLwbB3', name: 'Move-Outs', description: 'Move-out pipeline' },
          { id: 'K9mMGGjKgQPqDykaa', name: 'Move-Ins', description: 'Move-in pipeline' },
          { id: '86YrLPbwdkxtdyZoj', name: 'Tenant Renewals', description: 'Lease renewal pipeline' },
          { id: 'workOrder', name: 'Work Orders', description: 'Maintenance work orders' },
        ]);
      }

      case 'compare_work_orders': {
  // Paginate Rentvine fully
  let rvAllRaw = [];
  for (let pg = 1; pg <= 10; pg++) {
    const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
    const batch = Array.isArray(d) ? d : (d && d.data) || [];
    if (batch.length === 0) break;
    rvAllRaw = rvAllRaw.concat(batch);
    if (batch.length < 100) break;
  }

  const rvWOs = rvAllRaw.map(function(rec) {
    return rec.workOrder ? Object.assign({}, rec.workOrder, {
      unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
      vendorName: (rec.contact && rec.contact.name) || '',
    }) : rec;
  }).filter(function(wo) {
    if (!wo.workOrderID) return false;
    const sid = parseInt(wo.primaryWorkOrderStatusID);
    const isClosed = sid === 4 || sid === 5 || !!wo.closedDate || !!wo.dateClosed;
    return !isClosed;
  });

  // Paginate Aptly fully
  let aptlyAllRaw = [];
  for (let pg = 0; pg <= 5; pg++) {
    const d = await unitsFetch('/api/board/workOrder', { page: pg, pageSize: 100, includeArchived: false });
    const batch = Array.isArray(d) ? d : (d && d.data) || [];
    if (batch.length === 0) break;
    aptlyAllRaw = aptlyAllRaw.concat(batch);
    if (batch.length < 100) break;
  }

  const aptlyWOs = aptlyAllRaw.filter(function(c) {
    return !c.archived && !/completed|cancelled|closed|rejected/i.test(c.stage || '');
  });

  const rvByNumber = {};
  rvWOs.forEach(function(wo) { if (wo.workOrderNumber) rvByNumber[String(wo.workOrderNumber)] = wo; });

  const aptlyByNumber = {};
  aptlyWOs.forEach(function(c) { if (c.workOrderNumber) aptlyByNumber[String(c.workOrderNumber)] = c; });

  const matched = [];
  const aptlyOnly = [];
  const statusMismatch = [];

  aptlyWOs.forEach(function(c) {
    const num = String(c.workOrderNumber || '');
    if (!num) {
      aptlyOnly.push({ number: 'no number', title: c.description || c.name, aptlyStage: c.stage, property: (c.location || [])[0]?.name || (c.unit || [])[0]?.name || '' });
      return;
    }
    const rv = rvByNumber[num];
    if (!rv) {
      aptlyOnly.push({ number: num, title: c.description || c.name, aptlyStage: c.stage, property: (c.location || [])[0]?.name || (c.unit || [])[0]?.name || '' });
    } else {
      const rvStatusId = parseInt(rv.primaryWorkOrderStatusID);
      const rvIsClosed = rvStatusId === 4 || rvStatusId === 5 || !!rv.closedDate || !!rv.dateClosed;
      const aptlyIsClosed = /completed|cancelled|closed|rejected/i.test(c.stage || '');
      if (rvIsClosed !== aptlyIsClosed) {
        statusMismatch.push({
          number: num,
          title: c.description || c.name,
          aptlyStage: c.stage,
          rvStatusId,
          rvClosedDate: rv.closedDate || rv.dateClosed || null,
          property: (c.location || [])[0]?.name || (c.unit || [])[0]?.name || rv.unitAddress || '',
        });
      } else {
        matched.push({ number: num, title: c.description || c.name, aptlyStage: c.stage, rvStatusId });
      }
    }
  });

  const rvOnly = rvWOs.filter(function(wo) {
    return wo.workOrderNumber && !aptlyByNumber[String(wo.workOrderNumber)];
  }).map(function(wo) {
    return {
      number: String(wo.workOrderNumber),
      title: (wo.description || '?').replace(/<[^>]+>/g, ' ').trim().slice(0, 60),
      rvStatusId: wo.primaryWorkOrderStatusID,
      property: wo.unitAddress || '',
    };
  });

  return JSON.stringify({
    summary: {
      rvTotal: rvWOs.length,
      aptlyTotal: aptlyWOs.length,
      matched: matched.length,
      aptlyOnly: aptlyOnly.length,
      rvOnly: rvOnly.length,
      statusMismatch: statusMismatch.length,
    },
    aptlyOnly,
    rvOnly,
    statusMismatch,
  });
}

      case 'aptly_get_leads': {
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', {
          page: 0, pageSize: 100, includeArchived: input.includeArchived ? true : false,
        });
        const allCards = Array.isArray(data) ? data : (data && data.data) || [];
        const mapCard = function(c) {
          const m = {
            _id: c.cardId, stage: c.stage,
            createdAt: c.createdAt, updatedAt: c.updatedAt,
            comments: Array.isArray(c.comments) ? c.comments.map(function(cm) {
              return (cm.userName || 'Unknown') + ' (' + (cm.createdAt || '').slice(0, 10) + '): ' + (cm.content || '');
            }) : [],
          };
          Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
          return m;
        };
        let leads = allCards.map(mapCard);
        if (input.daysBack) {
          const cutoffMs = Date.now() - input.daysBack * 24 * 60 * 60 * 1000;
          leads = leads.filter(function(c) {
            try { return new Date(c.createdAt).getTime() > cutoffMs; } catch(e) { return false; }
          });
        }
        if (input.property) {
          const p = input.property.toLowerCase();
          leads = leads.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(p); });
        }
        if (input.stage) {
          const s = input.stage.toLowerCase();
          leads = leads.filter(function(c) { return (c.stage || '').toLowerCase().includes(s); });
        }
        const slim = leads.map(function(c) {
          return {
            contact: c['Primary Contact'] || c['Name'] || '?',
            property: c['Preferred Rental'] || c['Unit'] || '',
            stage: c.stage,
            source: c['Source'] || c['Lead Type'] || '',
            createdAt: (c.createdAt || '').slice(0, 10),
            showingInfo: c['Requested Showing Information'] || '',
            showingStatus: c['Requested Showing Status'] || '',
            tourDate: c['Tour Date/Time'] || '',
            moveDate: c['Move Date'] || '',
            income: c['Household Income'] || '',
            beds: c['Beds'] || '',
            pets: c['Pets'] || '',
            lastActivity: c['Last Activity Date'] || '',
            lastAction: c['Last Action'] || '',
            emails: { inbound: c['Inbound Emails'] || 0, outbound: c['Outbound Emails'] || 0 },
            comments: c.comments || [],
          };
        });
        return JSON.stringify({ total: slim.length, leads: slim });
      }

      case 'aptly_get_work_orders': {
  let allWOs = [];
  for (let page = 0; page <= 10; page++) {
    const data = await unitsFetch('/api/board/workOrder', { 
      page, 
      pageSize: 100, 
      includeArchived: false 
    });
    const batch = Array.isArray(data) ? data : (data && data.data) || [];
    if (batch.length === 0) break;
    allWOs = allWOs.concat(batch);  // accumulate ALL, filter AFTER
    if (batch.length < 100) break;
  }

 const activeWOs = allWOs.filter(function(c) {
    return !c.archived && !/^(closed|cancelled|completed|rejected)/i.test(c.stage || '');
  });
  // After building activeWOs, add this before the status filter:
if (input.status && input.status.toLowerCase() === 'emergency') {
  const emergencies = activeWOs.filter(function(c) {
    const stage = (c.stage || '').toLowerCase();
    const priority = (c.priority || '').toLowerCase();
    const desc = (c.description || c.name || '').replace(/<[^>]+>/g, '').toLowerCase();
    return stage.includes('emergency') || 
           priority.includes('emergency') || 
           priority.includes('urgent') ||
           /water.*leak|gas.*leak|no.*heat|no.*ac|flood|sewage|burst.*pipe/i.test(desc);
  });
  // return emergencies directly
  const slim = emergencies.map(function(c) {
    const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
    const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
const address = normalizeAddr((locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '');
      const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
      const vendor = (vendorArr[0] && vendorArr[0].name) || 'Unassigned';
      const rawDesc = (c.description || c.name || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
      return {
        address,
        num: c.workOrderNumber || '',
        issue: rawDesc.slice(0, 80),
      vendor,
      opened: (c.createdAt || '').slice(0, 10),
      daysOpen: created ? Math.floor((Date.now() - created) / 86400000) : null,
      status: c.stage || '',
      priority: c.priority || '',
    };
  });
  return JSON.stringify({ total: slim.length, emergencies: slim });
}
  let filtered = activeWOs;
        if (input.status) {
          const s = input.status.toLowerCase();
          if (s === 'open' || s === 'not closed') {
            filtered = activeWOs;
          } else {
            filtered = activeWOs.filter(function(c) { return (c.stage || '').toLowerCase().includes(s); });
          }
        }
        if (!input.status) {
          filtered = activeWOs;
        }
        if (input.property) {
          const p = input.property.toLowerCase();
          filtered = filtered.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(p); });
        }
        const now = Date.now();
        const withMetrics = filtered.map(function(c) {
          const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
          const daysOpen = created ? Math.floor((now - created) / 86400000) : null;
          return Object.assign({}, c, { daysOpen });
        });
        const open = withMetrics;
        const unassigned = open.filter(function(c) {
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          return vendorArr.length === 0;
        });
        const byStage = {};
        withMetrics.forEach(function(c) { const s = c.stage || 'Unknown'; byStage[s] = (byStage[s] || 0) + 1; });
        const commentsMap = {};
        if (input.includeComments) {
          const cardIdsForComments = withMetrics.map(function(c) { return c.cardId; }).filter(Boolean);
          const commentResults = await Promise.all(cardIdsForComments.map(async function(id) {
            try {
              const data = await unitsFetch('/api/board/workOrder/' + id + '/comments');
              const comments = Array.isArray(data) ? data : (data && data.data) || [];
              return { id, comments };
            } catch(e) { return { id, comments: [] }; }
          }));
          commentResults.forEach(function(r) { commentsMap[r.id] = r.comments; });
        }
        const slim = withMetrics.map(function(c) {
          const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
          const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
          const address = normalizeAddr((locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '');
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          const vendor = (vendorArr[0] && vendorArr[0].name) || 'Unassigned';
          const rawDesc = c.description || c.name || '?';
          const cleanDesc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const rawComments = commentsMap[c.cardId] || [];
          const comments = rawComments.map(function(cm) {
            return (cm.userName || cm.user || 'Unknown') + ' (' + (cm.createdAt || '').slice(0, 10) + '): ' + (cm.content || cm.text || '');
          });
          return {
            address, num: c.workOrderNumber || c.number || '',
            issue: cleanDesc.split(/\s+/).slice(0, 6).join(' '),
            vendor, opened: (c.createdAt || '').slice(0, 10),
            daysOpen: c.daysOpen, status: c.stage || '',
            commentCount: comments.length, comments,
          };
        });
        return JSON.stringify({
          total: withMetrics.length,
          open: open.length,
          unassigned: unassigned.length,
          avgDaysOpen: open.length ? Math.round(open.reduce(function(s, c) { return s + (c.daysOpen || 0); }, 0) / open.length) : 0,
          byStage, workOrders: slim,
        });
      }

      case 'aptly_get_applicant': {
        const q = (input.query || '').toLowerCase();
        const allCards = await getApplicantsCards();
        const matched = allCards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(q); });
        if (matched.length === 0) {
          return JSON.stringify({ message: 'No applicant found matching: ' + input.query });
        }
        const results = await Promise.all(matched.map(async function(c) {
          const fullName = c['Primary Applicant'] || '';
          const cardId = c._cardId || '';
          let comments = ['No comments'];
          if (cardId) {
            try {
              const commentsData = await unitsFetch('/api/board/MJxaStgENouWrNEKd/' + cardId + '/comments');
              const commentList = Array.isArray(commentsData) ? commentsData :
                (commentsData && commentsData.comments) ? commentsData.comments :
                (commentsData && commentsData.data) ? commentsData.data : [];
              if (commentList.length > 0) {
                comments = commentList.map(function(cm) {
                  return (cm.userName || cm.name || cm.createdBy || 'Unknown') +
                    ' (' + (cm.createdAt || cm.date || '').slice(0, 10) + '): ' +
                    (cm.content || cm.text || cm.message || '');
                });
              }
            } catch(e) { console.error('Comment fetch error:', e.message); }
          }
          return {
            applicant: fullName || c.Title || '?',
            location: c['Application Location'] || '',
            stage: c.Stage || '',
            complete: c['Application Complete'] || '',
            approved: c.appApproved || false,
            household: c.Household || '',
            moveIn: c['Move-In Date'] || '',
            income: c['Total Household Mo. Income'] || '',
            credit: c['Avg. Household Credit'] || '',
            comments,
          };
        }));
        return JSON.stringify(results.length === 1 ? results[0] : results);
      }

      case 'aptly_search_cards': {
        const q = input.query || '';
        const boardsToSearch = input.boardId
          ? [input.boardId]
          : ['4EMDSYKirhQaNdQKz', 'MJxaStgENouWrNEKd', 'YA3QWmPebvMwLwbB3', 'K9mMGGjKgQPqDykaa', '86YrLPbwdkxtdyZoj', 'qfBzBxfooJtfTQncd', 'location'];
        const results = [];
        for (const bid of boardsToSearch) {
          let cards = [];
          if (bid === 'MJxaStgENouWrNEKd') {
            const data = await aptlyFetch('/aptlet/' + bid, { page: 0, query: q || 'Application' });
            cards = (data && data.cards) || (Array.isArray(data) ? data : []);
          } else {
            const data = await aptlyFetch('/aptlet/' + bid, { page: 0, query: q });
            cards = (data && data.cards) || (Array.isArray(data) ? data : []);
          }
          const matched = q
            ? cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(q.toLowerCase()); })
            : cards;
          if (matched.length > 0) {
            const withComments = matched.map(function(c) {
              const comments = Array.isArray(c.comments) && c.comments.length > 0
                ? c.comments.map(function(cm) { return (cm.userName || 'Unknown') + ' (' + (cm.createdAt || '').slice(0, 10) + '): ' + (cm.content || ''); })
                : [];
              return Object.assign({}, c, { formatted_comments: comments });
            });
            results.push({ board: bid, cards: withComments });
          }
        }
        return JSON.stringify(results.length > 0 ? results : { message: 'No results found for: ' + (q || '(all)') });
      }

      case 'slack_search': {
        const data = await slackFetch('/search.messages', { query: input.query, count: 10 });
        if (data.messages && data.messages.matches) {
          return JSON.stringify(data.messages.matches.map(function(m) {
            return {
              channel: m.channel && m.channel.name,
              user: m.username,
              text: m.text,
              time: new Date(parseFloat(m.ts) * 1000).toLocaleString(),
            };
          }));
        }
        return JSON.stringify({ message: 'No results', query: input.query });
      }

      case 'slack_get_channel_messages': {
        const data = await slackFetch('/conversations.history', { channel: input.channelId, limit: input.limit || 20 });
        if (data.messages) {
          return JSON.stringify(data.messages.map(function(m) {
            return { text: m.text, time: new Date(parseFloat(m.ts) * 1000).toLocaleString() };
          }));
        }
        return JSON.stringify({ error: data.error || 'Could not fetch' });
      }

      case 'slack_list_channels': {
        const data = await slackFetch('/conversations.list', { limit: 100, exclude_archived: true });
        if (data.channels) {
          return JSON.stringify(data.channels.map(function(c) { return { id: c.id, name: c.name }; }));
        }
        return JSON.stringify({ error: data.error });
      }

      // zi_get_inspections kept for back-compat with system prompt mention
      case 'zi_get_inspections': {
        const q = input.propertyId || '';
        const result = await ziFetch('/inspections', q ? { property: q, limit: 10 } : { limit: 10 });
        if (result.error) {
          const rv = await rvFetch('/maintenance/inspections', { pageSize: 50 });
          if (q && Array.isArray(rv)) {
            return JSON.stringify(rv.filter(i => JSON.stringify(i).toLowerCase().includes(q.toLowerCase())).slice(0, 10));
          }
          return JSON.stringify({ zInspectorError: result.error, rentvineInspections: rv });
        }
        return JSON.stringify(result);
      }

      default:
        return JSON.stringify({ error: 'Unknown tool: ' + name });
    }
  } catch (err) {
    console.error('Tool ' + name + ' error:', err.message);
    return JSON.stringify({ error: err.message });
  }
}

// ── Smart tool router ─────────────────────────────────────────────────────────
function getRelevantTools(msg) {
  msg = (msg || '').toLowerCase();
  const tools = new Set();

  if (msg.match(/tenant|owe|balance|ledger|payment|charge|rent|deposit|past.?due|unpaid|how much/)) {
    ['rv_get_leases', 'rv_get_ledger', 'rv_get_transactions'].forEach(function(t) { tools.add(t); });
  } if (msg.match(/availab|unit|vacant|propert|homes?|house|bed|bath|address|\d{4,5}|tour|showing|work.?done|inspect|ready|make.?ready|pet|dog|cat|animal/)) {
   if (msg.match(/\d{3,6}/)) {
      ['rv_get_properties', 'rv_get_units'].forEach(function(t) { tools.add(t); });
    }
    ['aptly_get_board_cards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/work.?order|maintenance|repair|fix|broken/)) {
    tools.add('aptly_get_work_orders');
  }
  if (msg.match(/compare|cross.?ref|aptly.*rentvine|rentvine.*aptly|how many.*rentvine|rentvine.*how many/)) {
    tools.add('rv_get_work_orders');
    tools.add('compare_work_orders');
  }
  if (msg.match(/work.?order.*detail|detail.*work.?order|specific.*work.?order/)) {
    tools.add('rv_get_work_order_detail');
  }
  if (msg.match(/comment|note|follow.?up|update.*work|work.*update|no.*comment|comment.*work/)) {
    tools.add('rv_get_work_order_notes');
    tools.add('aptly_get_work_orders');
  }
  if (msg.match(/inspect/)) {
    ['rv_get_inspections', 'rv_get_inspection_detail'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/vendor|contractor/)) {
    tools.add('rv_get_vendors');
    tools.add('kb_search'); // vendor list lives in KB
  }
  if (msg.match(/owner|landlord|portfolio|performing|statement/)) {
    ['rv_get_owners', 'rv_get_properties'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly|tour|showing|schedul|appointment|visit/)) {
    ['aptly_get_board_cards', 'aptly_list_boards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
    ['rv_get_inspections', 'rv_get_properties', 'zi_get_inspections'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/applicant|application|applied|applying|screening|comment|note.*card|card.*note|what.*said|who.*said/)) {
    tools.add('aptly_get_applicant');
    tools.add('aptly_search_cards');
  }
  if (msg.match(/comment|note|said|pomf|update/) && msg.match(/\d+\s+\w/)) {
    tools.add('aptly_get_applicant');
  }
  // Policy / procedure / training / cost / SOP — all KB now
  if (msg.match(/policy|procedure|sop|how do|what do|lease.?break|pet|fee|screen|criteria|step|process|rule|train|cost|price|quote|charge|expensive|too much|fair|benchmark|approve|guide|tip|troubleshoot/)) {
    tools.add('kb_search');
  }
  if (msg.match(/slack|team|announce|update|channel|said|message/)) {
    ['slack_search', 'slack_get_channel_messages', 'slack_list_channels'].forEach(function(t) { tools.add(t); });
  }

  // Default fallback — if no patterns matched, give Claude tenant lookup + KB search
  if (tools.size === 0) {
    ['rv_get_leases', 'kb_search'].forEach(function(t) { tools.add(t); });
  }

  const selected = Array.from(tools).slice(0, 8);
  return ALL_TOOLS.filter(function(t) { return selected.indexOf(t.name) !== -1; });
}

// ── Claude API proxy ──────────────────────────────────────────────────────────
app.post('/api/chat', async function(req, res) {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  try {
    const messages = req.body.messages;
    const lastMsg = messages.slice().reverse().find(function(m) { return m.role === 'user'; });
    const tools = getRelevantTools(lastMsg ? lastMsg.content : '');
    console.log('Tools:', tools.map(function(t) { return t.name; }).join(', '));

    const lastContent = messages[messages.length - 1]?.content;
    const lowerMsg = (typeof lastContent === 'string' ? lastContent :
      (Array.isArray(lastContent) ? lastContent.map(function(b) { return b.text || ''; }).join(' ') : '')
    ).toLowerCase();
    const userMsg = typeof lastContent === 'string' ? lastContent : (Array.isArray(lastContent) ? lastContent.map(function(b) { return b.text || ''; }).join(' ') : '');

    // ─── KB-powered shortcuts (formerly Notion shortcuts) ────────────────────

    // VENDOR SHORTCUT — pulls vendor list from KB, sends to Claude with strict context
    const isVendorQ = lowerMsg.match(/vendor|who.*assign|who.*call|who.*use|which.*vendor|assign.*work.?order|who.*do.*hvac|who.*do.*plumb|who.*do.*roof|who.*do.*pest|who.*do.*landscap|who.*do.*clean|who.*do.*floor|who.*do.*paint|who.*do.*appli|who.*do.*garage|who.*do.*glass|preferred.*vendor|vendor.*list/);
    if (isVendorQ) {
      try {
        const vendorContext = await getKbTopic(
          'vendor_list',
          'preferred vendor list service type phone HVAC plumbing electrical landscaping pest',
          { limit: 4, audience: 'staff' }
        );
        if (vendorContext) {
          const vendorPrompt = 'VENDOR REFERENCE (from Aloe Knowledge Base):\n\n' + vendorContext;
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1024,
              system: 'You are Aloe Assistant, an internal AI for Aloe Property Management. Answer the vendor question using ONLY the vendor reference provided. Be specific about which vendor to use, their coverage area, and any notes. If the question mentions a city or area, match it to the right vendor.',
              messages: [{ role: 'user', content: vendorPrompt + '\n\n---\nQuestion: ' + userMsg }]
            })
          });
          const data = await resp.json();
          const answer = (data.content && data.content[0] && data.content[0].text) || '';
          if (answer) {
            console.log('Vendor shortcut fired (KB) for:', userMsg.slice(0, 60));
            return res.json({ content: [{ type: 'text', text: answer }] });
          }
        }
      } catch(e) {
        console.error('Vendor shortcut error:', e.message);
      }
    }

    // COST BENCHMARK SHORTCUT — pulls cost benchmarks from KB
    const isPriceQ = lowerMsg.match(/cost|price|quote|charge|too (much|high|expensive)|fair price|good price|benchmark|should i approve|approve.*quote|is.*\$|how much.*should|within range|get.*bid|another.*quote|second.*quote/);
    if (isPriceQ) {
      try {
        const costContext = await getKbTopic(
          'cost_benchmarks',
          'maintenance cost benchmarks Phoenix repair pricing approve quote bid',
          { limit: 3, audience: 'staff' }
        );
        if (costContext) {
          const resp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 600,
              system: `You are a maintenance cost advisor for Aloe Property Management in Phoenix, AZ. Use the benchmark data below to evaluate vendor quotes. Always give a clear verdict:
✅ APPROVE — price is within typical range
⚠️ HIGH BUT ACCEPTABLE — above typical but still reasonable, use judgment
❌ GET ANOTHER QUOTE — price is too high, request additional bids
🚨 NEEDS OWNER APPROVAL — over $250-$500, require owner sign-off

Format your response as:
**[Repair type]**
Quoted: $[amount]
Typical range: $[range]
Verdict: [emoji + verdict]
[1-2 sentence explanation + action if needed]

General rules if specific item not listed:
- Under $125 from trusted vendor: usually approve
- $125–$250: compare to benchmarks, ask for photos if high
- Over $250: get 2-3 bids unless emergency
- Over $500: owner approval required

BENCHMARK DATA:
` + costContext.slice(0, 5000),
              messages: [{ role: 'user', content: userMsg }]
            })
          });
          const data = await resp.json();
          const answer = data.content && data.content[0] && data.content[0].text;
          if (answer) {
            console.log('Price check shortcut fired (KB):', userMsg.slice(0, 80));
            return res.json({ content: [{ type: 'text', text: answer }] });
          }
        }
      } catch(e) {
        console.error('Price check shortcut error:', e.message);
      }
    }

    // ─── Live-data shortcuts (unchanged from original) ───────────────────────

    const isAvailabilityQ = !lowerMsg.match(/work.?order|maintenance|repair|vendor|submitted|most.*order|order.*most/) &&
      lowerMsg.match(/availab|for rent|vacant|what unit|what prop|what home|what listing|what house|under \d|homes.*rent|rent.*home|\d\s*bed/) && !lowerMsg.match(/[0-9]{5,6}/);
    const isMarketDaysQ = !lowerMsg.match(/work.?order|maintenance|repair|vendor/) &&
      lowerMsg.match(/market.*(\d+).*day|(\d+).*day.*market|how long.*market|days.*listed|listed.*days|sitting.*market|market.*long|homes.*listed.*over|listed.*over.*\d+.*day/);
    const marketDays = isMarketDaysQ ? parseInt((lowerMsg.match(/(\d+)\s*day/) || [])[1] || '30') : null;
    const isNotTourableQ = lowerMsg.match(/not.{0,20}(tour|showing|avail)|can.{0,10}t.{0,10}(tour|showing)|(tour|showing).{0,20}not/) && !lowerMsg.match(/[0-9]{5,6}/);
    const priceMatch = lowerMsg.match(/(?:under|less than|below|max|up to)\s*\$?(\d{3,5})/);
    const maxPrice = priceMatch ? parseInt(priceMatch[1]) : null;
    const bedMatch = lowerMsg.match(/(\d)\s*(?:bed|br|bedroom)/);
    const minBeds = bedMatch ? parseInt(bedMatch[1]) : null;

    if (isMarketDaysQ) {
      try {
        const cards = await getUnitsCards();
        const published = cards.filter(function(c) {
          return c['Published For Rent'] === 'checked' || c['Published For Rent'] === true ||
                 c['Syndicate'] === 'checked' || c['Active'] === 'checked';
        });
        const now = Date.now();
        const threshold = marketDays * 24 * 60 * 60 * 1000;
        const longListed = published.filter(function(c) {
          const dateStr = c['Available Date'] || c['Stage Changed'] || c['Created At'] || '';
          if (!dateStr) return false;
          try {
            return (now - new Date(dateStr).getTime()) > threshold;
          } catch(e) { return false; }
        }).sort(function(a, b) {
          const da = new Date(a['Available Date'] || a['Stage Changed'] || 0).getTime();
          const db = new Date(b['Available Date'] || b['Stage Changed'] || 0).getTime();
          return da - db;
        });
        const fmt = function(c) {
          const addr = (c.Street || c.Address || c['Marketing Name'] || c.Title || '?').replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '');
          const dateStr = c['Available Date'] || c['Stage Changed'] || '';
          const daysOn = dateStr ? Math.floor((now - new Date(dateStr).getTime()) / 86400000) : '?';
          const rent = c['Market Rent'] && typeof c['Market Rent'] === 'object' ? '$' + Number(c['Market Rent'].amount).toLocaleString() : (c['Market Rent'] || '');
          const beds = c.Beds ? c.Beds + 'bd' : '';
          return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '') + ' — ' + daysOn + ' days on market';
        };
        const text = longListed.length > 0
          ? 'Homes listed over ' + marketDays + ' days (' + longListed.length + '):\n\n' + longListed.map(fmt).join('\n')
          : 'No homes have been listed over ' + marketDays + ' days.';
        return res.json({ content: [{ type: 'text', text }] });
      } catch(e) {
        console.error('Market days shortcut error:', e.message);
      }
    }

    if (isAvailabilityQ || isNotTourableQ) {
      try {
        const cards = await getUnitsCards();
        const comingAvailMatch = lowerMsg.match(/coming.*availab|availab.*soon|next\s+(\d+)\s+day|upcoming.*availab|availab.*next|availab.*in.*(\d+)/);
        if (comingAvailMatch || lowerMsg.match(/next \d+ days|next 30|next 60|next 90|upcoming vacant|coming up|list.*property|list.*market|on market/)) {
          const daysAhead = parseInt((lowerMsg.match(/next\s+(\d+)\s+day/)||[])[1] || '30');
          const nowMs = Date.now();
          const azOffset = -7 * 60 * 60 * 1000;
          const futureMs = nowMs + daysAhead * 24 * 60 * 60 * 1000;
          const futureStr = new Date(futureMs + azOffset).toISOString().slice(0,10);
          const listData = await unitsFetch('/api/board/qfBzBxfooJtfTQncd', { page: 0, pageSize: 100, includeArchived: false });
          const listCards = Array.isArray(listData) ? listData : (listData && listData.data) || [];
          const coming = listCards.filter(function(c) {
            if (!/on market/i.test(c.Stage || '')) return false;
            const d = c['Mirror Available Date'];
            if (!d) return true;
            try {
              const ds = new Date(d).toISOString().slice(0,10);
              return ds <= futureStr;
            } catch(e) { return false; }
          }).sort(function(a, b) {
            const da = a['Mirror Available Date'] ? new Date(a['Mirror Available Date']).getTime() : 0;
            const db = b['Mirror Available Date'] ? new Date(b['Mirror Available Date']).getTime() : 0;
            return da - db;
          });
          const fmt2 = function(c) {
            const addr = (c['Mirror Address'] || c.Title || '?').replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '').replace(/,.*$/, '').trim();
            const rent = c['Mirror Market Rent'] || '';
            const beds = c['Mirror Beds'] ? c['Mirror Beds'] + 'bd/' + (c['Mirror Baths']||'?') + 'ba' : '';
            const availRaw = c['Mirror Available Date'];
            const avail = availRaw ? new Date(availRaw).toLocaleDateString('en-US', {month:'numeric',day:'numeric',year:'numeric'}) : 'TBD';
            const status = c['Mirror Status'] || '';
            const occupied = /occupied/i.test(status) ? ' (currently occupied)' : /vacant/i.test(status) ? ' (vacant now)' : '';
            const owner = c['Mirror Owners'] || '';
            const showingStart = c['Showing Start Date'] ? ' | showings from ' + c['Showing Start Date'] : '';
            const daysListed = c['Date Listed'] ? Math.floor((nowMs - new Date(c['Date Listed']).getTime()) / 86400000) + 'd on market' : '';
            return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '') +
              ', avail ' + avail + occupied + showingStart +
              (daysListed ? ' | ' + daysListed : '') +
              (owner ? ' | ' + owner : '');
          };
          const label = 'Active listings coming available in the next ' + daysAhead + ' days (' + coming.length + '):';
          const text = coming.length > 0
            ? label + '\n\n' + coming.map(fmt2).join('\n')
            : 'No active listings with available dates in the next ' + daysAhead + ' days.';
          return res.json({ content: [{ type: 'text', text }] });
        }
        let published = cards.filter(function(c) {
          return c['Published For Rent'] === 'checked' || c['Published For Rent'] === true ||
                 c['Syndicate'] === 'checked' || c['Active'] === 'checked';
        });
        if (maxPrice) {
          published = published.filter(function(c) {
            const r = c['Market Rent'];
            const amt = r && typeof r === 'object' && r.amount ? parseFloat(r.amount) : parseFloat(String(r || '0').replace(/[^0-9.]/g, ''));
            return amt > 0 && amt <= maxPrice;
          });
        }
        if (minBeds) {
          published = published.filter(function(c) { return parseInt(c.Beds || 0) === minBeds; });
        }
        const listCards = published.length > 0 ? published : cards.filter(function(c) {
          return c.Street || c.Address;
        }).slice(0, 50);
        if (listCards.length > 0) {
          const fmt = function(c) {
  let addr = c.Street || c.Address || c['Marketing Name'] || c.Title || '?';
  addr = addr.replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '');
  const rentRaw = c['Market Rent'] || c['Rent'] || '';
  const rent = rentRaw && typeof rentRaw === 'object' && rentRaw.amount ? '$' + Number(rentRaw.amount).toLocaleString() : rentRaw;
  const beds = c.Beds ? c.Beds + 'bd/' + (c.Baths || '?') + 'ba' : '';
  const availRaw = c['Available Date'] || '';
  const avail = availRaw ? new Date(availRaw).toLocaleDateString('en-US', {month:'numeric',day:'numeric',year:'numeric'}) : '';
  const stage = c.Stage || c.Status || '';
  const occupied = stage === 'Occupied' ? ' (occupied)' : '';
  // Pet restriction from raw card fields
  const restr = Array.isArray(c['Pet Restrictions']) ? c['Pet Restrictions'] : [];
  const pa = c['Pets Allowed'];
  const noDogs = restr.some(function(r){ return /no dog/i.test(r); });
  const noCats = restr.some(function(r){ return /no cat/i.test(r); });
  const noPets = pa === false || (noDogs && noCats);
  const petLabel = noPets ? ' 🚫 No Pets' : (noDogs ? ' 🐾 Cats Only' : (noCats ? ' 🐾 Dogs Only' : ''));
  return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '') + (avail ? ', avail ' + avail : '') + occupied + petLabel;
};
          const notTourable = isNotTourableQ
            ? listCards.filter(function(c) { return (c.Stage || c.Status || '') === 'Occupied'; })
            : null;
          let text;
          if (notTourable && notTourable.length > 0) {
            text = 'Homes not yet available for tours (' + notTourable.length + '):\n\n' + notTourable.map(fmt).join('\n') + '\n\nAsk about any address for more details.';
          } else if (notTourable) {
            text = 'All published homes are currently vacant and available for tours.';
          } else {
            let label = 'Homes published for rent';
            if (maxPrice) label += ' under $' + maxPrice.toLocaleString();
            if (minBeds) label += ', ' + minBeds + ' bed';
            text = label + ' (' + listCards.length + '):\n\n' + listCards.map(fmt).join('\n') + '\n\nAsk about any address for more details.';
          }
          return res.json({ content: [{ type: 'text', text }] });
        }
      } catch(e) {
        console.error('Units shortcut error:', e.message);
      }
    }

    // Server-side shortcut for application questions
    const isApplicationQ = lowerMsg.match(/application|applicant|applied|applying/) && !lowerMsg.match(/[0-9]{5,6}/);
    const applicationAddress = lowerMsg.match(/(\d+\s+\w[\w\s]+(?:dr|drive|st|street|ave|avenue|blvd|boulevard|rd|road|ln|lane|way|ct|court|pl|place))/i);
    if (isApplicationQ) {
      try {
        const searchTerm = applicationAddress ? applicationAddress[1] : '';
        let cards = await getApplicantsCards();
        const filtered = searchTerm
          ? cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(searchTerm.toLowerCase().split(' ')[0]); })
          : cards;
        const active = filtered.filter(function(c) {
          return !c.archived && c.Stage !== 'Application Closed' && c.Stage !== 'Archived';
        });
        const complete = active.filter(function(c) { return c['Application Complete'] === 'All Applicants'; });
        const partial = active.filter(function(c) { return c['Application Complete'] === 'Some Applicants'; });
        const approved = active.filter(function(c) { return c.appApproved === true; });
        const fmt = function(c) {
          const loc = c['Application Location'] || '(no address)';
          const applicant = c['Primary Applicant'] || c.Title || '?';
          const isApproved = c.appApproved === true;
          const appComplete = c['Application Complete'] || '';
          return loc + ' — ' + applicant +
            (isApproved ? ' ✓ APPROVED' : '') +
            (appComplete === 'All Applicants' ? ' (complete)' : appComplete === 'Some Applicants' ? ' (partial)' : '');
        };
        const toShow = active.filter(function(c) {
          return c['Application Complete'] === 'All Applicants' ||
                 c['Application Complete'] === 'Some Applicants' ||
                 c.appApproved === true;
        });
        if (active.length > 0) {
          let text = 'Active applications (' + active.length + ' total';
          if (complete.length) text += ', ' + complete.length + ' complete';
          if (partial.length) text += ', ' + partial.length + ' partial';
          if (approved.length) text += ', ' + approved.length + ' approved';
          text += '):\n\n';
          if (toShow.length > 0) {
            text += toShow.map(fmt).join('\n');
          } else {
            text += active.map(fmt).join('\n');
          }
          if (searchTerm) text = 'Applications for ' + searchTerm + ':\n\n' + active.map(fmt).join('\n');
          text += '\n\nAsk about any applicant for full details.';
          return res.json({ content: [{ type: 'text', text }] });
        } else {
          return res.json({ content: [{ type: 'text', text: 'No active applications found' + (searchTerm ? ' for ' + searchTerm : '') + '.' }] });
        }
      } catch(e) {
        console.error('Applications shortcut error:', e.message, e.stack);
      }
    }

    // ─── Main Claude tool-loop ───────────────────────────────────────────────
    let current = messages.slice();
    for (let i = 0; i < 10; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: await (async function() {
            let sys = SYSTEM_PROMPT;
            // On first loop, inject any topic-relevant KB content
            if (i === 0) {
              const ctx = await getKbContext(lowerMsg);
              if (ctx && ctx.text) {
                sys += '\n\n---\nRELEVANT KB CONTENT (' + ctx.label + '):\n' + ctx.text.slice(0, 4000);
              }
            }
            return sys;
          })(),
          messages: current,
          tools: tools,
        }),
      });

      const data = await r.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      console.log('Loop ' + (i + 1) + ': stop_reason=' + data.stop_reason);

      if (data.stop_reason !== 'tool_use') return res.json(data);

      const tbs = data.content.filter(function(b) { return b.type === 'tool_use'; });
      const results = await Promise.all(tbs.map(async function(tb) {
        let result = await executeTool(tb.name, tb.input);
        if (typeof result === 'string' && result.length > 8000) {
          try {
            const parsed = JSON.parse(result);
            if (Array.isArray(parsed)) {
              const trimmed = parsed.slice(0, 15).map(function(item) {
                const clean = Object.assign({}, item);
                delete clean['Property Photos'];
                delete clean['Mirror Marketing Description'];
                delete clean['Marketing Description'];
                delete clean.comments;
                delete clean['Files'];
                delete clean.groups;
                delete clean.amenities;
                return clean;
              });
              result = JSON.stringify({
                total: parsed.length,
                shown: trimmed.length,
                note: parsed.length > 15 ? 'Results trimmed — ' + (parsed.length - 15) + ' more not shown' : undefined,
                data: trimmed
              });
           } else if (parsed && parsed.workOrders && Array.isArray(parsed.workOrders)) {
              // Work orders tool — keep all but strip heavy fields
              const trimmed = parsed.workOrders.map(function(c) {
                const clean = Object.assign({}, c);
                delete clean.comments;
                return clean;
              });
              result = JSON.stringify(Object.assign({}, parsed, { workOrders: trimmed }));
            } else if (parsed && parsed.cards && Array.isArray(parsed.cards)) {
              const trimmed = parsed.cards.slice(0, 20).map(function(c) {
                const clean = Object.assign({}, c);
                delete clean['Property Photos'];
                delete clean['Mirror Marketing Description'];
                delete clean['Marketing Description'];
                delete clean.comments;
                return clean;
              });
              result = JSON.stringify({ total: parsed.cards.length, shown: trimmed.length, cards: trimmed });
            }
          } catch(e) {
            result = result.slice(0, 8000) + '...[truncated]';
          }
        }
        if (typeof result === 'string' && result.length > 15000) {
          // For work orders, trim issue text before hard truncating
          try {
            const parsed = JSON.parse(result);
            if (parsed && parsed.workOrders && Array.isArray(parsed.workOrders)) {
              const slim = parsed.workOrders.map(function(wo) {
                return { address: wo.address, num: wo.num, issue: (wo.issue || '').split(' ').slice(0, 4).join(' '), vendor: wo.vendor, opened: wo.opened, daysOpen: wo.daysOpen, status: wo.status };
              });
              result = JSON.stringify(Object.assign({}, parsed, { workOrders: slim }));
            }
          } catch(e) {}
          if (result.length > 15000) result = result.slice(0, 15000) + '...[truncated]';
        }
        return {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: result,
        };
      }));

      current = current.concat([
        { role: 'assistant', content: data.content },
        { role: 'user', content: results },
      ]);
    }

    res.status(500).json({ error: 'Too many steps — try a more specific question' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Rentvine Proxy ─────────────────────────────────────────────────────────
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
    const data = await r.json();
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/debug/properties', async function(req, res) {
  const data = await rvFetch('/properties/export', { pageSize: 200 });
  res.json(data);
});

app.get('/debug/units', async function(req, res) {
  const data = await rvFetch('/units/export', { pageSize: 200 });
  res.json(data);
});

app.get('/debug/units-api', async function(req, res) {
  try {
    const token = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || 'NOT SET';
    const schema = await unitsFetch('/api/schema/unit');
    const rawCards = await unitsFetch('/api/board/unit', { page: 0, pageSize: 3 });
    const mappedCards = await getUnitsCards();
    res.json({
      tokenSet: token !== 'NOT SET',
      tokenPrefix: token.slice(0, 8) + '...',
      schemaIsArray: Array.isArray(schema),
      schemaLength: Array.isArray(schema) ? schema.length : null,
      schemaSample: Array.isArray(schema) ? schema.slice(0,3) : schema,
      rawResponseType: Array.isArray(rawCards) ? 'array' : typeof rawCards,
      rawResponseKeys: rawCards && typeof rawCards === 'object' && !Array.isArray(rawCards) ? Object.keys(rawCards) : null,
      rawLength: Array.isArray(rawCards) ? rawCards.length : null,
      rawSample: Array.isArray(rawCards) ? rawCards.slice(0,2) : rawCards,
      mappedCount: mappedCards.length,
      mappedSample: mappedCards.slice(0, 2)
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Clear the KB topic cache (useful after KB content updates)
app.get('/reload-kb-cache', function(req, res) {
  Object.keys(KB_TOPIC_CACHE).forEach(k => delete KB_TOPIC_CACHE[k]);
  res.json({ cleared: true });
});
app.get('/chat', function(req, res) {
  res.sendFile(new URL('chat.html', import.meta.url).pathname);
});
app.get('/sandbox', function(req, res) {
  res.sendFile(new URL('sandbox.html', import.meta.url).pathname);
});

app.get('/recon', function(req, res) {
  const filePath = new URL('recon.html', import.meta.url).pathname;
  res.sendFile(filePath, function(err) {
    if (err) console.error('recon.html sendFile error:', err.message, 'path:', filePath);
  });
});
app.get('/recon-bills', (req, res) =>
   res.sendFile(new URL('recon-bills.html', import.meta.url).pathname)
);
// Plaid
initPlaidRoutes(app);
app.get('/bank-setup', function(req, res) {
  res.sendFile(new URL('plaid-setup.html', import.meta.url).pathname);
});
app.get('/debug/pet-test', async function(req, res) {
  try {
    const cards = await getUnitsCards();
    const match = cards.find(function(c) {
      return JSON.stringify(c).toLowerCase().includes('lake mirage');
    });
    const locSchema = await unitsFetch('/api/schema/location');
    const locMap = {};
    if (Array.isArray(locSchema)) locSchema.forEach(function(f) { locMap[f.key] = f.label; });
    let allLocs = [];
    const data = await unitsFetch('/api/board/location', { page: 0, pageSize: 100 });
    const batch = Array.isArray(data) ? data : (data && data.data) || [];
    allLocs = batch;
    const locMatch = allLocs.find(function(card) {
      return JSON.stringify(card).toLowerCase().includes('lake mirage');
    });
    const locMatchMapped = locMatch ? (function() {
      const m = {};
      Object.keys(locMatch).forEach(function(k) { m[locMap[k] || k] = locMatch[k]; });
      return m;
    })() : null;
    res.json({
      unitsTotal: cards.length,
      unitMatch: match || 'NOT FOUND IN UNITS',
      unitSampleKeys: cards[0] ? Object.keys(cards[0]).slice(0, 30) : [],
      locationsTotal: allLocs.length,
      locMatch: locMatchMapped || 'NOT FOUND IN LOCATIONS',
      locSampleKeys: allLocs[0] ? Object.keys(allLocs[0]).slice(0, 20) : [],
    });
  } catch(e) {
    res.json({ error: e.message });
  }
});
app.get('/logo.png', function(req, res) {
  res.sendFile(new URL('AloePM-Logo_FullColor__2_.png', import.meta.url).pathname);
});
app.get('/rent-analysis', (req, res) =>
  res.sendFile(new URL('./rent-analysis.html', import.meta.url).pathname));
app.get('/sale-analysis', (req, res) =>
  res.sendFile(new URL('./sale-analysis.html', import.meta.url).pathname));

app.get('/owner-report', (req, res) =>
  res.sendFile(new URL('./owner-report.html', import.meta.url).pathname));

app.get('/hoa', (req, res) =>
  res.sendFile(new URL('./hoa-filler.html', import.meta.url).pathname));

app.post('/api/hoa/fill', (req, res) => {
  const py = spawn('python3', ['hoa_filler.py']);
  let out = '', err = '';
  py.stdin.write(JSON.stringify(req.body));
  py.stdin.end();
  py.stdout.on('data', d => out += d);
  py.stderr.on('data', d => err += d);
  py.on('close', code => {
    if (code !== 0) return res.status(500).json({ error: err.slice(0,500) });
    try { res.json(JSON.parse(out)); }
    catch(e) { res.status(500).json({ error: 'Script error: ' + out.slice(0,200) }); }
  });
});
app.get('/metrics', (req, res) => {
    res.sendFile(new URL('./metrics.html', import.meta.url).pathname);
});
// ═══════════════════════════════════════════════════════════════════════════
// METRICS API — Add these routes to server.js before the catch-all route
// ═══════════════════════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────────────────────
function monthKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildMonthBuckets(n = 12) {
  const buckets = {};
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets[key] = 0;
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


// ── Metrics cache — 15 minute TTL ──────────────────────────────────────────
let _metricsCache = null;
let _metricsCacheTime = 0;
const METRICS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

app.get('/api/metrics/refresh', (req, res) => {
  _metricsCache = null;
  _metricsCacheTime = 0;
  res.json({ cleared: true, message: 'Cache cleared — next /api/metrics call will re-fetch live data' });
});

// ── GET /api/metrics ────────────────────────────────────────────────────────
async function buildMetricsData() {
    const fetchStart = Date.now();
    const TMK = thisMonthKey();
    const now = new Date();

    // ── 1-4. PARALLEL FETCH — all Rentvine data at once ─────────────────
    // Run all fetches concurrently instead of sequentially for 3-4x speedup
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

    // Fire Rentvine fetches in parallel — fetch ALL leases in one call, filter client-side
    // The primaryLeaseStatusIDs filter is unreliable; client-side filter is more accurate
    // FETCH STRATEGY (based on confirmed Rentvine behavior):
    // - Unfiltered lease export returns status=6 (closed) leases first, so active leases
    //   never appear in page 1-5. Cannot use unfiltered export for active leases.
    // - primaryLeaseStatusIDs[]=1 filter returns only ~8 records (API limitation)
    // - SOLUTION: derive active leases from UNITS (each occupied unit has leaseID)
    //   then fetch closed leases separately for move-out history
    // - status=6 = vacated, has moveOutDate populated (confirmed from debug)
    // - status=2 = past/expired, moveOutDate=null, use endDate

    // CONFIRMED from Rentvine API docs:
    // /leases/export — bulk endpoint, returns {lease:{...}, unit:{...}}
    // primaryLeaseStatusID: 1=Pending, 2=Active, 3=Closed
    // moveOutDate, moveOutTenantReason, closedDate all on the lease object
    //
    // Fetch active (status 2) and closed (status 3) separately in parallel
    // so closed leases don't crowd out active ones in pagination

    const [allProps, allUnits, activeLeasesRaw, closedLeasesRaw, allPropsList] = await Promise.all([
      fetchAllPages('/properties/export', { isActive: true }, 5), // active properties, 5 pages
      fetchAllPages('/properties/units/export', { isActive: true }, 5), // active units only, 5 pages
      fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 2 }, 5), // Active
      fetchAllPages('/leases/export', { 'primaryLeaseStatusIDs[]': 3 }, 8), // Closed
      fetchAllPages('/properties', { isActive: true }, 5), // for dateContractBegins
    ]);

    // Build a map of propertyID -> dateContractBegins from the list endpoint
    const propContractDatesMap = {};
    allPropsList.forEach(p => {
      if (p.propertyID && p.dateContractBegins) {
        propContractDatesMap[String(p.propertyID)] = p.dateContractBegins;
      }
    });
    const propContractBeginsCount = Object.keys(propContractDatesMap).length;
    console.log('Properties with dateContractBegins:', propContractBeginsCount, 'of', allPropsList.length);
    if (propContractBeginsCount === 0) {
      console.log('dateContractBegins not populated in Rentvine — using dateTimeCreated for properties added chart');
    }

    // /leases/export nests data under .lease — unwrap for easy access
    const unwrap = items => items.map(item => {
      const l = item.lease || item;
      l._unit = item.unit || {};
      l._property = item.property || {};
      return l;
    });

    const activeLeases = unwrap(activeLeasesRaw);
    const closedLeases = unwrap(closedLeasesRaw);
    const allLeases = [...activeLeases, ...closedLeases];

    console.log('Metrics fetch: ' + allProps.length + ' props, ' + allUnits.length + ' units, ' +
      activeLeases.length + ' active(status2), ' + closedLeases.length + ' closed(status3)');

    if (activeLeases.length > 0) {
      const raw = activeLeasesRaw[0];
      const s = activeLeases[0];
      console.log('Raw active item keys:', Object.keys(raw).join(', '));
      console.log('Raw active lease keys:', raw.lease ? Object.keys(raw.lease).join(', ') : 'NO .lease');
      console.log('Active unwrapped: leaseID=' + s.leaseID + ' moveInDate=' + s.moveInDate +
        ' endDate=' + s.endDate + ' primaryLeaseStatusID=' + s.primaryLeaseStatusID);
    }
    if (closedLeases.length > 0) {
      const raw = closedLeasesRaw[0];
      const s = closedLeases[0];
      console.log('Raw closed item keys:', Object.keys(raw).join(', '));
      console.log('Closed unwrapped: moveOutDate=' + s.moveOutDate + ' closedDate=' + s.closedDate +
        ' primaryLeaseStatusID=' + s.primaryLeaseStatusID);
    }

    const activeProps = allProps.filter(item => {
      const p = item.property || item;
      return p.isActive === '1' || p.isActive === 1 || p.isActive === true;
    });

    const propGainedMTD = allProps.filter(item => {
      const p = item.property || item;
      // dateContractBegins from /properties list endpoint = when management started
      // This correctly handles one owner with multiple properties (each gets its own date)
      const contractBegins = propContractDatesMap[String(p.propertyID)] || p.dateContractBegins;
      const dateAdded = contractBegins || p.dateTimeCreated;
      return monthKey(dateAdded) === TMK;
    }).length;

    // Log property fields to see what date fields exist
    if (allProps.length > 0) {
      const sp = allProps[0].property || allProps[0];
      console.log('Property fields:', Object.keys(sp).join(', '));
      console.log('Property date sample:', sp.dateTimeCreated, sp.dateContractBegins, sp.startDate, sp.createdAt);
    }
    const propGainedByMonth = buildMonthBuckets(24);
    allProps.forEach(item => {
      const p = item.property || item;
      // Try every possible date field for when property was added
      // Use dateContractBegins from /properties list (not available on export)
      const contractBegins = propContractDatesMap[String(p.propertyID)] || p.dateContractBegins;
      const dateAdded = contractBegins || p.dateTimeCreated;
      const k = monthKey(dateAdded);
      if (k && propGainedByMonth[k] !== undefined) propGainedByMonth[k]++;
    });

    // Filter to active managed units only
    // All fetched units are already filtered isActive=true from the export
    // isVacant can be boolean true/false or string '1'/'0' depending on API version
    const isUnitActive = u => u.isActive === true || u.isActive === 1 || u.isActive === '1' || u.isActive === 'true';
    const isUnitVacant = u => u.isVacant === true || u.isVacant === 1 || u.isVacant === '1' || u.isVacant === 'true';

    const activeUnits = allUnits.filter(item => isUnitActive(item.unit || item));
    const totalUnits = activeUnits.length;

    const vacantUnitCount = activeUnits.filter(item => isUnitVacant(item.unit || item)).length;
    const occupiedUnitCount = totalUnits - vacantUnitCount;
    const occupiedUnits = occupiedUnitCount;
    const vacantUnits = vacantUnitCount;
    const occupancyRate = totalUnits > 0 ? +((occupiedUnits / totalUnits) * 100).toFixed(1) : 0;
    console.log('Metrics occupancy: ' + occupiedUnits + ' occupied / ' + totalUnits + ' total = ' + occupancyRate + '%');
    console.log('Units sample isActive/isVacant types:', typeof (allUnits[0]&&(allUnits[0].unit||allUnits[0]).isActive), typeof (allUnits[0]&&(allUnits[0].unit||allUnits[0]).isVacant));

    // Avg rent from unit records (rent field confirmed on unit export)
    const rents = activeUnits
      .filter(item => { const u = item.unit||item; return u.isVacant==='0'||u.isVacant===0||u.isVacant===false; })
      .map(item => { const u = item.unit||item; return parseFloat(u.rent||u.marketRent||0); })
      .filter(r => r > 0);
    const avgRent = rents.length ? Math.round(rents.reduce((a, b) => a + b, 0) / rents.length) : 0;
    const vacancyLoss = vacantUnits * avgRent;
    console.log('Metrics avg rent: $' + avgRent + ' from ' + rents.length + ' units, vacancy loss: $' + vacancyLoss);

    // Build set of active unit IDs for move-out filtering
    const activeUnitIDs = new Set(
      activeUnits.map(item => String((item.unit || item).unitID)).filter(Boolean)
    );

    // Build maps for pre-tenancy detection
    // propsWithMoveIn = had a real tenant (moveInDate set on any lease)
    // propsWithLeaseNoMoveIn = closed lease but moveInDate is null = tenant never moved in
    const propsWithMoveIn = new Set();
    const propsWithLeaseNoMoveIn = new Map(); // propertyID -> closeDate

    closedLeases.forEach(l => {
      if (!l.propertyID) return;
      if (l.moveInDate) {
        propsWithMoveIn.add(String(l.propertyID));
      } else {
        const closeDate = l.moveOutDate || l.expectedMoveOutDate || l.endDate || '';
        const existing = propsWithLeaseNoMoveIn.get(String(l.propertyID));
        if (!existing || closeDate > existing) propsWithLeaseNoMoveIn.set(String(l.propertyID), closeDate);
      }
    });
    activeLeases.forEach(l => { if (l.propertyID) propsWithMoveIn.add(String(l.propertyID)); });

    // Pre-tenancy cancellations:
    // Inactive property where no real tenant ever moved in
    const preTenancyCancellations = [];
    const preTenancyByMonth = buildMonthBuckets(24);
    let preTenancyMTD = 0;
    allProps.forEach(item => {
      const p = item.property || item;
      const isActive = p.isActive === true || p.isActive === 1 || p.isActive === '1';
      if (isActive) return;
      if (propsWithMoveIn.has(String(p.propertyID))) return; // had real tenants
      // Inactive + no real tenant = pre-tenancy cancel
      const contractBegins = propContractDatesMap[String(p.propertyID)] || p.dateContractBegins || p.dateTimeCreated;
      const leaseCloseDate = propsWithLeaseNoMoveIn.get(String(p.propertyID)) || '';
      const cancelDate = p.dateContractEnds || leaseCloseDate || p.dateTimeModified || '';
      if (!cancelDate) return;
      const ek = monthKey(cancelDate);
      if (ek && preTenancyByMonth[ek] !== undefined) preTenancyByMonth[ek]++;
      if (ek === TMK) preTenancyMTD++;
      preTenancyCancellations.push({ address: p.address||'', city: p.city||'', dateContractBegins: contractBegins, dateContractEnds: cancelDate, monthKey: ek });
    });
    preTenancyCancellations.sort((a,b) => (b.dateContractEnds||'').localeCompare(a.dateContractEnds||''));
    console.log('Pre-tenancy cancellations:', preTenancyCancellations.length, 'this month:', preTenancyMTD);
    if (preTenancyCancellations.length > 0) console.log('Sample:', preTenancyCancellations[0].address, preTenancyCancellations[0].dateContractEnds);

    // ── Move-ins / outs / expirations by month ────────────────────────────
    // Use 24 months to capture full prior year + current year
    const moveInsByMonth = buildMonthBuckets(24);
    const moveOutsByMonth = buildMonthBuckets(24);
    let moveInsMTD = 0, moveOutsMTD = 0;

    // Move-out reasons from Rentvine lease records
    const moveOutReasons = {};

    if (allLeases.length > 0) {
      const sample = allLeases[0];
      console.log('Lease fields:', Object.keys(sample).join(', '));
      console.log('Vacated sample: moveOutDate=' + closedLeases[0].moveOutDate + ' endDate=' + closedLeases[0].endDate);
    }

    // /leases returns flat objects — item IS the lease directly
    allLeases.forEach(item => {
      const l = item;

      // Move-in date: when tenant actually moved in
      const mi = l.moveInDate || l.startDate;
      const mk = monthKey(mi);
      if (mk && moveInsByMonth[mk] !== undefined) moveInsByMonth[mk]++;
      if (mk === TMK) moveInsMTD++;

      // ── MOVE-OUTS ─────────────────────────────────────────────────────────
      // primaryLeaseStatusID: 1=Pending, 2=Active, 3=Closed (confirmed from API docs)
      const primaryStatusId = parseInt(l.primaryLeaseStatusID || 0);
      const isPastLease = primaryStatusId === 3; // Closed

      if (isPastLease) {
        // Move-out date logic:
        // 1. Prefer expectedMoveOutDate — set by team when processing a real tenant move-out
        // 2. Fall back to moveOutDate ONLY if unit is still active (not a lost/offboarded property)
        //    Lost properties have moveOutDate but no expectedMoveOutDate and unit becomes inactive
        const unitStillActive = activeUnitIDs.has(String(l.unitID));
        const moveOutDate = l.expectedMoveOutDate ||
          (l.moveOutDate && unitStillActive ? l.moveOutDate : null);
        const mok = monthKey(moveOutDate);
        if (moveOutDate && mok) {
          if (moveOutsByMonth[mok] !== undefined) moveOutsByMonth[mok]++;
          if (mok === TMK) moveOutsMTD++;
        }
      }

      // Expirations = active leases whose END DATE (contract) falls in a future month
      // Use endDate for this (lease contract expiry, not actual move-out)
      const endDate = l.endDate || l.leaseEndDate;
      const endMok = monthKey(endDate);
      // Expirations now come from Aptly Tenant Renewals board above
      // (old lease endDate expiration loop removed)

      // Move-out reason
      const reasonStatusId = parseInt(l.primaryLeaseStatusID || 0);
      if (reasonStatusId === 3) { // Closed leases only
        const reason = l.moveOutTenantReason || l.moveOutReason || l.vacateReason || '';
        if (reason) moveOutReasons[reason] = (moveOutReasons[reason] || 0) + 1;
      }
    });

    const nonZeroMoveOuts = Object.fromEntries(Object.entries(moveOutsByMonth).filter(([,v])=>v>0));
    console.log(`Metrics move-outs by month: ${JSON.stringify(nonZeroMoveOuts)} (from ${closedLeases.length} closed leases)`);
    // Sample a few closed leases to confirm field values


    // Upcoming expirations (next 90 days) — from active leases only
    const in90 = new Date(); in90.setDate(in90.getDate() + 90);
    // upcomingExpirations already computed from Tenant Renewals board above

    // Avg days to lease: from listing date to moveInDate
    // Use availabilityDate on units vs moveInDate on leases
    const daysToLeaseArr = [];
    allLeases.forEach(item => {
      const l = item; // flat from /leases
      const mi = l.moveInDate;
      const listed = l.listingDate || l.marketingDate || l.availabilityDate;
      if (mi && listed) {
        const days = daysAgo(listed, new Date(mi));
        if (days !== null && days >= 0 && days < 365) daysToLeaseArr.push(days);
      }
    });
    const avgDaysToLease = daysToLeaseArr.length
      ? Math.round(daysToLeaseArr.reduce((a, b) => a + b, 0) / daysToLeaseArr.length)
      : null;

    // ── 3–8. PARALLEL FETCH — all Aptly boards at once ──────────────────
    // Direct Aptly fetch using x-token — unitsFetch strips fields, must use raw fetch
    const APTLY_BASE = 'https://core-api.getaptly.com';
    const APTLY_TOKEN = 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';

    async function fetchAptlyBoard(boardId, opts = {}) {
      let all = [], pg = 0;
      const max = opts.maxPages || 5;
      const extraParams = opts.params || {};
      while (pg < max) {
        const params = new URLSearchParams({ page: pg, pageSize: 100, ...extraParams });
        const resp = await fetch(APTLY_BASE + '/api/board/' + boardId + '?' + params.toString(), {
          headers: { 'x-token': APTLY_TOKEN }
        });
        if (!resp.ok) break;
        const batch = await resp.json();
        const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
        if (items.length === 0) break;
        all = all.concat(items);
        if (items.length < 100) break;
        pg++;
      }
      return all;
    }

    // Fetch schemas first to map UUID field keys to human-readable names
    async function fetchAptlySchema(boardId) {
      try {
        const resp = await fetch(APTLY_BASE + '/api/schema/' + boardId, {
          headers: { 'x-token': APTLY_TOKEN }
        });
        if (!resp.ok) return {};
        const fields = await resp.json();
        const map = {};
        if (Array.isArray(fields)) fields.forEach(f => { map[f.key] = f.label; });
        return map;
      } catch(e) { return {}; }
    }

    // Helper: resolve UUID field keys using schema map
    function resolveFields(card, schemaMap) {
      const resolved = Object.assign({}, card);
      Object.keys(schemaMap).forEach(uuid => {
        if (uuid in card) {
          resolved[schemaMap[uuid]] = card[uuid];
        }
      });
      return resolved;
    }

    // Fetch schemas for boards that have custom UUID fields
    const [offboardSchema, pmaSchema, renewalSchema] = await Promise.all([
      fetchAptlySchema('BaMiriNFDZBtWd5rR'),
      fetchAptlySchema('QySZ8yRWJ5KeYFcZt'),
      fetchAptlySchema('86YrLPbwdkxtdyZoj'),
    ]);
    console.log('Offboard schema keys:', Object.values(offboardSchema).join(', '));
    console.log('PMA schema keys:', Object.values(pmaSchema).join(', '));

    // Fire all Aptly board fetches simultaneously
    const [allApps, unitsCards, allLeadsRaw, allPMARaw, allOffboardRaw, allMoveOuts, allWOsRaw, allRenewalsRaw] = await Promise.all([
      fetchAptlyBoard('MJxaStgENouWrNEKd', { maxPages: 10, params: { includeArchived: true } }), // applications - 961 total
      getUnitsCards(),
      fetchAptlyBoard('4EMDSYKirhQaNdQKz', { maxPages: 2, params: { includeArchived: false } }),
      fetchAptlyBoard('QySZ8yRWJ5KeYFcZt', { maxPages: 15, params: { includeArchived: true } }), // Owner Pipeline — 15 pages to get full lost history
      fetchAptlyBoard('BaMiriNFDZBtWd5rR', { maxPages: 2, params: { includeArchived: true } }),
      fetchAptlyBoard('YA3QWmPebvMwLwbB3', { maxPages: 2, params: { includeArchived: true } }),
      fetchAptlyBoard('workOrder', { maxPages: 2, params: { includeArchived: false } }),
      fetchAptlyBoard('86YrLPbwdkxtdyZoj', { maxPages: 5, params: { includeArchived: true } }),
    ]);

    // Resolve UUID field keys using schemas
    const allPMA = allPMARaw.map(c => resolveFields(c, pmaSchema));
    const allOffboard = allOffboardRaw.map(c => resolveFields(c, offboardSchema));
    const allRenewals = allRenewalsRaw.map(c => resolveFields(c, renewalSchema));

    const allWOs = allWOsRaw.filter(c => !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''));
    console.log(`Metrics Aptly fetch: ${allApps.length} apps, ${allLeadsRaw.length} leads, ${allPMA.length} PMA, ${allOffboard.length} offboard, ${allMoveOuts.length} moveouts, ${allWOs.length} WOs`);

    // ── Expirations from Aptly Tenant Renewals board ─────────────────────────
    // "Mirror End Date" = lease expiration date on each renewal card
    const expirationsByMonth = buildMonthBuckets(24);
    let upcomingExpirations = 0;
    const renewalCardDetails = [];

    // Debug first card to see actual field names
    if (allRenewals.length > 0) {
      const sample = allRenewals[0];
      const mirrorEndDate = sample['Mirror End Date'];
      const titleDate = (sample.Title || '').slice(0, 10);
      console.log('Renewal card fields:', Object.keys(sample).filter(k => k.toLowerCase().includes('end') || k.toLowerCase().includes('date') || k.toLowerCase().includes('mirror') || k === 'Title' || k === 'Stage').join(', '));
      console.log('Renewal sample: Title=' + sample.Title + ' MirrorEndDate=' + mirrorEndDate + ' Stage=' + sample.Stage + ' IsWon=' + sample['Is Won'] + ' Archived=' + sample.Archived);
    }

    allRenewals.forEach(card => {
      // Try Mirror End Date first, fall back to parsing the Title date (format: MM/DD/YYYY address)
      // "Mirror End Date" is a custom field resolved via schema
      // Also try Title parsing as fallback (format: MM/DD/YYYY address)
      let endDate = card['Mirror End Date'];
      if (!endDate && card.Title) {
        const m = card.Title.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
        if (m) endDate = m[3] + '-' + m[1] + '-' + m[2];
      }
      if (!endDate) return;
      const ek = monthKey(endDate);
      const endDateObj = new Date(endDate);
      if (ek && expirationsByMonth[ek] !== undefined) expirationsByMonth[ek]++;
      if (endDateObj >= now && endDateObj <= in90 && !card['Is Won']) upcomingExpirations++;
      const addr = card['Mirror Address'] ? card['Mirror Address'].address : '';
      const city = card['Mirror Address'] ? card['Mirror Address'].city : '';
      const rent = card['Mirror Rent'] ? parseFloat(card['Mirror Rent'].amount || 0) : 0;
      const residents = Array.isArray(card.Resident)
        ? card.Resident.map(r => r.name).join(', ') : (card.Resident || '');
      if (ek) renewalCardDetails.push({
        address: addr, city, tenant: residents, endDate,
        monthKey: ek, rent, stage: card.Stage || '',
        isWon: card['Is Won'] || false,
      });
    });
    console.log('Renewals board: ' + allRenewals.length + ' cards, ' + upcomingExpirations + ' expiring in 90d, ' + renewalCardDetails.length + ' with dates');

    // Keep old expiration loop for reference but don't overwrite expirationsByMonth
    if (allApps.length > 0) console.log('App stages:', [...new Set(allApps.slice(0,30).map(c=>c.stage||'?'))].join(', '));
    if (allPMA.length > 0) console.log('PMA stages:', [...new Set(allPMA.slice(0,30).map(c=>c.stage||'?'))].join(', '));
    if (allLeadsRaw.length > 0) console.log('Lead keys:', Object.keys(allLeadsRaw[0]).join(', '));

    // Applications — use Status.uuid for accurate status bucketing
    // Confirmed from live data: Status = {uuid: "app-incomplete", status: "All Applications Incomplete"}
    const appsByMonth = buildMonthBuckets(24);
    const appsApprovedByMonth = buildMonthBuckets(24);
    const appsDeniedByMonth = buildMonthBuckets(24);
    const appsCancelledByMonth = buildMonthBuckets(24);
    let appsMTD = 0, appsApprovedMTD = 0, appsDeniedMTD = 0, appsCancelledMTD = 0;
    const appStatusCounts = {};
    let appRevenueMTD = 0;
    const appRevenueByMonth = buildMonthBuckets(24);
    const approvedToMoveInDays = [];
    const appDecisionHours = [];

    allApps.forEach(card => {
      // Confirmed: appCreated = Application Created date
      const createdDate = card.appCreated || card['Application Created'] || card.createdAt;
      const k = monthKey(createdDate);
      if (k && appsByMonth[k] !== undefined) appsByMonth[k]++;
      if (k === TMK) appsMTD++;

      // Confirmed field names from live logs: appStatus = {uuid, status}
      const statusObj = card.appStatus || card.Status || {};
      const statusUuid = statusObj.uuid || '';
      const statusLabel = statusObj.status || '';
      if (statusLabel) appStatusCounts[statusLabel] = (appStatusCounts[statusLabel] || 0) + 1;

      // Status UUIDs: confirmed from live logs include "application-closed", "app-approved" etc.
      const isApproved = statusUuid.includes('approved') || card.appStatusIsApproved === true;
      const isDenied = statusUuid.includes('denied');
      const isClosed = statusUuid.includes('closed') || statusUuid.includes('cancelled') ||
                       statusUuid.includes('archived') || card.appCancelled === true;

      if (isApproved) {
        if (k && appsApprovedByMonth[k] !== undefined) appsApprovedByMonth[k]++;
        if (k === TMK) appsApprovedMTD++;
        const moveIn = card.appMoveInDate;
        if (moveIn && createdDate) {
          const days = Math.round((new Date(moveIn) - new Date(createdDate)) / 86400000);
          if (days > 0 && days < 365) approvedToMoveInDays.push(days);
        }
      } else if (isDenied) {
        if (k && appsDeniedByMonth[k] !== undefined) appsDeniedByMonth[k]++;
        if (k === TMK) appsDeniedMTD++;
      } else if (isClosed) {
        if (k && appsCancelledByMonth[k] !== undefined) appsCancelledByMonth[k]++;
        if (k === TMK) appsCancelledMTD++;
      }

      // Avg Time for Decision: appCreated -> appStatusUpdatedAt (when status changed)
      const appStatusUpdatedAt = card.appStatusUpdatedAt;
      if (appStatusUpdatedAt && createdDate && (isApproved || isDenied)) {
        const hrs = Math.round((new Date(appStatusUpdatedAt) - new Date(createdDate)) / 3600000 * 10) / 10;
        if (hrs >= 0 && hrs < 8760) appDecisionHours.push(hrs);
      }


      // Confirmed: appPayments array, amount.amount = cents (6500 = $65)
      const payments = card.appPayments || [];
      if (Array.isArray(payments)) {
        payments.forEach(p => {
          const amt = p.amount ? parseFloat(p.amount.amount || 0) / 100 : 0;
          if (amt > 0) {
            if (k && appRevenueByMonth[k] !== undefined) appRevenueByMonth[k] += amt;
            if (k === TMK) appRevenueMTD += amt;
          }
        });
      }
    });

    const avgApprovedToMoveIn = approvedToMoveInDays.length
      ? Math.round(approvedToMoveInDays.reduce((a,b)=>a+b,0)/approvedToMoveInDays.length) : null;
    const avgDecisionHours = appDecisionHours.length
      ? Math.round(appDecisionHours.reduce((a,b)=>a+b,0)/appDecisionHours.length * 10) / 10 : null;
    // appInputCompleted = "All Applicants" when all have completed
    const completedCount = allApps.filter(c => c.appInputCompleted === 'All Applicants').length;
    const completionRate = allApps.length > 0 ? Math.round((completedCount/allApps.length)*10000)/100 : 0;
    if (allApps.length > 0) {
      const s = allApps[0];
      console.log('App all keys:', Object.keys(s).join(', '));
      console.log('App Status:', JSON.stringify(s.Status || s.status || s.appStatus));
      console.log('App Created:', s['Application Created'] || s.appCreated || s.createdAt);
      console.log('App appCreated:', s.appCreated, '| appInputCompleted:', s.appInputCompleted, '| appPaymentMade:', s.appPaymentMade);
      // Payment structure confirmed: appPayments[].amount.amount = cents (/100 = dollars)
      console.log('App CompletedAt:', s['Application Completed At'] || s.appCompletedAt);
    }


    // ── 4. Process Aptly data (already fetched in parallel above) ──────
    const publishedListings = unitsCards.filter(c =>
      c['Published For Rent'] === 'checked' || c['Published For Rent'] === true ||
      c['Syndicate'] === 'checked'
    );

    // Days on market per listing
    const nowMs = Date.now();
    const listings45 = publishedListings.filter(c => {
      const d = c['Available Date'] || c['Stage Changed'] || c['Created At'] || '';
      if (!d) return false;
      return (nowMs - new Date(d).getTime()) > 45 * 86400000;
    }).length;

    const listings90 = publishedListings.filter(c => {
      const d = c['Available Date'] || c['Stage Changed'] || c['Created At'] || '';
      if (!d) return false;
      return (nowMs - new Date(d).getTime()) > 90 * 86400000;
    }).length;

    // Keyless deadbolts — from Aptly leads data: Mirror Lockbox Type = "Keyless Deadbolt"
    const keylessUnits = new Set();
    allLeadsRaw.forEach(card => {
      const lockboxType = card['Mirror Lockbox Type'] || card.mirrorLockboxType || '';
      if (/keyless deadbolt/i.test(lockboxType)) {
        const addr = card['Mirror Address'] || card['Preferred Rental'] || card.Unit || '';
        if (addr) keylessUnits.add(addr.split(',')[0].trim().toLowerCase());
      }
    });

    // ── Owner Pipeline — all data from Aptly Owner Pipeline board ──────────
    // Board: QySZ8yRWJ5KeYFcZt
    // Confirmed field names from live data:
    //   Created At = when lead entered pipeline (use for new leads per month)
    //   Source = lead source string (e.g. "Property Manager Websites", "Facebook/Social Media")
    //   Stage = "PMA Signed", "Lost", "Not Valid Lead", "Engaged", etc.
    //   Is Won = boolean (true when PMA Signed)
    //   Archived = boolean
    //   Lost Reason = custom field for why lead was lost (need to confirm exact key)

    // 1. New leads per month — use Created At on ALL cards (active + archived)
    // New leads = every card by Created At date (when lead entered pipeline)
    const newLeadsByMonth = buildMonthBuckets(24);
    let newLeadsMTD = 0;
    // leadSources moved to renterLeadSources below

    allPMA.forEach(card => {
      const k = monthKey(card.createdAt);
      if (k && newLeadsByMonth[k] !== undefined) newLeadsByMonth[k]++;
      if (k === TMK) newLeadsMTD++;
    });

    // Renter lead sources — from Renter Leads board (prospective tenants)
    const renterLeadSources = {};
    allLeadsRaw.forEach(card => {
      const src = card.leadSource || '';
      if (src) renterLeadSources[src] = (renterLeadSources[src] || 0) + 1;
    });
    console.log('Owner pipeline leads:', allPMA.length, '| Renter lead sources:', JSON.stringify(renterLeadSources));

    // 3. PMA Signed — stage === "PMA Signed" (active OR archived)
    //    Use "Management Start Date" or "Date Contract Begins" for the month
    //    Fall back to Stage Changed date, then Created At
    const pmaSignedByMonth = buildMonthBuckets(24);
    let pmaSignedMTD = 0;

    // Log a sample PMA Signed card to find the management start date field
    const allPMAStages = [...new Set(allPMA.map(c=>c.stage||'?'))];
    console.log('All PMA stages (' + allPMA.length + '):', allPMAStages.join(' | '));
    const pmaSigned = allPMA.filter(c => (c.stage || c.Stage || '') === 'PMA Signed');
    if (pmaSigned.length > 0) {
      const s = pmaSigned[0];
      console.log('PMA Signed sample fields:', Object.keys(s).join(', '));
      console.log('PMA Signed sample stageUpdatedAt:', s.stageUpdatedAt, 'createdAt:', s.createdAt);
    }
    console.log('Total PMA Signed cards:', pmaSigned.length);

    pmaSigned.forEach(card => {
      // Management start date: prefer explicit date field, fall back to Stage Changed
      // (Stage Changed = when card moved to "PMA Signed" stage = effectively when signed)
      // stageUpdatedAt = when card moved to "PMA Signed" stage = actual sign date
      // Management Start Date = planned future start date — NOT when they signed
      const signedDate = card.stageUpdatedAt || card.createdAt;
      if (pmaSigned.indexOf(card) === 0) {
        console.log('PMA Signed card - stageUpdatedAt:', card.stageUpdatedAt, 'Management Start Date:', card['Management Start Date']);
      }
      const sk = monthKey(signedDate);
      if (sk && pmaSignedByMonth[sk] !== undefined) pmaSignedByMonth[sk]++;
      if (sk === TMK) pmaSignedMTD++;
    });

    // 4. Lost leads — stage === "Lost" (active or archived)
    //    Use Lost Reason field for breakdown
    const lostByMonth = buildMonthBuckets(48); // Lost leads go back further than 24 months
    const lostReasons = {};
    let lostMTD = 0;

    // Lost leads: stage === "Lost" (active or archived)
    // Stage Changed = when they moved to Lost = when we lost the lead
    // Confirmed from live data: "Lost" is the exact stage name for lost leads
    // "Not Valid Lead" = unqualified, NOT the same as lost
    const lostCards = allPMA.filter(c => (c.stage || c.Stage || '') === 'Lost');
    console.log('Lost cards:', lostCards.length);
    lostCards.forEach(card => {
      // stageUpdatedAt = when card was moved to Lost stage
      const k = monthKey(card.stageUpdatedAt || card.createdAt);
      if (k && lostByMonth[k] !== undefined) lostByMonth[k]++;
      if (k === TMK) lostMTD++;
      // Both lostReason (camelCase) and "Lost Reason" (schema-resolved) may exist
      const reason = card['Lost Reason'] || card.lostReason || '';
      if (reason) lostReasons[reason] = (lostReasons[reason] || 0) + 1;
    });
    if (lostCards.length > 0) {
      const s = lostCards[0];
      console.log('Lost card fields:', Object.keys(s).filter(k => k.includes('lost') || k.includes('Lost') || k === 'Stage').join(', '));
      console.log('Lost sample: Stage=' + s.stage + ' Reason=' + (s.lostReason || s['Lost Reason'] || 'not found'));
    }
    console.log('Total Lost cards:', lostCards.length, '| PMA Signed:', pmaSigned.length);

    // ── 6. End Management — from Aptly Offboard board ──────────────────────
    // Field: "Mirror Date Contract Ends" (schema-resolved from UUID)
    // Field: "Reason" (schema-resolved from UUID)
    // DEDUPLICATION: same property can have multiple cards (New/In Progress/Done)
    // Only count each unique property title once per month
    const endMgmtByMonth = buildMonthBuckets(24);
    const endMgmtReasons = {};
    let endMgmtMTD = 0;
    const seenEndMgmt = new Set();

    allOffboard.forEach(card => {
      const contractEnd = card['Mirror Date Contract Ends'];
      if (!contractEnd) return;
      const ek = monthKey(contractEnd);
      const title = (card.Title || card.name || '').trim();
      // Normalize title to street number only for dedup
      // "40765 West Haley Drive" and "40765 W Haley" = same property
      const streetNum = title.match(/^(\d+)/)?.[1] || title;
      const dedupKey = streetNum + '|' + ek;
      if (seenEndMgmt.has(dedupKey)) return; // skip duplicate
      seenEndMgmt.add(dedupKey);
      if (ek && endMgmtByMonth[ek] !== undefined) endMgmtByMonth[ek]++;
      if (ek === TMK) endMgmtMTD++;
      const reason = card['Reason'] || '';
      if (reason) endMgmtReasons[reason] = (endMgmtReasons[reason] || 0) + 1;
    });

    // Needs updated agreement: active Rentvine properties with past dateContractEnds
    const needsUpdatedAgreement = [];
    allProps.forEach(item => {
      const p = item.property || item;
      const contractEnd = p.dateContractEnds;
      if (!contractEnd) return;
      const endObj = new Date(contractEnd);
      const isActive = p.isActive === true || p.isActive === 1 || p.isActive === '1';
      if (endObj <= now && isActive) {
        needsUpdatedAgreement.push({
          address: p.address || '',
          city: p.city || '',
          dateContractEnds: contractEnd,
        });
      }
    });

    console.log('End mgmt: ' + seenEndMgmt.size + ' unique props, ' + endMgmtMTD + ' this month, ' + needsUpdatedAgreement.length + ' need updated agreement');
    if (allOffboard.length > 0) {
      const s = allOffboard[0];
      console.log('Offboard sample: Title=' + (s.Title||s.name) + ' contractEnd=' + s['Mirror Date Contract Ends'] + ' Reason=' + s['Reason']);
    }

    // ── 7. Move-Outs Board (fetched above in parallel) ────────────────────
    let comprehensiveInspYes = 0, comprehensiveInspNo = 0;
    allMoveOuts.forEach(card => {
      // Confirmed from live Aptly data: field is "Comprehensive Inspection" (plain string)
      // Values seen: "Yes" — checking for Yes/No case-insensitively
      const val = String(card['Comprehensive Inspection'] || '').trim().toLowerCase();
      if (val === 'yes') comprehensiveInspYes++;
      else if (val === 'no') comprehensiveInspNo++;
    });

    // ── 8. Work Orders (fetched above in parallel) ────────────────────────
    const woByStage = {};
    allWOs.forEach(c => {
      const s = c.stage || 'Unknown';
      woByStage[s] = (woByStage[s] || 0) + 1;
    });

    const unassignedWOs = allWOs.filter(c => {
      const v = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
      return v.length === 0;
    }).length;

    // ── 9. Lease Renewals — from Aptly Tenant Renewals board ────────────────
    // Already computed above in expirationsByMonth using allRenewals cards
    // Just use the same data for the renewals tab detail
    const renewalsByMonth = expirationsByMonth; // same data source
    const renewalsDetail = renewalCardDetails.sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

    // ── 10. Vacant units detail list ──────────────────────────────────────
    const vacantUnitsList = activeUnits
      .filter(item => {
        const u = item.unit || item;
        return u.isVacant === '1' || u.isVacant === 1 || u.isVacant === true;
      })
      .map(item => {
        const u = item.unit || item;
        const p2 = item.property || {};
        return {
          address: u.address || p2.address || '—',
          city: u.city || p2.city || '',
          beds: u.bedrooms || u.beds || '',
          baths: u.bathrooms || u.baths || '',
          rent: parseFloat(u.marketRent || u.rent || 0),
        };
      })
      .sort((a, b) => (a.address || '').localeCompare(b.address || ''));

    // ── 11. Active listings detail list ───────────────────────────────────
    const activeListingsList = publishedListings.map(c => {
      const rentRaw = c['Market Rent'] || c['Rent'] || '';
      const rent = rentRaw && typeof rentRaw === 'object' && rentRaw.amount
        ? parseFloat(rentRaw.amount) : parseFloat(String(rentRaw || '0').replace(/[^0-9.]/g, ''));
      const availRaw = c['Available Date'] || '';
      const daysOnMarket = availRaw ? Math.floor((nowMs - new Date(availRaw).getTime()) / 86400000) : null;
      return {
        address: (c.Street || c.Address || c["Marketing Name"] || '—').replace(/^\d{2}\/\d{2}\/\d{4}\s+/, ''),
        city: c.City || '',
        beds: c.Beds || '',
        baths: c.Baths || '',
        rent,
        availableDate: availRaw ? new Date(availRaw).toLocaleDateString('en-US',{month:'numeric',day:'numeric',year:'numeric'}) : '—',
        daysOnMarket,
      };
    }).sort((a, b) => (a.daysOnMarket || 0) - (b.daysOnMarket || 0));

    // ── 12. Property growth trend ──────────────────────────────────────────
    // Use the 24-month propGainedByMonth bucket already computed above
    const propKeys = Object.keys(propGainedByMonth).sort();
    let running = allProps.length; // start from total, work backwards
    const propTrend = propKeys.map(k => ({
      month: k,
      gained: propGainedByMonth[k] || 0,
      total: 0,
    }));
    for (let i = propTrend.length - 1; i >= 0; i--) {
      propTrend[i].total = running;
      running -= propTrend[i].gained;
      if (running < 0) running = 0;
    }

    // ── Build response ────────────────────────────────────────────────────
    const formatTrend = (obj) => Object.entries(obj).sort().map(([month, value]) => ({ month, value }));

    const responseData = {
      generatedAt: new Date().toISOString(),
      thisMonth: TMK,

      // Portfolio
      portfolio: {
        activeProperties: allProps.filter(i => {
          const p = i.property||i;
          return p.isActive === true || p.isActive === 1 || p.isActive === '1';
        }).length,
        totalUnits,
        occupiedUnits,
        vacantUnits,
        occupancyRate,
        avgRent,
        vacancyLoss,
        gainedMTD: propGainedMTD,
        preTenancyCancellations,
        preTenancyCancellationCount: preTenancyCancellations.length,
        preTenancyMTD,
        preTenancyByMonth: formatTrend(preTenancyByMonth),
        activeListings: publishedListings.length,
        listingsOver45Days: listings45,
        listingsOver90Days: listings90,
        keylessDeadboltUnits: keylessUnits.size,
        propGainedTrend: formatTrend(propGainedByMonth),
        propTrend,
        vacantUnitsList,
        activeListingsList,
      },

      // Leases / Occupancy
      leases: {
        active: activeLeases.length, // primaryLeaseStatusID=2 (Active)
        moveInsMTD,
        moveOutsMTD,
        upcomingExpirations,
        avgDaysToLease,
        moveInsByMonth: formatTrend(moveInsByMonth),   // 24 months
        moveOutsByMonth: formatTrend(moveOutsByMonth),  // 24 months
        expirationsByMonth: formatTrend(expirationsByMonth), // 24 months from Tenant Renewals board
        moveOutReasons: Object.entries(moveOutReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => ({ reason, count })),
        renewalsByMonth: formatTrend(renewalsByMonth),
        renewalsDetail,
      },

      // Applications
      applications: {
        totalMTD: appsMTD,
        approvedMTD: appsApprovedMTD,
        deniedMTD: appsDeniedMTD,
        cancelledMTD: appsCancelledMTD,
        totalAllTime: allApps.length,
        approvedAllTime: appStatusCounts['Approved'] || 0,
        deniedAllTime: appStatusCounts['Denied'] || 0,
        revenueMTD: Math.round(appRevenueMTD * 100) / 100,
        avgApprovedToMoveIn,
        avgDecisionHours,
        completionRate,
        statusCounts: appStatusCounts,
        byMonth: formatTrend(appsByMonth),
        approvedByMonth: formatTrend(appsApprovedByMonth),
        deniedByMonth: formatTrend(appsDeniedByMonth),
        cancelledByMonth: formatTrend(appsCancelledByMonth),
        revenueByMonth: formatTrend(appRevenueByMonth),
      },

      // Owner Pipeline
      // Owner Pipeline — from Aptly Owner Pipeline board
      pipeline: {
        signedMTD: pmaSignedMTD,
        newLeadsMTD,
        lostMTD,
        signedByMonth: formatTrend(pmaSignedByMonth),
        newLeadsByMonth: formatTrend(newLeadsByMonth),
        lostByMonth: formatTrend(lostByMonth),
        lostReasons: Object.entries(lostReasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count})),
        renterLeadSources: Object.entries(renterLeadSources)
          .sort((a, b) => b[1] - a[1])
          .map(([source, count]) => ({ source, count })),
      },


      // End Management
      endManagement: {
        totalMTD: endMgmtMTD,
        byMonth: formatTrend(endMgmtByMonth),
        needsUpdatedAgreement,
        reasons: Object.entries(endMgmtReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => ({ reason, count })),
      },

      // Comprehensive Inspections
      comprehensiveInspections: {
        yes: comprehensiveInspYes,
        no: comprehensiveInspNo,
        total: comprehensiveInspYes + comprehensiveInspNo,
        optInRate: (comprehensiveInspYes + comprehensiveInspNo) > 0
          ? +((comprehensiveInspYes / (comprehensiveInspYes + comprehensiveInspNo)) * 100).toFixed(1)
          : 0,
      },

      // Work Orders
      workOrders: {
        openTotal: allWOs.length,
        unassigned: unassignedWOs,
        byStage: Object.entries(woByStage)
          .sort((a, b) => b[1] - a[1])
          .map(([stage, count]) => ({ stage, count })),
      },

      // Google Reviews placeholder — manual input for now
      googleReviews: {
        note: 'Connect Google Business Profile API or log manually',
      },
    };

    console.log('Metrics: fetched in', Math.round((Date.now() - fetchStart)/1000), 's');
    return responseData;
}

// ── GET /api/metrics ────────────────────────────────────────────────────────
app.get('/api/metrics', async (req, res) => {
  try {
    // Serve from cache if fresh
    const now_cache = Date.now();
    if (_metricsCache && (now_cache - _metricsCacheTime) < METRICS_CACHE_TTL) {
      console.log('Metrics: cache hit (age:', Math.round((now_cache - _metricsCacheTime)/1000), 's)');
      return res.json(_metricsCache);
    }
    console.log('Metrics: cache miss — fetching live...');
    const data = await buildMetricsData();
    _metricsCache = data;
    _metricsCacheTime = Date.now();
    res.json(data);
  } catch (err) {
    console.error('Metrics API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/metrics/debug-leases ─────────────────────────────────────────
// Shows raw field names and values from /leases endpoint for each status
app.get('/api/metrics/debug-leases', async (req, res) => {
  try {
    // Fetch one page of each status to see raw field names
    const [active, past2, past6] = await Promise.all([
      rvFetch('/leases', { 'primaryLeaseStatusIDs[]': 1, pageSize: 3, page: 1 }),
      rvFetch('/leases', { 'primaryLeaseStatusIDs[]': 2, pageSize: 3, page: 1 }),
      rvFetch('/leases', { 'primaryLeaseStatusIDs[]': 6, pageSize: 3, page: 1 }),
    ]);
    const toArr = x => Array.isArray(x) ? x : (x && x.data ? x.data : (x ? [x] : []));
    const activeArr = toArr(active);
    const past2Arr = toArr(past2);
    const past6Arr = toArr(past6);
    res.json({
      active: {
        count: activeArr.length,
        fields: activeArr.length ? Object.keys(activeArr[0]) : [],
        sample: activeArr.slice(0,2).map(l => ({
          leaseID: l.leaseID, primaryLeaseStatusID: l.primaryLeaseStatusID,
          leaseStatusID: l.leaseStatusID, moveInDate: l.moveInDate,
          endDate: l.endDate, rentAmount: l.rentAmount, rent: l.rent,
        })),
      },
      past2: {
        count: past2Arr.length,
        fields: past2Arr.length ? Object.keys(past2Arr[0]) : [],
        sample: past2Arr.slice(0,2).map(l => ({
          leaseID: l.leaseID, primaryLeaseStatusID: l.primaryLeaseStatusID,
          leaseStatusID: l.leaseStatusID, moveInDate: l.moveInDate,
          moveOutDate: l.moveOutDate, closedDate: l.closedDate, endDate: l.endDate,
        })),
      },
      past6: {
        count: past6Arr.length,
        fields: past6Arr.length ? Object.keys(past6Arr[0]) : [],
        sample: past6Arr.slice(0,2).map(l => ({
          leaseID: l.leaseID, primaryLeaseStatusID: l.primaryLeaseStatusID,
          leaseStatusID: l.leaseStatusID, moveInDate: l.moveInDate,
          moveOutDate: l.moveOutDate, moveOutTenantReason: l.moveOutTenantReason,
          closedDate: l.closedDate, endDate: l.endDate,
        })),
      },
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/metrics/debug-moveouts ────────────────────────────────────────
// Shows raw Rentvine lease data for past/closed leases to verify moveOutDate field
app.get('/api/metrics/debug-moveouts', async (req, res) => {
  try {
    // Fetch CLOSED leases (primaryLeaseStatusID=3) — these are actual move-outs
    let closedLeases = [], pg = 1;
    while (pg <= 10) {
      const batch = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 3, pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      closedLeases = closedLeases.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }
    const unwrapped = closedLeases.map(i => i.lease || i);
    const withExpected = unwrapped.filter(l => !!l.expectedMoveOutDate);
    const withMoveOut = unwrapped.filter(l => !!l.moveOutDate);

    // Group by expectedMoveOutDate (what metrics uses)
    const byExpected = {};
    withExpected.forEach(l => {
      const d = (l.expectedMoveOutDate || '').slice(0, 7);
      if (d) byExpected[d] = (byExpected[d] || 0) + 1;
    });
    const byMoveOut = {};
    withMoveOut.forEach(l => {
      const d = (l.moveOutDate || '').slice(0, 7);
      if (d) byMoveOut[d] = (byMoveOut[d] || 0) + 1;
    });

    // Individual April 2026 leases for verification
    const april = unwrapped.filter(l =>
      (l.expectedMoveOutDate || l.moveOutDate || '').slice(0, 7) === '2026-04'
    ).map(l => ({
      leaseID: l.leaseID,
      tenant: l.tenants,
      expectedMoveOutDate: l.expectedMoveOutDate,
      moveOutDate: l.moveOutDate,
      closedDate: l.closedDate,
      endDate: l.endDate,
    }));

    res.json({
      summary: {
        totalClosedLeases: closedLeases.length,
        withExpectedMoveOutDate: withExpected.length,
        withMoveOutDate: withMoveOut.length,
      },
      byExpectedMoveOutMonth: Object.entries(byExpected).sort().map(([month, count]) => ({ month, count })),
      byMoveOutDateMonth: Object.entries(byMoveOut).sort().map(([month, count]) => ({ month, count })),
      april2026: april,
      sample: unwrapped.slice(0, 3).map(l => ({
        leaseID: l.leaseID,
        tenant: l.tenants,
        primaryLeaseStatusID: l.primaryLeaseStatusID,
        expectedMoveOutDate: l.expectedMoveOutDate,
        moveOutDate: l.moveOutDate,
        closedDate: l.closedDate,
        endDate: l.endDate,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/metrics/debug-units ───────────────────────────────────────────
// Shows exactly what Rentvine returns for units + active leases
// Visit this URL to verify isVacant, isActive field values
app.get('/api/metrics/debug-units', async (req, res) => {
  try {
    // Sample 5 units
    const unitSample = await rvFetch('/properties/units/export', { pageSize: 5, page: 1 });
    const units = Array.isArray(unitSample) ? unitSample : [];

    // Active leases sample
    const leaseSample = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 1, pageSize: 5, page: 1 });
    const activeLeases = Array.isArray(leaseSample) ? leaseSample : [];

    // All leases page 1 sample (no filter)
    const allLeaseSample = await rvFetch('/leases/export', { pageSize: 5, page: 1 });
    const allLeases = Array.isArray(allLeaseSample) ? allLeaseSample : [];

    // Count totals properly
    let allUnits = [], pg = 1;
    while (pg <= 10) {
      const batch = await rvFetch('/properties/units/export', { pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allUnits = allUnits.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }
    const activeCount = allUnits.filter(i => { const u = i.unit||i; return u.isActive==='1'||u.isActive===1||u.isActive===true; }).length;
    const vacantCount = allUnits.filter(i => { const u = i.unit||i; return (u.isActive==='1'||u.isActive===1||u.isActive===true) && (u.isVacant==='1'||u.isVacant===1||u.isVacant===true); }).length;

    let allActive = [], pg2 = 1;
    while (pg2 <= 20) {
      const batch = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 1, pageSize: 200, page: pg2 });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allActive = allActive.concat(batch);
      if (batch.length < 200) break;
      pg2++;
    }

    res.json({
      unitCounts: {
        totalRaw: allUnits.length,
        activeManaged: activeCount,
        vacantByFlag: vacantCount,
        occupiedByFlag: activeCount - vacantCount,
        activeLeaseCount: allActive.length,
        occupancyRateByFlag: activeCount > 0 ? +((( activeCount - vacantCount) / activeCount * 100).toFixed(1)) : 0,
        occupancyRateByLeases: activeCount > 0 ? +((allActive.length / activeCount * 100).toFixed(1)) : 0,
      },
      unitSampleFields: units.slice(0, 3).map(i => {
        const u = i.unit || i;
        return { address: u.address, isActive: u.isActive, isVacant: u.isVacant, unitID: u.unitID, allKeys: Object.keys(u) };
      }),
      activeLeaseSample: activeLeases.slice(0, 2).map(i => {
        const l = i.lease || i;
        const u = i.unit || {};
        return { unitAddress: u.address, unitID: u.unitID, leaseUnitID: l.unitID, leaseStatusID: l.leaseStatusID || l.primaryLeaseStatusID, tenant: l.tenants && l.tenants[0] && l.tenants[0].name, allLeaseKeys: Object.keys(l) };
      }),
      allLeaseSample: allLeases.slice(0, 2).map(i => {
        const l = i.lease || i;
        return { leaseStatusID: l.leaseStatusID || l.primaryLeaseStatusID, moveInDate: l.moveInDate, moveOutDate: l.moveOutDate };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Warm cache on server startup ──────────────────────────────────────────
// Calls buildMetricsData() directly (no HTTP round-trip) so cache is hot
// before the first visitor arrives
setTimeout(async () => {
  try {
    console.log('Metrics: warming cache on startup...');
    const data = await buildMetricsData();
    _metricsCache = data;
    _metricsCacheTime = Date.now();
    console.log('Metrics: cache warmed successfully');
  } catch(e) {
    console.log('Metrics: cache warm failed:', e.message);
  }
}, 8000); // wait 8s for server to fully initialize

// ── GET /api/metrics/debug-pretenancy ─────────────────────────────────────
// Shows inactive properties and their lease history to debug pre-tenancy detection
app.get('/api/metrics/debug-pretenancy', async (req, res) => {
  try {
    // Fetch inactive properties
    const [closedRaw, activeRaw, propsRaw] = await Promise.all([
      rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 3, pageSize: 200, page: 1 }),
      rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 2, pageSize: 200, page: 1 }),
      rvFetch('/properties/export', { isActive: false, pageSize: 100, page: 1 }),
    ]);

    const closed = (Array.isArray(closedRaw) ? closedRaw : []).map(i => i.lease || i);
    const active = (Array.isArray(activeRaw) ? activeRaw : []).map(i => i.lease || i);
    const inactiveProps = (Array.isArray(propsRaw) ? propsRaw : []).map(i => i.property || i);

    // Build moveIn sets
    const propsWithMoveIn = new Set();
    const noMoveIn = {};
    closed.forEach(l => {
      if (!l.propertyID) return;
      if (l.moveInDate) propsWithMoveIn.add(String(l.propertyID));
      else noMoveIn[String(l.propertyID)] = { leaseID: l.leaseID, moveInDate: l.moveInDate, moveOutDate: l.moveOutDate, endDate: l.endDate, closedDate: l.closedDate };
    });
    active.forEach(l => { if (l.propertyID) propsWithMoveIn.add(String(l.propertyID)); });

    // Specific lease lookup
    const lease758 = await rvFetch('/leases/758');

    // Check the specific addresses
    const specific = inactiveProps.filter(p => {
      const a = (p.address || '').toLowerCase();
      return a.includes('66th') || a.includes('197th') || a.includes('jardin') ||
             a.includes('williams') || a.includes('marquez');
    });

    // Classify all inactive props
    const classified = inactiveProps.slice(0, 50).map(p => ({
      propertyID: p.propertyID,
      address: p.address,
      isActive: p.isActive,
      dateContractEnds: p.dateContractEnds,
      hasMoveIn: propsWithMoveIn.has(String(p.propertyID)),
      leaseInfo: noMoveIn[String(p.propertyID)] || null,
      classification: propsWithMoveIn.has(String(p.propertyID)) ? 'had-tenant' :
        (noMoveIn[String(p.propertyID)] ? 'lease-no-movein' : 'no-lease'),
    }));

    res.json({
      inactivePropsTotal: inactiveProps.length,
      propsWithMoveIn: propsWithMoveIn.size,
      propsWithLeaseNoMoveIn: Object.keys(noMoveIn).length,
      lease758: lease758,
      specificAddresses: specific.map(p => ({
        propertyID: p.propertyID, address: p.address, isActive: p.isActive,
        dateContractEnds: p.dateContractEnds,
        hasMoveIn: propsWithMoveIn.has(String(p.propertyID)),
        leaseNoMoveIn: noMoveIn[String(p.propertyID)] || null,
      })),
      sample50: classified,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/metrics/debug-offboard ───────────────────────────────────────
// Shows all offboard cards with their Mirror Date Contract Ends and Reason
app.get('/api/metrics/debug-offboard', async (req, res) => {
  try {
    const APTLY_BASE = 'https://core-api.getaptly.com';
    const APTLY_TOKEN = 'oSWZZYDMlRZjUmnp6qb4yCr3EW3yKRO9Atns2VCANso=';

    // Fetch schema first to resolve UUID keys
    const schemaResp = await fetch(APTLY_BASE + '/api/schema/BaMiriNFDZBtWd5rR', {
      headers: { 'x-token': APTLY_TOKEN }
    });
    const schemaFields = await schemaResp.json();
    const schemaMap = {};
    if (Array.isArray(schemaFields)) schemaFields.forEach(f => { schemaMap[f.key] = f.label; });

    // Fetch all offboard cards (active + archived)
    let all = [], pg = 0;
    while (pg < 5) {
      const params = new URLSearchParams({ page: pg, pageSize: 100, includeArchived: true });
      const resp = await fetch(APTLY_BASE + '/api/board/BaMiriNFDZBtWd5rR?' + params, {
        headers: { 'x-token': APTLY_TOKEN }
      });
      if (!resp.ok) { console.log('Offboard debug fetch failed:', resp.status); break; }
      const batch = await resp.json();
      const items = Array.isArray(batch) ? batch : (batch && batch.data ? batch.data : []);
      console.log('Offboard debug page', pg, ':', items.length, 'items, first keys:', items[0] ? Object.keys(items[0]).slice(0,5).join(',') : 'none');
      if (items.length === 0) break;
      all = all.concat(items);
      if (items.length < 100) break;
      pg++;
    }

    // Resolve UUID keys
    const cards = all.map(card => {
      const resolved = Object.assign({}, card);
      Object.keys(schemaMap).forEach(uuid => {
        if (uuid in card) resolved[schemaMap[uuid]] = card[uuid];
      });
      return resolved;
    });

    // Group by Mirror Date Contract Ends month — deduplicate by title+month
    const byMonth = {};
    const noDate = [];
    const seenDebug = new Set();
    cards.forEach(c => {
      const d = c['Mirror Date Contract Ends'];
      if (d) {
        const m = d.slice(0, 7);
        const title = (c.Title || c.name || '').trim();
        const streetNum = title.match(/^(\d+)/)?.[1] || title;
        const key = streetNum + '|' + m;
        const isDup = seenDebug.has(key);
        seenDebug.add(key);
        if (!byMonth[m]) byMonth[m] = [];
        byMonth[m].push({
          title,
          contractEnd: d,
          reason: c.Reason || '',
          stage: c.stage || '',
          archived: c.archived,
          duplicate: isDup,
        });
      } else {
        noDate.push({ title: c.Title || c.name, stage: c.stage, archived: c.archived });
      }
    });
    // Add unique counts
    Object.keys(byMonth).forEach(m => {
      byMonth[m]._unique = byMonth[m].filter(i => !i.duplicate).length;
    });

    res.json({
      total: cards.length,
      schema: schemaMap,
      byMonth: Object.entries(byMonth).sort().map(([month, items]) => ({ month, count: items.length, items })),
      withoutDate: noDate.length,
      noDateSample: noDate.slice(0, 5),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Inspect live field names on key boards — useful after Aptly schema changes
app.get('/api/metrics/debug', async (req, res) => {
  try {
    // Move-Outs board — confirmed: "Comprehensive Inspection" = "Yes"/"No"
    const moSample = await unitsFetch('/api/board/YA3QWmPebvMwLwbB3', { page: 0, pageSize: 3 });
    const moItems = Array.isArray(moSample) ? moSample : (moSample && moSample.data) || [];

    // Offboard board — confirmed: card.Reason = plain string reason
    const obSample = await unitsFetch('/api/board/BaMiriNFDZBtWd5rR', { page: 0, pageSize: 5, includeArchived: true });
    const obItems = Array.isArray(obSample) ? obSample : (obSample && obSample.data) || [];

    // PMA / Owner Pipeline
    const pmaSample = await unitsFetch('/api/board/QySZ8yRWJ5KeYFcZt', { page: 0, pageSize: 3 });
    const pmaItems = Array.isArray(pmaSample) ? pmaSample : (pmaSample && pmaSample.data) || [];

    res.json({
      moveOutsBoard: {
        id: 'YA3QWmPebvMwLwbB3',
        comprehensiveInspectionField: '"Comprehensive Inspection" (confirmed)',
        sampleValues: moItems.map(c => ({
          title: c.Title,
          stage: c.stage,
          comprehensiveInspection: c['Comprehensive Inspection'],
        })),
      },
      offboardBoard: {
        id: 'BaMiriNFDZBtWd5rR',
        reasonField: '"Reason" (confirmed plain string)',
        sampleCards: obItems.map(c => ({
          title: c.Title,
          stage: c.stage,
          reason: c.Reason,
          createdAt: c['Created At'] || c.createdAt,
        })),
        allReasonsSeen: [...new Set(obItems.map(c => c.Reason).filter(Boolean))],
      },
      pmaBoard: {
        id: 'QySZ8yRWJ5KeYFcZt',
        stages: pmaItems.map(c => c.stage),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('*', function(req, res) {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Aloe PM — Internal Hub</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --teal:#3CC3E1;
      --teal-dark:#4BB4D2;
      --teal-dim:rgba(60,195,225,0.12);
      --teal-dim2:rgba(60,195,225,0.06);
      --silver:#B4C3C3;
      --silver-dim:rgba(180,195,195,0.15);
      --bg:#F8FAFC;
      --bg2:#ffffff;
      --bg3:#f1f5f5;
      --border:rgba(180,195,195,0.3);
      --border2:rgba(60,195,225,0.25);
      --text:#1a2b2b;
      --text2:#4a6060;
      --text3:#8aa0a0;
    }
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}

    /* TOP BAR */
    .topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .logo-wrap{display:flex;align-items:center;gap:12px}
    .logo-icon{width:36px;height:36px;border-radius:10px;background:var(--teal-dim);border:1px solid var(--border2);display:flex;align-items:center;justify-content:center}
    .logo-icon svg{width:20px;height:20px}
    .logo-text{font-size:15px;font-weight:600;color:var(--text);letter-spacing:-0.3px}
    .logo-sub{font-size:11px;color:var(--text3);margin-top:1px}
    .topbar-right{display:flex;align-items:center;gap:8px}
    .pill{font-size:11px;padding:3px 10px;border-radius:20px;background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2);font-weight:500}
    .pill.silver{background:var(--silver-dim);color:var(--text2);border-color:var(--border)}

    /* HERO */
    .hero{padding:48px 32px 32px;max-width:900px;margin:0 auto}
    .hero-greeting{font-size:13px;font-weight:500;color:var(--teal-dark);letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px}
    .hero-title{font-size:30px;font-weight:700;color:var(--text);letter-spacing:-0.5px;line-height:1.2;margin-bottom:8px}
    .hero-title span{color:var(--teal)}
    .hero-sub{font-size:14px;color:var(--text2);line-height:1.6;max-width:480px}

    /* SEARCH BAR */
    .search-wrap{max-width:900px;margin:0 auto;padding:0 32px 32px}
    .search-box{display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 16px;transition:border-color 0.15s}
    .search-box:focus-within{border-color:var(--teal)}
    .search-box svg{width:16px;height:16px;flex-shrink:0;opacity:0.4}
    .search-box input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;font-family:inherit}
    .search-box input::placeholder{color:var(--text3)}

    /* SECTION */
    .section{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .section-label{font-size:11px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .section-label::after{content:'';flex:1;height:1px;background:var(--border)}

    /* TOOL GRID */
    .tool-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
    .tool-card{background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;cursor:pointer;transition:all 0.18s;text-decoration:none;color:inherit;display:block;position:relative;overflow:hidden}
    .tool-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;opacity:0;transition:opacity 0.18s}
    .tool-card:hover{border-color:var(--teal);transform:translateY(-2px);box-shadow:0 6px 20px rgba(60,195,225,0.1)}
    .tool-card:hover::before{opacity:1}
    .tool-card.primary::before{background:var(--teal)}
    .tool-card.silver-top::before{background:var(--silver)}
    .tool-card.amber-top::before{background:#f5a623}
    .tool-card.green-top::before{background:#4ade80}
    .tool-card.purple-top::before{background:#a78bfa}
    .tool-card.red-top::before{background:#f87171}
    .tool-icon{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;font-size:18px}
    .icon-teal{background:var(--teal-dim);border:1px solid var(--border2)}
    .icon-silver{background:var(--silver-dim);border:1px solid var(--border)}
    .icon-amber{background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.25)}
    .icon-green{background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25)}
    .icon-purple{background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25)}
    .icon-red{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25)}
    .tool-name{font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px}
    .tool-desc{font-size:11px;color:var(--text3);line-height:1.5}
    .tool-badge{position:absolute;top:14px;right:14px;font-size:9px;font-weight:600;padding:2px 7px;border-radius:20px}
    .badge-live{background:rgba(74,222,128,0.12);color:#16a34a;border:1px solid rgba(74,222,128,0.25)}
    .badge-new{background:var(--teal-dim);color:var(--teal-dark);border:1px solid var(--border2)}
    .badge-soon{background:var(--silver-dim);color:var(--text3);border:1px solid var(--border)}

    /* FOOTER */
    .footer{max-width:900px;margin:0 auto;padding:0 32px 40px}
    .footer-inner{border-top:1px solid var(--border);padding-top:20px;display:flex;align-items:center;justify-content:space-between}
    .footer-left{font-size:11px;color:var(--text3)}
    .footer-sources{display:flex;gap:6px}
    .source-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:var(--bg3);color:var(--text3);border:1px solid var(--border)}

    @media(max-width:640px){
      .tool-grid{grid-template-columns:1fr 1fr}
      .hero{padding:32px 20px 20px}
      .section{padding:0 20px 32px}
      .search-wrap{padding:0 20px 24px}
    }
  </style>
</head>
<body>

<div class="topbar">
  <div class="logo-wrap">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3C8 3 5 7 5 11c0 5 7 10 7 10s7-5 7-10c0-4-3-8-7-8z" fill="#3CC3E1" opacity="0.3"/>
        <path d="M12 3C8 3 5 7 5 11c0 5 7 10 7 10s7-5 7-10c0-4-3-8-7-8z" stroke="#3CC3E1" stroke-width="1.5" fill="none"/>
        <path d="M12 8v6M9 11h6" stroke="#3CC3E1" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </div>
    <div>
      <div class="logo-text">Aloe PM Internal Hub</div>
      <div class="logo-sub">Phoenix Metro · All systems live</div>
    </div>
  </div>
  <div class="topbar-right">
    <span class="pill">AI-Powered</span>
    <span class="pill silver">Internal Only</span>
  </div>
</div>

<div class="hero">
  <div class="hero-greeting">Good to see you</div>
  <div class="hero-title">Welcome back to <span>Aloe PM</span></div>
  <div class="hero-sub">Your internal command center for property management, AI agents, and team operations.</div>
</div>

<div class="search-wrap">
  <div class="search-box">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
    <input type="text" placeholder="Search tools, docs, or ask a question…" id="search-input" oninput="filterTools(this.value)"/>
  </div>
</div>

<!-- AI & AUTOMATION -->
<div class="section">
  <div class="section-label">AI & Automation</div>
  <div class="tool-grid">
    <a href="/chat" class="tool-card primary" data-name="aloe assistant ai chat">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🤖</div>
      <div class="tool-name">Aloe Assistant</div>
      <div class="tool-desc">AI chat — Rentvine, Aptly, Knowledge Base, Slack all connected</div>
    </a>

    <a href="/sandbox" class="tool-card primary" data-name="sandbox agent training coaching test">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">✏️</div>
      <div class="tool-name">Agent Sandbox</div>
      <div class="tool-desc">Train and coach AI agents before going live</div>
    </a>

    <a href="/sms-queue" class="tool-card primary" data-name="sms queue drafts tenant messages quo">
      <span class="tool-badge badge-new">NEW</span>
      <div class="tool-icon icon-green">💬</div>
      <div class="tool-name">SMS Draft Queue</div>
      <div class="tool-desc">Review and approve AI-drafted responses before sending</div>
    </a>
  </div>
</div>

<!-- ACCOUNTING -->
<div class="section">
  <div class="section-label">Accounting</div>
  <div class="tool-grid">
    <a href="/recon-bills" class="tool-card primary" data-name="recon bills invoices accounting reconcile vendor">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🧾</div>
      <div class="tool-name">Recon — Bills</div>
      <div class="tool-desc">Reconcile vendor invoices against approved work orders</div>
    </a>

    <a href="/recon" class="tool-card primary" data-name="recon reconciliation maintenance work orders">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🔍</div>
      <div class="tool-name">Recon</div>
      <div class="tool-desc">Cross-reference work orders between Aptly and Rentvine</div>
    </a>

    <a href="/accounting" class="tool-card primary" data-name="accounting payments ledger reconciliation randi">
      <span class="tool-badge badge-soon">SOON</span>
      <div class="tool-icon icon-amber">💰</div>
      <div class="tool-name">Accounting</div>
      <div class="tool-desc">Payments, ledger, reconciliation — Randi's domain</div>
    </a>
  </div>
</div>

<!-- OPERATIONS -->
<div class="section">
  <div class="section-label">Operations</div>
  <div class="tool-grid">
    <a href="/resources/vendors" class="tool-card primary" data-name="vendor resources partner apply vendor program">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-silver">🔨</div>
      <div class="tool-name">Vendor Resources</div>
      <div class="tool-desc">Vendor partnership page — standards, requirements, application</div>
    </a>

    <a href="/renewals" class="tool-card primary" data-name="lease renewals persia renewal dashboard">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🔄</div>
      <div class="tool-name">Lease Renewals</div>
      <div class="tool-desc">Renewal pipeline, offers, calculator — Persia's dashboard</div>
    </a>

    <a href="/hoa" class="tool-card primary" data-name="hoa form filler registration auto-fill juan">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">📋</div>
      <div class="tool-name">HOA Form Filler</div>
      <div class="tool-desc">Auto-fill HOA registration PDFs with Rentvine tenant data</div>
    </a>

    <a href="/leasing" class="tool-card primary" data-name="leasing leads showings applications dhyana">
      <div class="tool-icon icon-teal">🏠</div>
      <div class="tool-name">Leasing</div>
      <div class="tool-desc">Leads, showings, applications</div>
    </a>

    <a href="/maintenance" class="tool-card silver-top" data-name="maintenance work orders vendors roberto">
      <div class="tool-icon icon-silver">🔧</div>
      <div class="tool-name">Maintenance</div>
      <div class="tool-desc">Work orders, vendors, and scheduling</div>
    </a>

    <a href="/residents" class="tool-card primary" data-name="residents tenants lease renewals persia">
      <div class="tool-icon icon-teal">👥</div>
      <div class="tool-name">Residents</div>
      <div class="tool-desc">Tenant comms, lease renewals, move-outs</div>
    </a>

    <a href="/owners" class="tool-card purple-top" data-name="owners landlords portfolio reporting alexes">
      <div class="tool-icon icon-purple">🏢</div>
      <div class="tool-name">Owner Relations</div>
      <div class="tool-desc">Owner reporting and portfolio updates</div>
    </a>
  </div>
</div>

<!-- REPORTS -->
<div class="section">
  <div class="section-label">Reports</div>
  <div class="tool-grid">
    <a href="/metrics" class="tool-card primary" data-name="metrics kpi dashboard portfolio occupancy leases">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">📊</div>
      <div class="tool-name">KPI Metrics</div>
      <div class="tool-desc">Portfolio changes, occupancy rate, move-ins, lease activity</div>
    </a>

    <a href="/vacancy" class="tool-card primary" data-name="vacancy risk market intelligence rentometer">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🏠</div>
      <div class="tool-name">Vacancy Risk & Market Intelligence</div>
      <div class="tool-desc">Risk scores, market comps, owner reports — all vacant units</div>
    </a>

    <a href="/owner-report" class="tool-card primary" data-name="owner report email generator vacancy update">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">📬</div>
      <div class="tool-name">Owner Report Generator</div>
      <div class="tool-desc">AI-drafted vacancy update email per property — one click</div>
    </a>

    <a href="/rent-analysis" class="tool-card primary" data-name="rent analysis market comps zillow redfin LTR STR furnished">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">🏘️</div>
      <div class="tool-name">Rent Analysis</div>
      <div class="tool-desc">Live comps from Zillow, Redfin &amp; Realtor.com · STR/Airbnb · Furnished</div>
    </a>

    <a href="/sale-analysis" class="tool-card purple-top" data-name="sale analysis comps zestimate redfin estimate owner equity">
      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-purple">🏡</div>
      <div class="tool-name">Sale Analysis</div>
      <div class="tool-desc">Zestimate + Redfin Estimate + sale comps · owner equity calculator</div>
    </a>

    <a href="/owner-dashboard" class="tool-card primary" data-name="owner report dashboard leads marketing">
      <span class="tool-badge badge-soon">SOON</span>
      <div class="tool-icon icon-purple">📈</div>
      <div class="tool-name">Owner Dashboard</div>
      <div class="tool-desc">Live leasing activity and marketing report per owner</div>
    </a>
  </div>
</div>

<!-- INTEGRATIONS & TOOLS -->
<div class="section">
  <div class="section-label">Integrations & Tools</div>
  <div class="tool-grid">
    <a href="https://aloepm.rentvine.com" target="_blank" class="tool-card primary" data-name="rentvine property management tenants leases">
      <div class="tool-icon icon-silver">🤝</div>
      <div class="tool-name">Rentvine</div>
      <div class="tool-desc">Tenant data, leases, work orders, accounting</div>
    </a>

    <a href="https://app.getaptly.com" target="_blank" class="tool-card primary" data-name="aptly crm workflow boards leads move-ins hoa">
      <div class="tool-icon icon-teal">📌</div>
      <div class="tool-name">Aptly</div>
      <div class="tool-desc">CRM, workflow boards, leads, move-ins, HOA</div>
    </a>

<a href="https://my.quo.com/inbox/PNRRARIpQO" target="_blank" class="tool-card primary" data-name="quo openphone sms messaging calls inbox">      <div class="tool-icon icon-silver">📱</div>
      <div class="tool-name">Quo / OpenPhone</div>
      <div class="tool-desc">SMS inbox, tenant messaging, call logs</div>
    </a>

<a href="https://aloe-knowledge-sync.onrender.com/login" target="_blank" class="tool-card primary" data-name="knowledge base sops policies training templates resources">      <span class="tool-badge badge-live">LIVE</span>
      <div class="tool-icon icon-teal">📚</div>
      <div class="tool-name">Knowledge Base</div>
      <div class="tool-desc">SOPs, policies, training, vendor list, cost benchmarks</div>
    </a>

    <a href="https://drive.google.com" target="_blank" class="tool-card primary" data-name="google drive files documents leases reports">
      <div class="tool-icon icon-silver">📁</div>
      <div class="tool-name">Google Drive</div>
      <div class="tool-desc">Signed leases, inspection reports, owner docs</div>
    </a>

    <a href="https://slack.com" target="_blank" class="tool-card primary" data-name="slack team communications alerts escalation">
      <div class="tool-icon icon-silver">💼</div>
      <div class="tool-name">Slack</div>
      <div class="tool-desc">Team communications and escalation alerts</div>
    </a>

    <a href="https://zinspector.com/" target="_blank" class="tool-card primary" data-name="zinspector inspections property condition">
      <div class="tool-icon icon-teal">🔎</div>
      <div class="tool-name">Zinspector</div>
      <div class="tool-desc">Property inspections and condition reports</div>
    </a>
  </div>
</div>

<div class="footer">
  <div class="footer-inner">
    <div class="footer-left">Aloe Property Management · Phoenix Metro · Internal use only</div>
    <div class="footer-sources">
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
    const name = (card.dataset.name || '') + ' ' + card.querySelector('.tool-name').textContent + ' ' + card.querySelector('.tool-desc').textContent;
    card.style.display = (!q || name.toLowerCase().includes(q)) ? 'block' : 'none';
  });
}
</script>
</body>
</html>`);
});

app.get('/metrics', (req, res) => {
    res.sendFile(new URL('./metrics.html', import.meta.url).pathname);
});

// Vendor application form submission
app.post('/api/vendor-apply', async (req, res) => {
  try { const { business, name, phone, email, trade, license, area, insurance, about, why, hourlyRate, employees, hasVehicle, hasTools, social, refs, additional } = req.body;
    const emailBody = `New Vendor Application

Business: ${business}
Contact: ${name}
Phone: ${phone}
Email: ${email}
Trade: ${trade}
License/ROC: ${license || 'N/A'}
Service Area: ${area || 'N/A'}
Insurance: ${insurance}
Why Partner With Us: ${why || 'N/A'}
Hourly Rate: ${hourlyRate || 'N/A'}
Employees: ${employees || 'N/A'}
Owns Vehicle: ${hasVehicle || 'N/A'}
Owns Tools: ${hasTools || 'N/A'}
Social/Website: ${social || 'N/A'}
References: ${refs || 'N/A'}
Additional Info: ${additional || 'N/A'}
About: ${about || 'N/A'}`;

const slackText = `📋 *New Vendor Application*\n*Business:* ${business}\n*Contact:* ${name} · ${phone} · ${email}\n*Trade:* ${trade} · *Rate:* ${hourlyRate||'N/A'} · *Employees:* ${employees||'N/A'}\n*Vehicle:* ${hasVehicle||'N/A'} · *Tools:* ${hasTools||'N/A'}\n*Insurance:* ${insurance} · *Area:* ${area||'N/A'}\n*Social:* ${social||'N/A'}\n*Why us:* ${why||'N/A'}\n*Refs:* ${refs||'N/A'}\n*Additional:* ${additional||'N/A'}\n*About:* ${about||'N/A'}`;
    let slackOk = false;
    let emailOk = false;

    // Try Slack via API (uses existing SLACK_TOKEN — no webhook needed)
if (process.env.SLACK_TOKEN) {
  try {
    const slackResp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SLACK_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: 'C07CY9SSF7D',  // #vendors
        text: slackText
      })
    });
    const slackData = await slackResp.json();
    slackOk = slackData.ok;
    if (!slackData.ok) console.error('Slack postMessage error:', slackData.error);
  } catch(e) {
    console.error('Slack vendor error:', e.message);
  }
}
    // Try Resend email (requires RESEND_API_KEY)
    if (process.env.RESEND_API_KEY) {
      try {
        const emailResp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Vendor Applications <onboarding@resend.dev>',
            to: ['info@aloepm.com'],
            reply_to: email,
            subject: `Vendor Application — ${business}`,
            text: emailBody
          })
        });
        emailOk = emailResp.ok;
        if (!emailResp.ok) {
          const errText = await emailResp.text();
          console.error('Resend error:', errText);
        }
      } catch(e) {
        console.error('Resend vendor email error:', e.message);
      }
    }

    // Succeed if at least one channel worked
    if (slackOk || emailOk) {
      return res.json({ ok: true });
    }

    // Both failed — log and return error
    console.error('Vendor apply: both Slack and Resend failed. slackWebhook set:', !!process.env.SLACK_VENDOR_WEBHOOK, 'resendKey set:', !!process.env.RESEND_API_KEY);
    res.status(500).json({ error: 'Failed to deliver application' });

  } catch (err) {
    console.error('Vendor apply error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Aloe Assistant running on port ' + PORT));
