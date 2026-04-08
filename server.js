import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const RENTVINE_API_KEY    = process.env.RENTVINE_API_KEY;
const RENTVINE_API_SECRET = process.env.RENTVINE_API_SECRET;
const RENTVINE_ACCOUNT    = process.env.RENTVINE_ACCOUNT;
const APTLY_TOKEN         = process.env.APTLY_TOKEN;
const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const ZINSPECTOR_API_KEY  = process.env.ZINSPECTOR_API_KEY;
const SLACK_TOKEN         = process.env.SLACK_TOKEN;

const RENTVINE_BASE = `https://${RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
const RENTVINE_AUTH = Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString('base64');

// Master knowledge base — fetched from critical Notion pages at startup
let KNOWLEDGE_BASE = '';
async function fetchNotionPageText(pageId) {
  try {
    const r = await fetch('https://api.notion.com/v1/blocks/' + pageId + '/children?page_size=100', {
      headers: { 'Authorization': 'Bearer ' + NOTION_TOKEN, 'Notion-Version': '2022-06-28' }
    });
    if (!r.ok) return '';
    const data = await r.json();
    const lines = [];
    for (const block of (data.results || [])) {
      const type = block.type;
      const rich = (block[type] && block[type].rich_text) || [];
      const text = rich.map(function(t) { return t.plain_text || ''; }).join('');
      if (text) lines.push(text);
    }
    return lines.join('\n');
  } catch(e) { return ''; }
}
async function loadKnowledgeBase() {
  try {
    // Load master reference + the most frequently needed content pages
    const pages = [
      { id: '33b76555273a81de9958f69e7f2ecd7c', label: 'Master Reference' },
      { id: '1fa76555273a80debda0f220cfb72400', label: 'Prospective Tenant FAQs' },
      { id: '25e76555273a8082ae8fef84ebd87a23', label: 'Application Terms' },
      { id: '18776555273a81049822eca6abae6fbb', label: 'Lease Break Policy' },
    ];
    const sections = [];
    for (const p of pages) {
      const text = await fetchNotionPageText(p.id);
      if (text) sections.push('=== ' + p.label + ' ===\n' + text);
    }
    KNOWLEDGE_BASE = sections.join('\n\n');
    console.log('Knowledge base loaded: ' + KNOWLEDGE_BASE.length + ' chars from ' + sections.length + ' pages');
  } catch(e) {
    console.error('Knowledge base load error:', e.message);
  }
}
// Load on startup
loadKnowledgeBase();

const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

APTLY — Source of truth for listings and availability:
- Units board (ID: unit) — ALL published listings with beds, baths, rent, available date, Published For Rent field. THIS IS THE ONLY SOURCE for "what units are available" questions. Never use Rentvine for availability.
- Renter leads pipeline (board ID: 4EMDSYKirhQaNdQKz)
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards
- Contact and lead details

RENTVINE — Source of truth for tenant and accounting data:
ZINSPECTOR — Inspection platform synced with Rentvine. Use zi_get_inspections tool to get latest move-in, move-out, maintenance, and periodic inspection activity for any property. Falls back to Rentvine inspection data if zInspector API is unavailable.
- Tenant info, balances, ledger, payment history, unpaid charges with full breakdown
- Lease details, move-in/out dates, lease terms, rent amounts, deposit
- Owner info, portfolio details, contact information
- Work orders and maintenance requests
- Property inspections (move-in, move-out, periodic)
- Vendors and contractors
- NOTE: Do NOT use Rentvine for availability/listings — use Aptly Units board instead

NOTION — Company policies and SOPs:
- Lease break policy, move-in/out procedures
- Pet policy, screening criteria, fee schedules
- HOA violation procedures, maintenance escalation, all SOPs

Known Aptly board IDs:
- "unit" — Units/Listings board. Has Stage (Vacant/Occupied), beds, baths, sq ft, rent, deposit, available date, Published For Rent field. For availability questions use "qfBzBxfooJtfTQncd" instead (it has Mirror Published For Rent field and is the master listing board).
- "qfBzBxfooJtfTQncd" — List Property / On Market board. Shows properties actively listed, showing start date, notes on occupancy, market status.
- "location" — Properties/Locations board. Has owner, address, property details for every property.
- "4EMDSYKirhQaNdQKz" — Renter Leads. Shows active prospects, showings (Stage="Scheduled Tour"), tour history.
- "MJxaStgENouWrNEKd" — Applicants (Applications board). Use this for ANY question about applications. Has Application Location (property address), Primary Applicant, Stage, income, credit, household info. NEVER use Renter Leads for applications.
- "YA3QWmPebvMwLwbB3" — Move-Outs. Shows move-out pipeline, repair status, inspection status.
- "K9mMGGjKgQPqDykaa" — Move-Ins. Shows upcoming move-ins.
- "86YrLPbwdkxtdyZoj" — Tenant Renewals.

Known Notion page IDs (fetch these directly with notion_get_page — do NOT search for them):

RESIDENT-FACING PAGES (use when question is from/about a tenant):
- Lease Break Policy: 18776555273a81049822eca6abae6fbb → lease break fees, early termination
- Lease Break FAQs (tenant): 33976555273a816783b2c4c8165d6078 → tenant lease break questions
- Lease Break Information: 18776555273a811c89adf91da03cd1bf → tenant lease break overview
- Application Terms / Approval Timeline: 25e76555273a8082ae8fef84ebd87a23 → how long approval takes, earnest deposit, application fees ($65), 1-2 days
- What To Expect During Approval: 31c76555273a80e587c9e38b9a279a57 → earnest deposit process, taking unit off market
- Prospective Tenant FAQs: 1fa76555273a80debda0f220cfb72400 → prospect/leasing FAQs
- Section 8 FAQ: 18776555273a8119864afad059b6bfd5 → housing voucher, section 8 questions
- Lease Signing FAQs: 18776555273a8146b014d0a7a196c060 → lease signing process
- Move In FAQs: 18776555273a81bd8637cd433f6b6d06 → move-in questions
- Late Fee Policy: 18776555273a81938c2bc7315d49093a → late fees
- Notice to Vacate: 18776555273a8130bd16cd517b8e2487 → tenant giving notice
- Move Out Instructions: 18776555273a81fe83e1c8ab38ad7bd6 → move-out process for tenants
- Security Deposit Refund: 25c76555273a80cab590c74aaab85b20 → deposit return timeline
- Maintenance Requests: 18776555273a81eea2f3e381fd641539 → how to submit work orders
- After Hours Maintenance: 2a276555273a80c7b625ff3cdae60d6b → after hours emergencies
- Resident Benefit Package: 18776555273a81548e1af2a1839d2de4 → RBP details
- Partial Payment or Prepayments: 1fa76555273a80eab78ecea4d3e4d779 → payment arrangements
- How to Schedule a Tour: 30a76555273a80bb9963eacd6631ecde → tour scheduling, lockbox access
- Rental and Housing Assistance: 2a776555273a8011a1cad428d5d0f382 → rental assistance programs

OWNER-FACING PAGES (use when question is from/about an owner):
- Fees & Pricing Plans: 26376555273a80a9ba89d61d5159e8c2 → management fee options
- Management Fee: 18776555273a81508b17fe8e936dc9c0 → fee structure
- Disbursements: 18776555273a81bf86f3c84b8b81d9d1 → owner payout questions
- Leasing (owner): 18776555273a8183b19afa3fc5fa5004 → leasing process for owners
- Resident Screening: 26376555273a8040a745fe59e5d57f2a → screening standards
- Rent Ready Standards: 2a776555273a80c49c12ef793e7e2172 → property prep requirements
- Lease Renewals (owner): 18776555273a81fd9138cf5226f1c513 → renewal process
- Resident Gave Notice FAQs: 18776555273a81d687faf22e50c82f24 → owner questions when tenant gives notice
- Maintenance Process (owner): 26476555273a80dda789d29c98a33f54 → maintenance workflow
- Responsibility Tenant or Owner: 18776555273a8148a1fff3316049ae02 → who pays for what
- Why Aloe Retains Late Fees: 2b076555273a803fb7f4c3ce93eb26e6 → late fee policy explanation
- Pet Protection Guarantee: 18776555273a8191b8c8c3461cf0ee84 → pet guarantee
- Eviction Guarantee: 26776555273a80ea90ffff63ea5a22e2 → eviction guarantee
- Leasing Guarantee: 26776555273a80fa882ae0f01665ce98 → leasing guarantee
- Client Handbook: 18776555273a81e2a1f0d4c583778c2a → general owner reference

INTERNAL PAGES:
- Applicant Criteria (screening standards): 18776555273a81beb216db69887d8266 → income/credit requirements
- FAQ Leasing Calls: 18776555273a8152b1a5d1309cfcee88 → what to say to prospects
- Checking Property Availability SOP: 33976555273a81e093d9d062009a206c → availability check process
- Aloe Assistant Master Reference: 33b76555273a81de9958f69e7f2ecd7c → full operational context

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
- Always use tools to get live data — never guess or make up numbers
- For tenant balances always show the full breakdown (what charges, amounts, dates)
- Be concise. Lead with the answer, then details
- Use numbered steps for procedures
- Always cite your source (Rentvine, Aptly, Notion, or Slack)
- Never speculate on legal or fair housing matters
- NEVER ask the user clarifying questions. Just search and answer.
- NEVER explain how a tool works or describe what it does. Always run the tool and report the actual results. If someone asks "where do I look for move-out inspections?" — run rv_get_inspections and report what's in there, don't describe the tool.
- NEVER say "you can use X tool" or "the results will show" — just use the tool and show the results directly.
- For known policy topics (lease break, early termination): use notion_get_page with the hardcoded page ID above — do NOT waste loops searching.
- For ANY question about application approval time, how long it takes, timeline, earnest deposit, application fees: IMMEDIATELY use notion_get_page with ID 25e76555273a8082ae8fef84ebd87a23 — answer is "1-2 days after completed application received".
- CRITICAL FEE FACTS — never get these wrong: Earnest deposit = $1,500 (NOT $500). Application fee = $65 per adult. Cleaning fee = $500 (move-out, non-refundable). Admin fee = $250. Pet fee = $250 per pet. Security deposit = 1x monthly rent. The $500 is the CLEANING FEE, not the earnest deposit.
- For ANY question about applicant screening criteria, income requirements, credit score: IMMEDIATELY use notion_get_page with ID 18776555273a81beb216db69887d8266.
- For unknown policy topics: search Notion 2-3 times with different keywords before giving up.
- NEVER offer to "connect" the user with someone or ask what type of answer they want — just search and answer.
- Only route to a team member when you genuinely cannot answer the question from the data. If the question has been fully answered, do NOT add a 'reach out to X' closer — just stop after the answer.
- When answering a question about a TENANT (what they owe, what they need to do, what their options are): only include information relevant to the tenant. Do NOT include owner fee splits, what the owner receives, re-leasing fees charged to owners, or any owner-facing financial details — that is irrelevant and confusing to a tenant conversation.
- When answering a question about an OWNER: only include owner-relevant information. Do not include tenant-facing language.
- Use the context of the question to determine audience. "A tenant wants to know..." or "what should I tell a tenant" = tenant audience only.
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
- NEVER say "I'm unable to access" or "I cannot access" any board or data source — you have Rentvine, Aptly, Notion, and Slack tools available. Always actually try them before concluding data isn't available.
- NEVER route to a team member as a substitute for using your tools. Always use all relevant tools first (Rentvine AND Aptly), then only route if the tools genuinely return no data.
- NEVER invent reasons or possibilities for why something is not found. Only report what the data actually shows.
- For ANY question about tours, showings, scheduling, or why a property isn't available, or what work is being done: check Rentvine for (1) active lease status, (2) latest inspections via rv_get_inspections — these are synced from zInspector and show the most recent move-in, move-out, or maintenance inspection with date and type. Then search Aptly for pipeline status. Report all three together.
- When reporting inspection activity: state the inspection type (move-in, move-out, maintenance, periodic), the date it was completed, and any notes. This tells the team whether turnover work or make-ready is in progress.
- When reporting on a property: state the facts directly. Example: "17373 North Costa Brava is currently occupied — the lease runs through [date]. In Aptly it shows [status] with [showing info]." Do NOT suggest steps, do NOT give instructions, do NOT tell the user what to do. Just report what the data shows.
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
    description: 'Get the full accounting ledger for a lease — all charges, payments, credits with dates. Use after rv_get_leases to get the leaseId.',
    input_schema: {
      type: 'object',
      properties: {
        leaseId: { type: 'number', description: 'Rentvine lease ID' },
      },
      required: ['leaseId'],
    },
  },
  {
    name: 'rv_get_transactions',
    description: 'Get full transaction history for a lease — all payments made, fees charged, credits applied with dates.',
    input_schema: {
      type: 'object',
      properties: {
        leaseId: { type: 'number', description: 'Rentvine lease ID' },
      },
      required: ['leaseId'],
    },
  },
  {
    name: 'rv_get_properties',
    description: 'Get properties in the portfolio. Search by address, name, or city. Use to look up a specific property address.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Address, property name, or city to search for (optional)' },
      },
    },
  },
  {
    name: 'rv_get_units',
    description: 'Get units with rent, deposit, beds, baths, availability. Search by address. Use to find vacant or available rentals.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Address or unit name to search for (optional)' },
        propertyId: { type: 'number', description: 'Filter by property ID (optional)' },
      },
    },
  },
  {
    name: 'rv_get_owners',
    description: 'Get owner/landlord contact info, portfolio, and associated properties',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Owner name or email (optional)' },
      },
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
    name: 'rv_get_work_order_detail',
    description: 'Get full details for a specific work order by ID',
    input_schema: {
      type: 'object',
      properties: {
        workOrderId: { type: 'number', description: 'Work order ID' },
      },
      required: ['workOrderId'],
    },
  },
  {
    name: 'rv_get_inspections',
    description: 'Get property inspections from Rentvine — move-in, move-out, and periodic inspections with dates and status',
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
      properties: {
        inspectionId: { type: 'number', description: 'Inspection ID' },
      },
      required: ['inspectionId'],
    },
  },
  {
    name: 'rv_get_tenants',
    description: 'Search for tenant contacts in Rentvine by name or email',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Tenant name or email' },
      },
    },
  },
  {
    name: 'rv_get_vendors',
    description: 'Get vendor/contractor list from Rentvine, optionally filtered by name',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Vendor name (optional)' },
      },
    },
  },
  {
    name: 'aptly_get_board_cards',
    description: 'Get cards from an Aptly board. Renter Leads board ID: 4EMDSYKirhQaNdQKz. Use aptly_list_boards to find other board IDs.',
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
    description: 'List all available Aptly boards to find board IDs for Move-Ins, Move-Outs, HOA Violations, Renewals etc.',
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
    name: 'notion_search',
    description: 'Search Notion for company policies, SOPs, procedures, fee schedules, and guidelines',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Policy or procedure to search for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'notion_get_page',
    description: 'Get the full content of a Notion page by ID — use after notion_search to read a specific policy',
    input_schema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Notion page ID' },
      },
      required: ['pageId'],
    },
  },
  {
    name: 'slack_search',
    description: 'Search Slack for team messages, announcements, and decisions across all channels',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for in Slack' },
      },
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
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${RENTVINE_AUTH}` },
  });
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

// Dedicated search function using Aptly's search API — works for all board types including screening
async function aptlySearch(boardId, query) {
  const url = new URL('https://app.getaptly.com/api/aptlet/' + boardId + '/search');
  url.searchParams.set('x-token', APTLY_TOKEN);
  url.searchParams.set('query', query || '');
  url.searchParams.set('page', '0');
  url.searchParams.set('pageSize', '100');
  const r = await fetch(url.toString());
  if (!r.ok) {
    // Fallback to regular aptlet endpoint
    return aptlyFetch('/aptlet/' + boardId, { page: 0, query: query || 'a' });
  }
  const data = await r.json();
  return data;
}

let _unitsSchema = null;
async function unitsFetch(path, params = {}) {
  const url = new URL('https://core-api.getaptly.com' + path);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const unitsToken = process.env.APTLY_UNITS_TOKEN || process.env.APTLY_TOKEN || '';
  const r = await fetch(url.toString(), {
    headers: { 'x-token': unitsToken, 'Accept': 'application/json' }
  });
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
  // Paginate to get all cards
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
  const cards = allCards;
  // Map field keys to human-readable labels using schema
  return cards.map(function(card) {
    const mapped = { _cardId: card.cardId };
    Object.keys(card).forEach(function(k) {
      const label = schema[k] || k;
      const val = card[k];
      // Handle money fields { amount, currency }
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
  if (allCards.length > 0) console.log('Raw card full:', JSON.stringify(allCards[0]).slice(0, 1500));
  return allCards.map(function(card) {
    // Start with raw camelCase fields (built-in fields)
    const mapped = {
      _cardId: card.cardId,
      name: card.name || '',
      stage: card.stage || '',
      appInputCompleted: card.appInputCompleted || '',
      appApproved: card.appApproved || false,
      createdAt: card.createdAt || '',
    };
    // Then overlay schema-mapped custom fields (UUID keys → human labels)
    Object.keys(card).forEach(function(k) {
      if (schema[k]) {  // only map UUID keys that have a schema label
        const label = schema[k];
        let val = card[k];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          if ('amount' in val) val = '$' + val.amount;
          else if ('value' in val) val = val.value;
          else if ('name' in val) val = val.name;
          else if ('label' in val) val = val.label;
          else val = JSON.stringify(val);
        }
        mapped[label] = val;
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

async function notionFetch(path, method, body) {
  method = method || 'GET';
  const opts = {
    method,
    headers: {
      Authorization: 'Bearer ' + NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('https://api.notion.com/v1' + path, opts);
  return r.json();
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

      case 'rv_get_leases': {
        if (!input.tenantName && !input.address && !input.leaseId && !input.unit && input.status !== 'all') {
          return JSON.stringify({ error: 'A search term (address, tenantName, or leaseId) is required for rv_get_leases to prevent context overflow. For broad availability, use aptly_search_cards with boardId="location" instead.' });
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
          return JSON.stringify(matches);
        }
        // No search — return summary only to avoid context overflow
        return JSON.stringify({
          total: allData.length,
          message: 'Pass a search term to find specific properties. Showing summary only to conserve context.',
          sample: allData.slice(0, 5).map(function(item) {
            const p = item.property || {};
            return { id: p.propertyID, address: p.address, city: p.city };
          })
        });
      }

      case 'rv_get_units': {
        if (!input.propertyId && !input.search) {
          return JSON.stringify({ error: 'propertyId or search required — use rv_get_properties first to find the propertyId, then call rv_get_units with that propertyId' });
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
        // search-only fallback via lease export
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
        const params = { pageSize: 50, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        const data = await rvFetch('/maintenance/work-orders', params);
        if (input.status && input.status !== 'all' && Array.isArray(data)) {
          return JSON.stringify(data.filter(function(wo) {
            return input.status === 'open' ? !wo.closedDate : !!wo.closedDate;
          }));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_work_order_detail': {
        return JSON.stringify(await rvFetch('/maintenance/work-orders/' + input.workOrderId));
      }

      case 'zi_get_inspections': {
        const q = input.propertyId || '';
        // Try inspections endpoint with property filter
        const result = await ziFetch('/inspections', q ? { property: q, limit: 10 } : { limit: 10 });
        if (result.error) {
          // Fallback to Rentvine inspections which are synced from zInspector
          const rv = await rvFetch('/maintenance/inspections', { pageSize: 50 });
          if (q && Array.isArray(rv)) {
            return JSON.stringify(rv.filter(i => JSON.stringify(i).toLowerCase().includes(q.toLowerCase())).slice(0, 10));
          }
          return JSON.stringify({ zInspectorError: result.error, rentvineInspections: rv });
        }
        return JSON.stringify(result);
      }

      case 'rv_get_inspections': {
        const params = { pageSize: 50, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        return JSON.stringify(await rvFetch('/maintenance/inspections', params));
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
        // query param is required — empty string returns all cards
        const data = await aptlyFetch('/aptlet/' + boardId, { page: input.page || 0, query: input.query || '' });
        return JSON.stringify(data);
      }

      case 'aptly_list_boards': {
        // Return hardcoded known boards since /aptlets endpoint is unreliable
        return JSON.stringify([
          { id: 'unit', name: 'Units / Listings', description: 'All units with Stage (Vacant/Occupied), beds, baths, rent, available date, lockbox, application link. Use this for availability questions.' },
          { id: 'qfBzBxfooJtfTQncd', name: 'List Property / On Market', description: 'Properties actively listed for rent, showing start date, market status, occupancy notes.' },
          { id: 'location', name: 'Properties / Locations', description: 'All properties with owner, address, property details' },
          { id: '4EMDSYKirhQaNdQKz', name: 'Renter Leads', description: 'Prospect leads, showing pipeline, published for rent status' },
          { id: 'YA3QWmPebvMwLwbB3', name: 'Move-Outs', description: 'Move-out pipeline, repair status, inspection notes' },
          { id: 'K9mMGGjKgQPqDykaa', name: 'Move-Ins', description: 'Move-in pipeline' },
          { id: '86YrLPbwdkxtdyZoj', name: 'Tenant Renewals', description: 'Lease renewal pipeline' },
        ]);
      }

      case 'aptly_search_cards': {
        const q = input.query || '';
        const boardsToSearch = input.boardId 
          ? [input.boardId] 
          : ['unit', 'qfBzBxfooJtfTQncd', 'location', '4EMDSYKirhQaNdQKz', 'YA3QWmPebvMwLwbB3', 'K9mMGGjKgQPqDykaa', '86YrLPbwdkxtdyZoj'];
        
        const results = [];
        for (const bid of boardsToSearch) {
          // Always pass query param — required for API to return results
          const data = await aptlyFetch('/aptlet/' + bid, { page: 0, query: q });
          const cards = (data && data.cards) || (Array.isArray(data) ? data : []);
          // Client-side filter if query provided
          const matched = q 
            ? cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(q.toLowerCase()); })
            : cards;
          if (matched.length > 0) results.push({ board: bid, cards: matched });
        }
        return JSON.stringify(results.length > 0 ? results : { message: 'No results found for: ' + (q || '(all)') });
      }

      case 'notion_search': {
        const data = await notionFetch('/search', 'POST', {
          query: input.query,
          filter: { value: 'page', property: 'object' },
          page_size: 5,
        });
        if (data.results && data.results.length > 0) {
          const pages = await Promise.all(data.results.slice(0, 3).map(async function(page) {
            const blocks = await notionFetch('/blocks/' + page.id + '/children');
            const text = (blocks.results || [])
              .map(function(b) {
                const t = b.type;
                return b[t] && b[t].rich_text ? b[t].rich_text.map(function(rt) { return rt.plain_text; }).join('') : '';
              })
              .filter(function(t) { return t.length > 0; })
              .slice(0, 30)
              .join('\n');
            const title = (page.properties && page.properties.title && page.properties.title.title && page.properties.title.title[0] && page.properties.title.title[0].plain_text) ||
                          (page.properties && page.properties.Name && page.properties.Name.title && page.properties.Name.title[0] && page.properties.Name.title[0].plain_text) ||
                          'Untitled';
            return { title: title, id: page.id, url: page.url, content: text || 'No content' };
          }));
          return JSON.stringify(pages);
        }
        return JSON.stringify({ message: 'No Notion pages found', query: input.query });
      }

      case 'notion_get_page': {
        const blocks = await notionFetch('/blocks/' + input.pageId + '/children?page_size=100');
        const text = (blocks.results || [])
          .map(function(b) {
            const t = b.type;
            if (!b[t] || !b[t].rich_text) return null;
            return b[t].rich_text.map(function(rt) { return rt.plain_text; }).join('');
          })
          .filter(Boolean)
          .join('\n');
        return JSON.stringify({ content: text || 'No content found' });
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
  }
  if (msg.match(/availab|unit|vacant|propert|homes?|house|bed|bath|address|\d{4,5}|tour|showing|work.?done|inspect|ready|make.?ready/)) {
    // For availability questions: Aptly is the source of truth, NOT Rentvine
    // Only add Rentvine tools if a specific address number is in the message
    if (msg.match(/\d{3,6}/)) {
      ['rv_get_properties', 'rv_get_units'].forEach(function(t) { tools.add(t); });
    }
    ['aptly_get_board_cards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/work.?order|maintenance|repair|fix|broken/)) {
    ['rv_get_work_orders', 'rv_get_work_order_detail'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/inspect/)) {
    ['rv_get_inspections', 'rv_get_inspection_detail'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/vendor|contractor/)) {
    tools.add('rv_get_vendors');
  }
  if (msg.match(/owner|landlord|portfolio|performing|statement/)) {
    ['rv_get_owners', 'rv_get_properties'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly|tour|showing|schedul|appointment|visit/)) {
    ['aptly_get_board_cards', 'aptly_list_boards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
    ['rv_get_inspections', 'rv_get_properties', 'zi_get_inspections'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/policy|procedure|sop|how do|what do|lease.?break|pet|fee|screen|criteria|step|process|rule/)) {
    ['notion_search', 'notion_get_page'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/slack|team|announce|update|channel|said|message/)) {
    ['slack_search', 'slack_get_channel_messages', 'slack_list_channels'].forEach(function(t) { tools.add(t); });
  }

  if (tools.size === 0) {
    ['rv_get_leases', 'notion_search'].forEach(function(t) { tools.add(t); });
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

    // Server-side shortcut for broad availability questions — skip Claude loop entirely
    const lastContent = messages[messages.length - 1]?.content;
    const lowerMsg = (typeof lastContent === 'string' ? lastContent : 
      (Array.isArray(lastContent) ? lastContent.map(function(b) { return b.text || ''; }).join(' ') : '')
    ).toLowerCase();
    const isAvailabilityQ = lowerMsg.match(/availab|for rent|vacant|what unit|what prop|what home|what listing|what house|under \d|homes.*rent|rent.*home|\d\s*bed/) && !lowerMsg.match(/[0-9]{5,6}/);
    const isNotTourableQ = lowerMsg.match(/not.{0,20}(tour|showing|avail)|can.{0,10}t.{0,10}(tour|showing)|(tour|showing).{0,20}not/) && !lowerMsg.match(/[0-9]{5,6}/);
    const priceMatch = lowerMsg.match(/(?:under|less than|below|max|up to)\s*\$?(\d{3,5})/);
    const maxPrice = priceMatch ? parseInt(priceMatch[1]) : null;
    const bedMatch = lowerMsg.match(/(\d)\s*(?:bed|br|bedroom)/);
    const minBeds = bedMatch ? parseInt(bedMatch[1]) : null;
    if (isAvailabilityQ || isNotTourableQ) {
      try {
        const cards = await getUnitsCards();
        console.log('Units cards total:', cards.length, 'maxPrice:', maxPrice, 'minBeds:', minBeds);
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
            return addr + (beds ? ' — ' + beds : '') + (rent ? ', ' + rent : '') + (avail ? ', avail ' + avail : '') + occupied;
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
        // getApplicantsCards fetches with schema mapping so field names are human-readable
        let cards = await getApplicantsCards();
        console.log('Applications fetched:', cards.length, 'searchTerm:', searchTerm);
        if (cards.length > 0) console.log('First card keys:', Object.keys(cards[0]).slice(0, 15).join(', '));
        // Filter by address if provided
        const filtered = searchTerm
          ? cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(searchTerm.toLowerCase().split(' ')[0]); })
          : cards;
        if (filtered.length > 0) {
          const s = filtered[0];
          console.log('Sample values — Primary Applicant:', JSON.stringify(s['Primary Applicant']), 'Application Location:', JSON.stringify(s['Application Location']), 'name:', JSON.stringify(s.name));
        }
        // Group by stage
        const active = filtered.filter(function(c) { return String(c.stage || c.Stage || '').includes('Progress'); });
        const approved = filtered.filter(function(c) { return c['Application Approved'] === 'checked' || c['Application Approved'] === true || c.appApproved === true; });
        const fmt = function(c) {
          // Use raw camelCase fields + schema-mapped custom fields
          const applicant = c['Primary Applicant'] || c.name || '?';
          const loc = c['Application Location'] || '(no address)';
          const complete = c['Application Complete'] || c.appInputCompleted || '';
          const isApproved = c['Application Approved'] === 'checked' || c.appApproved === true;
          return loc + ' — ' + applicant +
            (isApproved ? ' ✓ APPROVED' : '') +
            (complete === 'All Applicants' ? ' (complete)' : '');
        };
        if (filtered.length > 0) {
          let text = 'Applications' + (searchTerm ? ' for ' + searchTerm : '') + ' (' + filtered.length + ' total';
          if (active.length > 0) text += ', ' + active.length + ' in progress';
          if (approved.length > 0) text += ', ' + approved.length + ' approved';
          text += '):\n\n' + filtered.map(fmt).join('\n') + '\n\nAsk about any applicant for more details.';
          return res.json({ content: [{ type: 'text', text }] });
        } else {
          return res.json({ content: [{ type: 'text', text: 'No applications found' + (searchTerm ? ' for ' + searchTerm : '') + ' in the Applicants board.' }] });
        }
      } catch(e) {
        console.error('Applications shortcut error:', e.message, e.stack);
      }
    }

    // Server-side shortcut for showing schedule questions
    const isShowingQ = lowerMsg.match(/showing|scheduled tour|who.*tour|tour.*today|showing.*today|today.*showing|past.*tour|recent.*tour/);
    if (isShowingQ) {
      try {
        // Search specifically for showing-related cards by querying multiple stages
        const showingStages = ['Scheduled Tour', 'Tour Completed', 'Tour Canceled / No Show'];
        let allShowings = [];
        for (const stage of showingStages) {
          const data = await aptlyFetch('/aptlet/4EMDSYKirhQaNdQKz', { page: 0, query: stage });
          const cards = (data && data.cards) || (Array.isArray(data) ? data : []);
          const matches = cards.filter(function(c) { return c.Stage === stage || c['Requested Showing Information']; });
          allShowings = allShowings.concat(matches);
        }
        // Deduplicate by _id
        const seen = {};
        allShowings = allShowings.filter(function(c) { if (seen[c._id]) return false; seen[c._id] = true; return true; });
        const today = new Date();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const yyyy = today.getFullYear();
        const todayStr = mm + '/' + dd + '/' + yyyy;
        const yday = new Date(today); yday.setDate(yday.getDate() - 1);
        const ymm = String(yday.getMonth() + 1).padStart(2, '0');
        const ydd = String(yday.getDate()).padStart(2, '0');
        const yesterdayStr = ymm + '/' + ydd + '/' + yyyy;
        const fmt = function(c) {
          const contact = c['Primary Contact'] || '?';
          const unit = c.Unit || c['Preferred Rental'] || '?';
          const info = c['Requested Showing Information'] || '';
          const timeMatch = info.match(/\(([^)]+)\)/);
          const time = timeMatch ? timeMatch[1] : (c['Tour Date/Time'] || '');
          const status = c['Requested Showing Status'] || c.Stage || '';
          return contact + ' @ ' + unit + (time ? ' — ' + time : '') + (status ? ' [' + status + ']' : '');
        };
        let text;
        if (lowerMsg.match(/past|recent|yesterday|last.*2|2.*day/)) {
          const recent = allShowings.filter(function(c) {
            const info = c['Requested Showing Information'] || '';
            return info.includes(todayStr) || info.includes(yesterdayStr);
          });
          text = recent.length > 0
            ? 'Showings in the past 2 days (' + recent.length + '):\n\n' + recent.map(fmt).join('\n')
            : 'No showings found for today or yesterday.';
        } else if (lowerMsg.includes('today')) {
          const todayShowings = allShowings.filter(function(c) {
            const info = c['Requested Showing Information'] || '';
            return info.includes(todayStr);
          });
          const scheduled = allShowings.filter(function(c) { return c.Stage === 'Scheduled Tour'; });
          text = todayShowings.length > 0
            ? 'Showings for today ' + todayStr + ' (' + todayShowings.length + '):\n\n' + todayShowings.map(fmt).join('\n')
            : 'No showings found for today (' + todayStr + ').' + (scheduled.length > 0 ? '\n\nUpcoming scheduled tours (' + scheduled.length + '):\n' + scheduled.slice(0, 5).map(fmt).join('\n') : '');
        } else {
          const scheduled = allShowings.filter(function(c) { return c.Stage === 'Scheduled Tour'; });
          text = scheduled.length > 0
            ? 'Scheduled tours (' + scheduled.length + '):\n\n' + scheduled.map(fmt).join('\n')
            : 'No upcoming scheduled tours.\n\nRecent showing activity (' + allShowings.length + '):\n' + allShowings.slice(0, 10).map(fmt).join('\n');
        }
        return res.json({ content: [{ type: 'text', text }] });
      } catch(e) {
        console.error('Showing shortcut error:', e.message);
      }
    }

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
          system: SYSTEM_PROMPT + (KNOWLEDGE_BASE && i === 0 ? '\n\n---\nKEY OPERATIONAL KNOWLEDGE (from Notion):\n' + KNOWLEDGE_BASE.slice(0, 6000) : ''),
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
        // Trim large results to prevent context overflow (30k TPM rate limit)
        if (typeof result === 'string' && result.length > 12000) {
          try {
            const parsed = JSON.parse(result);
            // If it's an array, limit to 20 items and strip bulky fields
            if (Array.isArray(parsed)) {
              const trimmed = parsed.slice(0, 20).map(function(item) {
                // Remove large photo/file arrays and long descriptions
                const clean = Object.assign({}, item);
                delete clean['Property Photos'];
                delete clean['Mirror Marketing Description'];
                delete clean['Marketing Description'];
                delete clean.comments;
                delete clean['Files'];
                return clean;
              });
              result = JSON.stringify({ 
                total: parsed.length, 
                shown: trimmed.length, 
                note: parsed.length > 20 ? 'Results trimmed — ' + (parsed.length - 20) + ' more not shown' : undefined,
                data: trimmed 
              });
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
            result = result.slice(0, 12000) + '...[truncated]';
          }
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

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    anthropic: !!ANTHROPIC_API_KEY,
    rentvine: !!(RENTVINE_API_KEY && RENTVINE_API_SECRET),
    aptly: !!APTLY_TOKEN,
    notion: !!NOTION_TOKEN,
    slack: !!SLACK_TOKEN,
  });
});

app.get('/debug/properties', async function(req, res) {
  const data = await rvFetch('/properties/export', { pageSize: 200 });
  res.json(data);
});

app.get('/debug/units', async function(req, res) {
  const data = await rvFetch('/units/export', { pageSize: 200 });
  res.json(data);
});

app.get('/reload-knowledge', async function(req, res) {
  await loadKnowledgeBase();
  res.json({ loaded: true, chars: KNOWLEDGE_BASE.length });
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

app.get('*', function(req, res) {
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

const SUGGESTIONS = [
  {icon:"🏠", text:"What units are available right now?"},
  {icon:"💰", text:"What does [tenant name] owe and what is it from?"},
  {icon:"👥", text:"What new leads came in this week?"},
  {icon:"📋", text:"What's our lease break policy?"},
  {icon:"🔧", text:"Show me all open work orders"},
  {icon:"🔍", text:"Any inspections scheduled this week?"},
  {icon:"💬", text:"Any recent announcements in Slack?"},
  {icon:"🏚️", text:"How is [owner name]'s property performing?"},
];

const SOURCES = [
  {label:"Rentvine",bg:"#e6f0fb",border:"#85B7EB"},
  {label:"Aptly",   bg:"#EAF3DE",border:"#97C459"},
  {label:"Notion",  bg:"#f5f5f5",border:"#d0d0d0"},
  {label:"Slack",   bg:"#f0e6f6",border:"#c17edb"},
];

function renderMd(text) {
  if (!text) return null;
  const bold = s => s.split(/\\*\\*(.*?)\\*\\*/).map((p,i) =>
    i%2===1 ? React.createElement('strong',{key:i,style:{fontWeight:500}},p) : p
  );
  return text.split("\\n").map((line,key) => {
    if (!line.trim()) return React.createElement('div',{key,style:{height:6}});
    if (line.match(/^#{1,3}\\s/)) return React.createElement('p',{key,style:{fontWeight:500,marginBottom:4,marginTop:8}},bold(line.replace(/^#+\\s/,"")));
    if (line.match(/^[-•]\\s/)) return React.createElement('div',{key,style:{display:"flex",gap:8,marginBottom:3}},
      React.createElement('span',{style:{color:"#888",flexShrink:0}},"•"),
      React.createElement('span',null,bold(line.replace(/^[-•]\\s/,"")))
    );
    if (line.match(/^\\d+\\.\\s/)) return React.createElement('div',{key,style:{display:"flex",gap:8,marginBottom:3}},
      React.createElement('span',{style:{color:"#888",flexShrink:0,minWidth:18}},line.match(/^(\\d+)/)[1]+"."),
      React.createElement('span',null,bold(line.replace(/^\\d+\\.\\s/,"")))
    );
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
  useEffect(()=>{ ref.current?.focus(); },[]);
  const attempt = () => {
    if (val===PASSCODE) { onUnlock(); }
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
  const [lastError,setLastError] = useState("");
  const endRef = useRef(null);
  const taRef = useRef(null);
  useEffect(()=>{ endRef.current?.scrollIntoView({behavior:"smooth"}); },[messages,loading]);

  const send = async (text) => {
    const msg = (text||input).trim();
    if (!msg||loading) return;
    setInput(""); setLastError("");
    if (taRef.current) taRef.current.style.height="auto";
    const next = [...messages,{role:"user",content:msg}];
    setMessages(next); setLoading(true);
    try {
      const res = await fetch('/api/chat',{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:next.map(m=>({role:m.role,content:m.content}))})});
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const txt = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\\n")||"Sorry, try again.";
      setMessages([...next,{role:"assistant",content:txt}]);
    } catch(e) { setLastError(e.message); setMessages([...next,{role:"assistant",content:"Something went wrong — see error above."}]); }
    setLoading(false);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh"}}>
      {lastError && <div style={{padding:"8px 16px",background:"#fff5f5",borderBottom:"1px solid #fed7d7",display:"flex",justifyContent:"space-between",flexShrink:0}}><span style={{fontSize:12,color:"#c53030"}}>⚠ {lastError}</span><button onClick={()=>setLastError("")} style={{background:"none",border:"none",cursor:"pointer",color:"#c53030",fontSize:16}}>×</button></div>}
      <div style={{display:"flex",alignItems:"center",padding:"12px 16px",background:"white",borderBottom:"1px solid #f0f0f0",flexShrink:0,gap:10}}>
        <div style={{width:36,height:36,borderRadius:8,background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🌿</div>
        <div>
          <div style={{fontSize:15,fontWeight:600,color:"#1a1a1a"}}>Aloe Assistant</div>
          <div style={{fontSize:11,color:"#888"}}>Rentvine · Aptly · Notion · Slack · All live</div>
        </div>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"20px 16px"}}>
        {messages.length===0 ? (
          <div style={{minHeight:400,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:24}}>
            <div style={{textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:10}}>🌿</div>
              <div style={{fontSize:20,fontWeight:600,color:"#1a1a1a",marginBottom:6}}>Hi, I'm Aloe</div>
              <div style={{fontSize:14,color:"#666",maxWidth:420,lineHeight:1.6}}>Ask me anything — tenant balances, available homes, leads, policies, work orders, inspections, or team updates.</div>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
              {SOURCES.map(s=>React.createElement('div',{key:s.label,style:{padding:"3px 10px",borderRadius:20,background:s.bg,border:\`1px solid \${s.border}\`,fontSize:12,color:"#333"}},s.label))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2, minmax(0, 1fr))",gap:8,width:"100%",maxWidth:540}}>
              {SUGGESTIONS.map((s,i)=>(
                <button key={i} className="chip" onClick={()=>send(s.text)} style={{background:"white",border:"1px solid #f0f0f0",borderRadius:8,padding:"10px 12px",cursor:"pointer",textAlign:"left",fontSize:13,color:"#666",lineHeight:1.4,display:"flex",alignItems:"flex-start",gap:6,transition:"background 0.1s"}}>
                  <span style={{fontSize:14,flexShrink:0}}>{s.icon}</span>{s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{maxWidth:680,width:"100%",margin:"0 auto"}}>
            {messages.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
                {m.role==="assistant"&&<div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0,marginRight:8,marginTop:2}}>🌿</div>}
                <div style={{maxWidth:"78%",padding:"10px 14px",borderRadius:m.role==="user"?"12px 12px 4px 12px":"12px 12px 12px 4px",background:m.role==="user"?"#EAF3DE":"white",border:\`1px solid \${m.role==="user"?"#97C459":"#f0f0f0"}\`,color:m.role==="user"?"#173404":"#1a1a1a",fontSize:14,lineHeight:1.6}}>
                  {m.role==="assistant"?renderMd(m.content):m.content}
                </div>
              </div>
            ))}
            {loading&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>🌿</div><div style={{padding:"10px 14px",background:"white",border:"1px solid #f0f0f0",borderRadius:"12px 12px 12px 4px"}}><Dots/></div></div>}
            <div ref={endRef}/>
          </div>
        )}
      </div>
      <div style={{padding:"12px 16px",background:"white",borderTop:"1px solid #f0f0f0",flexShrink:0}}>
        <div style={{maxWidth:680,margin:"0 auto",display:"flex",gap:8,alignItems:"flex-end"}}>
          <textarea ref={taRef} value={input} onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Ask about tenants, balances, leads, properties, policies, work orders, inspections..." rows={1} style={{flex:1,padding:"9px 12px",background:"#f9f9f7",border:"1px solid #e5e5e5",borderRadius:8,color:"#1a1a1a",fontSize:14,fontFamily:"inherit",resize:"none",lineHeight:1.5,minHeight:38,maxHeight:120}}/>
          <button onClick={()=>send()} disabled={!input.trim()||loading} style={{width:38,height:38,borderRadius:8,background:input.trim()&&!loading?"#3B6D11":"#f0f0f0",border:"none",cursor:input.trim()&&!loading?"pointer":"default",color:input.trim()&&!loading?"white":"#aaa",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>↑</button>
        </div>
        <div style={{textAlign:"center",fontSize:11,color:"#aaa",marginTop:6}}>Rentvine · Aptly · Notion · Slack · All data is live</div>
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
app.listen(PORT, () => console.log('Aloe Assistant running on port ' + PORT));
