import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/api/chat', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
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
- For ANY policy, procedure, training, or operational question: use kb_search. The KB is the single source of truth.
- CRITICAL FEE FACTS — never get these wrong: Earnest deposit = $1,500 (NOT $500). Application fee = $65 per adult. Cleaning fee = $500 (move-out, non-refundable). Admin fee = $250. Pet fee = $250 per pet. Security deposit = 1x monthly rent. The $500 is the CLEANING FEE, not the earnest deposit.
- For pre-loaded topic content: when the user's question matches a topic with pre-loaded KB content (water leaks, pest control, HVAC, work orders, vendors, cost benchmarks, etc.), the relevant KB content is INJECTED into your context above as "RELEVANT KB CONTENT". Use that directly — do NOT call kb_search again for the same topic.
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
        const p = { pageSize: 100, page: 1 };
        if (input.propertyId) p.propertyID = input.propertyId;
        const data = await rvFetch('/maintenance/work-orders', p);
        let rawWOs = Array.isArray(data) ? data : (data && data.data) || [];
        let allWOs = rawWOs.map(function(rec) {
          if (rec.workOrder) {
            return Object.assign({}, rec.workOrder, {
              unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
              vendorName: (rec.contact && rec.contact.name) || '',
            });
          }
          return rec;
        }).filter(function(wo) { return wo.workOrderID; });
        let filtered = allWOs;
        if (input.status === 'closed') {
          filtered = allWOs.filter(function(wo) {
            const sid = parseInt(wo.primaryWorkOrderStatusID);
            return sid === 4 || sid === 5;
          });
        } else {
          filtered = allWOs.filter(function(wo) {
            const sid = parseInt(wo.primaryWorkOrderStatusID);
            return sid !== 4 && sid !== 5;
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
        const [rvData, aptlyData] = await Promise.all([
          rvFetch('/maintenance/work-orders', { pageSize: 100, page: 1 }),
          unitsFetch('/api/board/workOrder', { page: 0, pageSize: 100, includeArchived: false }),
        ]);
        const rvRaw = Array.isArray(rvData) ? rvData : [];
        const rvWOs = rvRaw.map(function(rec) {
          return rec.workOrder ? Object.assign({}, rec.workOrder, {
            unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
            vendorName: (rec.contact && rec.contact.name) || '',
          }) : rec;
        }).filter(function(wo) {
          return wo.workOrderID && parseInt(wo.primaryWorkOrderStatusID) !== 4 && parseInt(wo.primaryWorkOrderStatusID) !== 5;
        });
        const aptlyRaw = Array.isArray(aptlyData) ? aptlyData : (aptlyData && aptlyData.data) || [];
        const aptlyWOs = aptlyRaw.filter(function(c) {
          return !c.archived && !/completed|cancelled|rejected/i.test(c.stage || '');
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
          if (!num) { aptlyOnly.push({ number: 'no number', title: c.description || c.name, aptlyStage: c.stage, property: (c.unit && c.unit.name) || '' }); return; }
          const rv = rvByNumber[num];
          if (!rv) {
            aptlyOnly.push({ number: num, title: c.description || c.name, aptlyStage: c.stage, property: (c.unit && c.unit.name) || '' });
          } else {
            const rvStatusId = parseInt(rv.primaryWorkOrderStatusID);
            const aptlyStage = (c.stage || '').toLowerCase();
            const rvIsOpen = rvStatusId <= 2;
            const aptlyIsOpen = !/completed|cancelled|rejected/i.test(aptlyStage);
            if (rvIsOpen !== aptlyIsOpen) {
              statusMismatch.push({ number: num, title: c.description || c.name, aptlyStage: c.stage, rvStatusId: rvStatusId, property: (c.unit && c.unit.name) || rv.unitAddress || '' });
            } else {
              matched.push({ number: num, title: c.description || c.name, aptlyStage: c.stage, rvStatusId: rvStatusId });
            }
          }
        });
        const rvOnly = rvWOs.filter(function(wo) {
          return wo.workOrderNumber && !aptlyByNumber[String(wo.workOrderNumber)];
        }).map(function(wo) {
          return { number: String(wo.workOrderNumber), title: wo.description || '?', rvStatusId: wo.primaryWorkOrderStatusID, property: wo.unitAddress || '' };
        });
        return JSON.stringify({
          summary: { rvTotal: rvWOs.length, aptlyTotal: aptlyWOs.length, matched: matched.length, aptlyOnly: aptlyOnly.length, rvOnly: rvOnly.length, statusMismatch: statusMismatch.length },
          aptlyOnly, rvOnly, statusMismatch,
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
        let page = 0;
        while (true) {
          const params = { page, pageSize: 100, includeArchived: false };
          const data = await unitsFetch('/api/board/workOrder', params);
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          const active = batch.filter(function(c) { return !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''); });
          allWOs = allWOs.concat(active);
          if (batch.length < 100) break;
          if (page >= 1) break;
          page++;
        }
        let filtered = allWOs;
        if (input.status) {
          const s = input.status.toLowerCase();
          if (s === 'open' || s === 'not closed') {
            filtered = allWOs;
          } else {
            filtered = allWOs.filter(function(c) { return (c.stage || '').toLowerCase().includes(s); });
          }
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
        const unassigned = open.filter(function(c) { return !c.vendor; });
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
          const address = (locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '';
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
  }
  if (msg.match(/availab|unit|vacant|propert|homes?|house|bed|bath|address|\d{4,5}|tour|showing|work.?done|inspect|ready|make.?ready/)) {
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
              system: `You are a maintenance cost advisor for Aloe Property Management in Phoenix, AZ.
Use the benchmark data below to evaluate vendor quotes. Always give a clear verdict:
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

    // Server-side shortcut for new/recently onboarded properties
    const isOnboardQ = lowerMsg.match(/onboard|new prop|recently add|new.*unit|unit.*new|propert.*add|add.*propert|when.*add|portfolio.*grow|grow.*portfolio/);
    if (isOnboardQ) {
      try {
        const daysMatch = lowerMsg.match(/(\d+)\s*(?:day|week|month)/);
        let daysBack = 90;
        if (daysMatch) {
          const n = parseInt(daysMatch[1]);
          if (lowerMsg.includes('week')) daysBack = n * 7;
          else if (lowerMsg.includes('month')) daysBack = n * 30;
          else daysBack = n;
        }
        const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
        const locSchema = await unitsFetch('/api/schema/location');
        const locMap = {};
        if (Array.isArray(locSchema)) locSchema.forEach(function(f) { locMap[f.key] = f.label; });
        let allLocations = [];
        let page = 0;
        while (true) {
          const data = await unitsFetch('/api/board/location', { page, pageSize: 100 });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          allLocations = allLocations.concat(batch);
          if (batch.length < 100) break;
          page++;
        }
        const mapped = allLocations.map(function(card) {
          const m = {};
          Object.keys(card).forEach(function(k) { m[locMap[k] || k] = card[k]; });
          return m;
        });
        const parseDate = function(raw) {
          if (!raw) return null;
          const mmdd = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (mmdd) { try { return new Date(mmdd[3]+'-'+mmdd[1].padStart(2,'0')+'-'+mmdd[2].padStart(2,'0')).getTime(); } catch(e) {} }
          try { const ms = new Date(raw).getTime(); return isNaN(ms) ? null : ms; } catch(e) { return null; }
        };
        const getOnboardMs = function(c) {
          return parseDate(c['Date Contract Begins'] || '') || parseDate(c['Created At'] || '') || null;
        };
        const newProps = mapped.filter(function(c) {
          const ms = getOnboardMs(c);
          return ms !== null && ms > cutoffMs;
        }).sort(function(a, b) { return (getOnboardMs(b) || 0) - (getOnboardMs(a) || 0); });
        const extractOwner = function(c) {
          const raw = c['Owner'] || c['Portfolio'] || '';
          if (Array.isArray(raw)) return raw.map(function(o) { return typeof o === 'object' ? (o.name || '') : String(o); }).filter(Boolean).join(', ');
          if (typeof raw === 'object') return raw.name || '';
          return String(raw || '');
        };
        const fmt = function(c) {
          const addr = c['Street'] || c.name || '?';
          const city = c['City'] || '';
          const type = c['Property Type'] || '';
          const owner = extractOwner(c);
          const onboardMs = getOnboardMs(c);
          const onboardDate = onboardMs ? new Date(onboardMs).toLocaleDateString('en-US', {month:'numeric',day:'numeric',year:'numeric'}) : '';
          const contractDate = parseDate(c['Date Contract Begins'] || '') ? new Date(parseDate(c['Date Contract Begins'])).toLocaleDateString('en-US', {month:'numeric',day:'numeric',year:'numeric'}) : '';
          return addr + (city ? ', ' + city : '') + (type ? ' (' + type + ')' : '') +
            (owner ? '\n  Owner: ' + owner : '') +
            (onboardDate ? '\n  Added: ' + onboardDate : '') +
            (contractDate ? '\n  Contract started: ' + contractDate : '');
        };
        if (newProps.length > 0) {
          return res.json({ content: [{ type: 'text', text: 'Properties onboarded in the last ' + daysBack + ' days (' + newProps.length + '):\n\n' + newProps.map(fmt).join('\n\n') }] });
        } else {
          const withContract = mapped.filter(function(c) { return getOnboardMs(c) !== null; })
            .sort(function(a, b) { return (getOnboardMs(b) || 0) - (getOnboardMs(a) || 0); });
          const top = withContract.slice(0, 10);
          return res.json({ content: [{ type: 'text', text: 'No new properties in last ' + daysBack + ' days. Most recently onboarded by contract date (total: ' + withContract.length + '):\n\n' + top.map(fmt).join('\n\n') }] });
        }
      } catch(e) {
        console.error('Onboard shortcut error:', e.message);
      }
    }

    // Server-side shortcut for move-ins questions
    const isMoveInQ = lowerMsg.match(/move.?in|moving in|move ins|movein/) && lowerMsg.match(/upcoming|next week|this week|today|scheduled|coming up|when|what|list|show/);
    if (isMoveInQ) {
      try {
        const schemaData = await unitsFetch('/api/schema/K9mMGGjKgQPqDykaa');
        const schemaMap = {};
        if (Array.isArray(schemaData)) schemaData.forEach(function(f) { schemaMap[f.key] = f.label; });
        let allCards = [];
        let pg = 0;
        while (true) {
          const data = await unitsFetch('/api/board/K9mMGGjKgQPqDykaa', { page: pg, pageSize: 50 });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          const mapped = batch.map(function(card) {
            const m = { _stage: card.stage, _cardId: card.cardId };
            Object.keys(card).forEach(function(k) { m[schemaMap[k] || k] = card[k]; });
            return m;
          });
          allCards = allCards.concat(mapped);
          if (batch.length < 50) break;
          pg++;
          if (pg > 5) break;
        }
        const azNow = new Date(Date.now() - 7 * 60 * 60 * 1000);
        const azToday = new Date(azNow); azToday.setHours(0,0,0,0);
        const strField = function(v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return v.map(function(i) { return typeof i === 'object' ? (i.name || i.label || i.value || '') : String(i); }).filter(Boolean).join(', ');
          if (typeof v === 'object') return v.name || v.label || v.value || v.amount || '';
          return String(v);
        };
        const parseMoveinDate = function(c) {
          const raw = strField(c['Mirror Move-In Date'] || c['Mirror Offer Move In'] || '');
          if (!raw) return null;
          const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (m) { try { return new Date(m[3]+'-'+m[1].padStart(2,'0')+'-'+m[2].padStart(2,'0')).getTime(); } catch(e) {} }
          try { const ms = new Date(raw).getTime(); return isNaN(ms) ? null : ms; } catch(e) { return null; }
        };
        const todayMs = azToday.getTime();
        let windowStart = todayMs;
        let windowEnd = todayMs + 14 * 24 * 60 * 60 * 1000;
        let windowLabel = 'upcoming (next 14 days)';
        if (lowerMsg.includes('next week')) {
          const dow = azToday.getDay();
          const daysToNextMon = dow === 0 ? 1 : 8 - dow;
          windowStart = todayMs + daysToNextMon * 24 * 60 * 60 * 1000;
          windowEnd = windowStart + 7 * 24 * 60 * 60 * 1000;
          windowLabel = 'next week';
        } else if (lowerMsg.includes('this week')) {
          const dow = azToday.getDay();
          windowStart = todayMs - dow * 24 * 60 * 60 * 1000;
          windowEnd = windowStart + 7 * 24 * 60 * 60 * 1000;
          windowLabel = 'this week';
        } else if (lowerMsg.includes('today')) {
          windowEnd = todayMs + 24 * 60 * 60 * 1000;
          windowLabel = 'today';
        }
        const excluded = /abandoned|moved in/i;
        const filtered = allCards.filter(function(c) {
          if (excluded.test(c._stage || '')) return false;
          const ms = parseMoveinDate(c);
          return ms !== null && ms >= windowStart && ms < windowEnd;
        }).sort(function(a, b) { return (parseMoveinDate(a) || 0) - (parseMoveinDate(b) || 0); });
        const fmt = function(c) {
          const title = strField(c['Title'] || c.name || '');
          const titleMatch = title.match(/^\d{2}\/\d{2}\/\d{4}\s+(.+?)\s+\d+\s+[A-Z]/);
          const residents = titleMatch ? titleMatch[1].replace(/;/g, ' &') : (strField(c['Mirror Residents']) || title);
          const addr = strField(c['Mirror Address']) || strField(c['Buildings']) || strField(c['Unit']) || '';
          const date = strField(c['Mirror Move-In Date']) || '';
          const rentRaw = c['Mirror Rent Amount'];
          const rent_str = typeof rentRaw === 'object' && rentRaw ? '$' + Number(rentRaw.amount).toLocaleString() : strField(rentRaw).replace('$ ', '$');
          const stage = c._stage || '';
          return '• ' + residents + (addr ? '\n  ' + addr : '') +
            (date ? '\n  Move-in: ' + date : '') +
            (rent_str ? ' — ' + rent_str + '/mo' : '') +
            (stage ? ' [' + stage + ']' : '');
        };
        const text = filtered.length > 0
          ? 'Move-ins ' + windowLabel + ' (' + filtered.length + '):\n\n' + filtered.map(fmt).join('\n\n')
          : 'No move-ins found for ' + windowLabel + '. Total active cards: ' + allCards.filter(function(c) { return !excluded.test(c._stage || ''); }).length;
        return res.json({ content: [{ type: 'text', text }] });
      } catch(e) {
        console.error('Move-in shortcut error:', e.message);
      }
    }

    // Server-side shortcut for recurring category issues across all work orders
    const isRecurringQ = lowerMsg.match(/recurring|came back|again|multiple.*time|more than once|history.*issue|issue.*history|closed.*work.*order|billed.*work.*order|past.*year|within.*year|how many times|repeat.*hvac|hvac.*repeat|same.*hvac|hvac.*same|hvac.*issue|plumb.*repeat|repeat.*plumb|repeat.*appliance|appliance.*repeat|repeat.*electric|same.*issue.*before|previous.*issue|pattern|trend/);
    if (isRecurringQ) {
      try {
        let catFilter = '';
        if (lowerMsg.match(/hvac|ac\b|air.?condition|heat/)) catFilter = 'HVAC';
        else if (lowerMsg.match(/plumb|toilet|drain|leak|pipe/)) catFilter = 'Plumbing';
        else if (lowerMsg.match(/electric|outlet|light/)) catFilter = 'Electrical';
        else if (lowerMsg.match(/appliance|fridge|dishwasher|washer|dryer|microwave/)) catFilter = 'Appliance';
        else if (lowerMsg.match(/roof/)) catFilter = 'Roofing';
        const daysMatch = lowerMsg.match(/(\d+)\s*(?:day|month|year)/);
        let daysBack = 730;
        if (daysMatch) {
          const n = parseInt(daysMatch[1]);
          if (lowerMsg.includes('month')) daysBack = n * 30;
          else if (lowerMsg.includes('year')) daysBack = n * 365;
          else daysBack = n;
        }
        const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
        const categorizeRV = function(desc) {
          const d = (desc || '').toLowerCase();
          if (/ac|hvac|heat|cool|air.?condition|furnace|duct|compressor/i.test(d)) return 'HVAC';
          if (/roof|shingle|tile.*roof/i.test(d)) return 'Roofing';
          if (/plumb|toilet|drain|faucet|water.*heat|pipe|sewage|clog|leak/i.test(d)) return 'Plumbing';
          if (/electric|outlet|light|breaker|switch|wir/i.test(d)) return 'Electrical';
          if (/appliance|dishwasher|washer|dryer|refrig|microwave|oven|stove|ice.?mak/i.test(d)) return 'Appliance';
          if (/pest|bug|termite|rodent/i.test(d)) return 'Pest Control';
          if (/landscap|lawn|yard|tree|palm|sprinkler/i.test(d)) return 'Landscaping';
          if (/pool|spa/i.test(d)) return 'Pool';
          return 'General';
        };
        const propIdToAddr = {};
        try {
          let propPage = 1;
          while (true) {
            const propData = await rvFetch('/properties/export', { pageSize: 200, page: propPage });
            const propBatch = Array.isArray(propData) ? propData : (propData && propData.data) || [];
            propBatch.forEach(function(p) {
              const prop = p.property || p;
              if (prop.propertyID && prop.address) propIdToAddr[String(prop.propertyID)] = prop.address;
            });
            if (propBatch.length < 200) break;
            propPage++;
          }
        } catch(e) {}
        let allWOs = [];
        for (let pg = 1; pg <= 25; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
          const lastRec = batch[batch.length - 1];
          const lastCreated = ((lastRec.workOrder || lastRec).dateTimeCreated || '');
          if (lastCreated && new Date(lastCreated).getTime() < cutoffMs) break;
        }
        const normalizeAddr2 = function(s) {
          return (s || '').toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/\bstreet\b/g, 'st').replace(/\bdrive\b/g, 'dr').replace(/\bavenue\b/g, 'ave')
            .replace(/\blane\b/g, 'ln').replace(/\broad\b/g, 'rd').replace(/\bcourt\b/g, 'ct')
            .replace(/\bplace\b/g, 'pl').replace(/\bway\b/g, 'wy').replace(/\bcircle\b/g, 'cir')
            .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's').replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w')
            .replace(/[,#]/g, '').trim();
        };
        const byAddrCat = {};
        allWOs.forEach(function(rec) {
          const rawAddr = (rec.unit && (rec.unit.address || rec.unit.name)) ||
                          (rec.property && (rec.property.address || rec.property.name)) || '';
          const wo = rec.workOrder || rec;
          const propId = String(wo.propertyID || wo.unitID || '');
          const resolvedAddr = rawAddr || (propId && propIdToAddr[propId]) || '';
          const groupKey = resolvedAddr || (propId ? 'propID:' + propId : '');
          if (!groupKey) return;
          const displayAddr = resolvedAddr || ('Property #' + propId);
          const addrKey = rawAddr ? normalizeAddr2(rawAddr) : groupKey;
          const created = wo.dateTimeCreated ? new Date(wo.dateTimeCreated).getTime() : 0;
          if (created < cutoffMs) return;
          const desc = (wo.description || '').replace(/<[^>]+>/g, ' ');
          const cat = categorizeRV(desc);
          if (catFilter && cat !== catFilter) return;
          const key = addrKey + '||' + cat;
          if (!byAddrCat[key]) byAddrCat[key] = { addr: displayAddr, cat, wos: [] };
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
          .filter(function(e) { return e.wos.length >= 2; })
          .sort(function(a, b) { return b.wos.length - a.wos.length; });
        if (flagged.length === 0) {
          return res.json({ content: [{ type: 'text', text: 'No properties found with recurring ' + (catFilter || '') + ' work orders in the last ' + daysBack + ' days.' }] });
        }
        const label = catFilter ? catFilter + ' recurring issues' : 'Recurring issue patterns';
        const lines = flagged.map(function(e) {
          const woLines = e.wos.sort(function(a,b){ return b.date.localeCompare(a.date); })
            .map(function(w) { return '  #' + w.num + ' ' + w.date + ' | ' + w.desc + ' | ' + w.status + ' | ' + w.vendor; }).join('\n');
          return e.addr + ' — ' + e.wos.length + ' ' + e.cat + ' WOs:\n' + woLines;
        });
        return res.json({ content: [{ type: 'text', text: label + ' in the last ' + daysBack + ' days (' + flagged.length + ' properties):\n\n' + lines.join('\n\n') }] });
      } catch(e) {
        console.error('Recurring shortcut error:', e.message);
      }
    }

    // Server-side shortcut for repeat issues / cross-property patterns (open WOs only)
    const isRepeatQ = lowerMsg.match(/repeat.*issue|issue.*repeat|same.*issue|same.*problem|multiple.*work.*order|same.*type|issue.*type|category|any.*propert.*same/);
    if (isRepeatQ) {
      try {
        let allWOs = [];
        let page = 0;
        while (true) {
          const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100 });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
          if (page >= 2) break;
          page++;
        }
        const categorize = function(c) {
          const trade = (c.vendorTrade || '').toLowerCase();
          const desc = (c.description || c.name || '').replace(/<[^>]+>/g, ' ').toLowerCase();
          if (/ac|hvac|heat|cool|air.?condition|furnace|duct/i.test(desc + trade)) return 'HVAC';
          if (/roof|leak.*roof|roof.*leak|shingle|tile.*roof/i.test(desc + trade)) return 'Roofing';
          if (/plumb|toilet|drain|faucet|water.*heat|pipe|sewage|clog|leak/i.test(desc + trade)) return 'Plumbing';
          if (/electric|outlet|light|breaker|switch|wir/i.test(desc + trade)) return 'Electrical';
          if (/appliance|dishwasher|washer|dryer|refrig|microwave|oven|stove|ice.?mak/i.test(desc + trade)) return 'Appliance';
          if (/pest|bug|termite|rodent|insect|cockroach/i.test(desc + trade)) return 'Pest Control';
          if (/landscap|lawn|yard|tree|bush|palm|sprinkler|irrigation/i.test(desc + trade)) return 'Landscaping';
          if (/pool|spa/i.test(desc + trade)) return 'Pool';
          if (/clean|carpet|paint|patch|drywall/i.test(desc + trade)) return 'Cleaning/Turnover';
          if (/door|lock|window|blind|screen|garage/i.test(desc + trade)) return 'Door/Window/Lock';
          if (/fence|gate|patio|deck|exterior/i.test(desc + trade)) return 'Exterior';
          if (/inspect|walkthrough|walk.?through/i.test(desc)) return 'Inspection';
          return 'General';
        };
        const byAddress = {};
        allWOs.forEach(function(c) {
          const locArr = Array.isArray(c.location) ? c.location : [];
          const unitArr = Array.isArray(c.unit) ? c.unit : [];
          const addr = (locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '';
          if (!addr) return;
          if (!byAddress[addr]) byAddress[addr] = [];
          const desc = (c.description || c.name || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          byAddress[addr].push({ num: c.workOrderNumber, desc: desc.slice(0, 55), stage: c.stage || '', category: categorize(c) });
        });
        const isSameTypeQ = lowerMsg.match(/same.*type|type.*same|category|same.*issue|issue.*type|any.*propert.*same/);
        if (isSameTypeQ) {
          const categoryAddresses = {};
          Object.entries(byAddress).forEach(function(e) {
            e[1].forEach(function(w) {
              if (!categoryAddresses[w.category]) categoryAddresses[w.category] = {};
              if (!categoryAddresses[w.category][e[0]]) categoryAddresses[w.category][e[0]] = 0;
              categoryAddresses[w.category][e[0]]++;
            });
          });
          const multiProp = Object.entries(categoryAddresses)
            .filter(function(e) { return Object.keys(e[1]).length >= 2; })
            .sort(function(a, b) { return Object.keys(b[1]).length - Object.keys(a[1]).length; });
          if (multiProp.length === 0) {
            return res.json({ content: [{ type: 'text', text: 'No issue categories currently appear across multiple properties.' }] });
          }
          const lines = multiProp.map(function(e) {
            const cat = e[0], addrs = e[1];
            const addrLines = Object.entries(addrs).map(function(a) { return '  ' + a[0] + ' (' + a[1] + ' WO' + (a[1] > 1 ? 's' : '') + ')'; }).join('\n');
            return cat + ' — ' + Object.keys(addrs).length + ' properties:\n' + addrLines;
          });
          return res.json({ content: [{ type: 'text', text: 'Issue categories affecting multiple properties:\n\n' + lines.join('\n\n') }] });
        }
        const repeats = Object.entries(byAddress)
          .filter(function(e) { return e[1].length >= 2; })
          .sort(function(a, b) { return b[1].length - a[1].length; });
        if (repeats.length === 0) {
          return res.json({ content: [{ type: 'text', text: 'No properties have multiple open work orders currently.' }] });
        }
        const lines = repeats.map(function(e) {
          const addr = e[0], wos = e[1];
          const woList = wos.map(function(w) { return '  #' + w.num + ' [' + w.category + '] ' + w.desc + ' (' + w.stage + ')'; }).join('\n');
          return addr + ' (' + wos.length + ' open WOs):\n' + woList;
        });
        return res.json({ content: [{ type: 'text', text: 'Properties with multiple open work orders (' + repeats.length + ' properties):\n\n' + lines.join('\n\n') }] });
      } catch(e) {
        console.error('Repeat issues shortcut error:', e.message);
      }
    }

    // Server-side shortcut for work order comment intelligence
    const isWOCommentQ = lowerMsg.match(/comment|no comment|no note|follow.?up|without comment|has comment|have comment|vendor.*said|vendor.*update|waiting|blocked|overdue.*comment|need.*follow/) &&
      (lowerMsg.match(/work.?order/) || lowerMsg.match(/[0-9]{3,5}\s+\w+.*(?:drive|street|ave|lane|road|way|court|place|blvd|trail|circle)/i));
    if (isWOCommentQ) {
      try {
        const wantNoComments = lowerMsg.match(/no comment|no note|without comment|haven.t|not have|lacking|no follow/);
        const wantFollowUp = lowerMsg.match(/follow.?up|overdue|need.*action|past.*date|need.*response/);
        const wantVendorUpdates = lowerMsg.match(/vendor.*said|vendor.*update|vendor.*note|what.*vendor|vendor.*comment/);
        const wantWaiting = lowerMsg.match(/waiting|blocked|on hold|waiting for|pending/);
        const addrMatch = lowerMsg.match(/(?:for|at|on)\s+([0-9]+\s+[a-z].{5,40}?)(?:\?|$)/i) ||
                          lowerMsg.match(/([0-9]{3,5}\s+(?:west|east|north|south|w\.|e\.|n\.|s\.)?.{5,35}?)(?:\?|$)/i);
        let allWOs = [];
        let pg = 0;
        while (true) {
          const data = await unitsFetch('/api/board/workOrder', { page: pg, pageSize: 100, includeArchived: false });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          const active = batch.filter(function(c) { return !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''); });
          allWOs = allWOs.concat(active);
          if (batch.length < 100) break;
          if (pg >= 1) break;
          pg++;
        }
        if (addrMatch) {
          const q = addrMatch[1].toLowerCase().trim().split(' ').slice(0,3).join(' ');
          const filtered = allWOs.filter(function(c) {
            const locArr = Array.isArray(c.location) ? c.location : [];
            const unitArr = Array.isArray(c.unit) ? c.unit : [];
            const addr = ((locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '').toLowerCase();
            return addr.includes(q);
          });
          if (filtered.length > 0) allWOs = filtered;
        }
        const cardsToCheck = allWOs;
        const commentResults = await Promise.all(cardsToCheck.map(async function(c) {
          try {
            const data = await unitsFetch('/api/board/workOrder/' + c.cardId + '/comments');
            return { cardId: c.cardId, comments: Array.isArray(data) ? data : (data && data.data) || [] };
          } catch(e) { return { cardId: c.cardId, comments: [] }; }
        }));
        const commentsMap = {};
        commentResults.forEach(function(r) { commentsMap[r.cardId] = r.comments; });
        const todayMs = Date.now();
        const todayStr = new Date(todayMs - 7*60*60*1000).toISOString().slice(0,10);
        const getAddr = function(c) {
          const l = Array.isArray(c.location) ? c.location : []; const u = Array.isArray(c.unit) ? c.unit : [];
          return (l[0] && l[0].name) || (u[0] && u[0].name) || '?';
        };
        const getVendor = function(c) {
          const v = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          return (v[0] && v[0].name) || 'Unassigned';
        };
        const getDesc = function(c) {
          return (c.description || c.name || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ').trim().split(/\s+/).slice(0,5).join(' ');
        };
        const getSchedDate = function(c) {
          const key = 'appointmentWindowStartDateTime';
          const raw = c[key] || '';
          return raw ? String(raw).slice(0,10) : '';
        };
        const isAddressSpecific = !!(addrMatch && addrMatch[1].length > 5);
        if (isAddressSpecific) {
          const lines = allWOs.map(function(s) {
            const addr = getAddr(s);
            const comments = commentsMap[s.cardId] || [];
            const desc = getDesc(s);
            const vendor = getVendor(s);
            const header = addr + ' — WO #' + (s.workOrderNumber||'') + ' | ' + desc + ' | ' + (s.stage||'') + ' | ' + vendor;
            const commentLines = comments.length > 0
              ? comments.map(function(cm) { return '  → ' + (cm.userName||'Unknown') + ' (' + (cm.createdAt||'').slice(0,10) + '): ' + (cm.content||'').slice(0,150); }).join('\n')
              : '  (no comments yet)';
            return header + '\n' + commentLines;
          });
          return res.json({ content: [{ type: 'text', text: 'Work order comments for ' + (addrMatch[1]||'property') + ':\n\n' + lines.join('\n\n') }] });
        }
        const scored = allWOs.map(function(c) {
          const comments = commentsMap[c.cardId] || [];
          const commentCount = comments.length;
          const lastComment = comments.length > 0 ? comments[comments.length-1] : null;
          const lastCommentDate = lastComment ? (lastComment.createdAt || '').slice(0,10) : '';
          const lastCommentText = lastComment ? (lastComment.content || '').slice(0,120) : '';
          const lastCommentUser = lastComment ? (lastComment.userName || 'Unknown') : '';
          const daysSinceComment = lastCommentDate ? Math.floor((todayMs - new Date(lastCommentDate).getTime()) / 86400000) : null;
          const schedDate = getSchedDate(c);
          const isPastSched = schedDate && schedDate < todayStr;
          const created = c.createdAt ? new Date(c.createdAt).getTime() : 0;
          const daysOpen = created ? Math.floor((todayMs - created) / 86400000) : 0;
          const allCommentText = comments.map(function(cm) { return (cm.content||'').toLowerCase(); }).join(' ');
          const isWaiting = /waiting|wait for|on hold|parts.*order|parts.*coming|order.*part|approval|awaiting/.test(allCommentText);
          const vendorComments = comments.filter(function(cm) {
            return !(cm.userName||'').match(/dhyana|roberto|persia|randi|alexes|teri|juan/i);
          });
          return {
            c, addr: getAddr(c), vendor: getVendor(c), desc: getDesc(c),
            commentCount, lastCommentDate, lastCommentText, lastCommentUser,
            daysSinceComment, schedDate, isPastSched, daysOpen, isWaiting,
            vendorComments, allCommentText,
          };
        });
        let results = [];
        let label = '';
        if (wantNoComments) {
          results = scored.filter(function(s) { return s.commentCount === 0; });
          label = 'Work orders with NO comments (' + results.length + ' of ' + scored.length + ')';
        } else if (wantFollowUp) {
          results = scored.filter(function(s) {
            return s.isPastSched || (s.daysOpen >= 7 && (s.daysSinceComment === null || s.daysSinceComment >= 3));
          }).sort(function(a,b) { return (b.daysOpen||0) - (a.daysOpen||0); });
          label = 'Work orders needing follow-up (' + results.length + ' of ' + scored.length + ')';
        } else if (wantWaiting) {
          results = scored.filter(function(s) { return s.isWaiting || /waiting|wait.*for|on hold/i.test(s.c.stage||''); });
          label = 'Work orders waiting/blocked (' + results.length + ' of ' + scored.length + ')';
        } else if (wantVendorUpdates) {
          results = scored.filter(function(s) { return s.vendorComments.length > 0; });
          label = 'Work orders with vendor comments (' + results.length + ' of ' + scored.length + ')';
        } else {
          results = scored.filter(function(s) { return s.commentCount > 0; });
          label = 'Work orders with comments (' + results.length + ' of ' + scored.length + ')';
        }
        const lines = results.map(function(s) {
          const header = s.addr + ' — WO #' + (s.c.workOrderNumber||'') + ' | ' + s.desc + ' | ' + (s.c.stage||'') + ' | ' + s.vendor;
          const meta = [];
          if (s.daysOpen) meta.push(s.daysOpen + ' days open');
          if (s.schedDate) meta.push('Sched: ' + s.schedDate + (s.isPastSched ? ' ⚠️ PAST' : ''));
          if (s.daysSinceComment !== null) meta.push('Last comment: ' + s.daysSinceComment + ' days ago');
          if (s.isWaiting) meta.push('⏳ Waiting');
          const metaLine = meta.length > 0 ? '  [' + meta.join(' | ') + ']' : '';
          let commentLine = '';
          if (s.lastCommentText) {
            commentLine = '  → ' + s.lastCommentUser + ' (' + s.lastCommentDate + '): ' + s.lastCommentText;
          }
          return header + (metaLine ? '\n' + metaLine : '') + (commentLine ? '\n' + commentLine : '');
        });
        return res.json({ content: [{ type: 'text', text: label + ':\n\n' + lines.join('\n\n') }] });
      } catch(e) {
        console.error('WO comment shortcut error:', e.message);
      }
    }

    // Server-side shortcut for work order questions — formats output directly
    const isWOQ = !lowerMsg.match(/comment|note|follow.?up/) &&
      lowerMsg.match(/work.?order|work order/) && lowerMsg.match(/open|list|show|what|which|over|past|days|unassign|vendor|address|all|scheduled|start|most|property|home|propert/);
    if (isWOQ) {
      try {
        let schedKey = null;
        try {
          const woSchema = await unitsFetch('/api/schema/workOrder');
          const woMap = {};
          if (Array.isArray(woSchema)) woSchema.forEach(function(f) { if (f && f.label) woMap[f.label] = f.key; });
          schedKey = woMap['Appointment Window Start'] || woMap['Scheduled Start Date'] || woMap['Start Date'] || woMap['Scheduled Date'] || null;
        } catch(schemaErr) {}
        let allWOs = [];
        let page = 0;
        while (true) {
          const data = await unitsFetch('/api/board/workOrder', { page, pageSize: 100, includeArchived: false });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          const active = batch.filter(function(c) { return !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''); });
          allWOs = allWOs.concat(active);
          if (batch.length < 100) break;
          if (page >= 1) break;
          page++;
        }
        const now = Date.now();
        const todayStr = new Date(now - 7*60*60*1000).toISOString().slice(0, 10);
        const wos = allWOs.map(function(c) {
          const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
          const daysOpen = created ? Math.floor((now - created) / 86400000) : 0;
          const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
          const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
          const address = (locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '?';
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          const vendor = (vendorArr[0] && vendorArr[0].name) || 'Unassigned';
          const rawDesc = c.description || c.name || '?';
          const cleanDesc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const schedRaw = schedKey ? (c[schedKey] || '') : '';
          const schedDate = schedRaw ? String(schedRaw).slice(0, 10) : '';
          const isPastScheduled = schedDate ? schedDate < todayStr : false;
          return {
            address, num: c.workOrderNumber || '',
            issue: cleanDesc.split(/\s+/).slice(0, 6).join(' '),
            fullDesc: cleanDesc,
            status: c.stage || '', daysOpen, vendor,
            trade: (Array.isArray(c.vendorTrade) ? (c.vendorTrade[0]||'') : (c.vendorTrade||'')),
            schedDate, isPastScheduled,
          };
        });

        const daysMatch = lowerMsg.match(/over\s+(\d+)\s*day|(\d+)\s*day/);
        const daysFilter = daysMatch ? parseInt(daysMatch[1] || daysMatch[2]) : null;
        const unassignedOnly = lowerMsg.match(/unassign/);
        const unscheduledOnly = lowerMsg.match(/not.*schedul|no.*schedul|without.*schedul|haven.t.*schedul|no.*appoint|no.*start.*date|missing.*schedul|need.*schedul/);
        const pastScheduled = lowerMsg.match(/past.*sched|sched.*past|past.*start|overdue|past their/) && !unscheduledOnly;
        const vendorSummary = lowerMsg.match(/vendor.*most|most.*vendor|vendor.*count|how many.*vendor|vendor.*how many|vendor.*list|which vendor|per vendor|by vendor|vendor.*amount|amount.*vendor|vendor.*breakdown|breakdown.*vendor/);
        const propertySummary = lowerMsg.match(/most.*work.*order|work.*order.*most|most.*submit|submit.*most|most.*open|propert.*most|home.*most|which.*home|which.*propert|by.*property|per.*property|property.*count|address.*most/);
        const categorize = function(issue, vendor, trade) {
          const t = ((issue||'') + ' ' + (vendor||'') + ' ' + (trade||'')).toLowerCase();
          if (/pest|termite|rodent|insect|cockroach|t2 pest|bug.*infestation/.test(t)) return 'Pest Control';
          if (/\bpool\b|\bspa\b/.test(t)) return 'Pool';
          if (/\bac\b|hvac|air.?condition|heat pump|furnace|ductwork|compressor|coolant|freon|ac unit|ac not work|air.*not.*cool/.test(t)) return 'HVAC';
          if (/tune.?up.*owner|tune.?up.*unit|mac.?s air|air cooling/.test(t)) return 'HVAC';
          if (/dishwasher|washing machine|washer|dryer|refriger|fridge|microwave|oven|stove|ice.?mak|appliance|freezer/.test(t)) return 'Appliance';
          if (/roof|shingle|tile.*roof|roofing|roof.*damage/.test(t)) return 'Roofing';
          if (/plumb|toilet|drain|faucet|water.?heat|pipe|sewage|clog|leak|sprinkler|irrigation|water.*not.*work|running water/.test(t)) return 'Plumbing';
          if (/electric|outlet|\blight\b|\blights\b|breaker|switch|wiring|ceiling fan/.test(t)) return 'Electrical';
          if (/landscap|lawn|\byard\b|\btree\b|\bpalm\b|trim.*branch|weed|sunrise landscape|rain or shine/.test(t)) return 'Landscaping';
          if (/clean|carpet|paint|drywall|patch|power.?wash/.test(t)) return 'Cleaning';
          if (/\bdoor\b|lock|window|blind|screen|garage.*door|garage.*opener|sliding.*door/.test(t)) return 'Door/Window/Lock';
          if (/fence|gate|patio|deck|exterior|siding/.test(t)) return 'Exterior';
          if (/inspect|walkthrough|walk.?through/.test(t)) return 'Inspection';
          return 'General';
        };
        const isEmergencyQ = lowerMsg.match(/emergency|urgent|flood|critical|disaster|no heat|no hot water|lock.?out/);
        let catFilter = null;
        if (/pest|termite|rodent|insect/.test(lowerMsg)) catFilter = 'Pest Control';
        else if (/\bhvac\b|\bac\b|air.?condition|furnace|heat pump/.test(lowerMsg)) catFilter = 'HVAC';
        else if (/plumb|toilet|drain|water.*heat|clog/.test(lowerMsg)) catFilter = 'Plumbing';
        else if (/electric|outlet|\blight\b|breaker/.test(lowerMsg)) catFilter = 'Electrical';
        else if (/appliance|dishwasher|fridge|refriger|microwave|washer|dryer|ice.?mak|freezer/.test(lowerMsg)) catFilter = 'Appliance';
        else if (/\broof\b/.test(lowerMsg)) catFilter = 'Roofing';
        else if (/landscap|lawn|\byard\b|sprinkler|\btree\b|\bpalm\b/.test(lowerMsg)) catFilter = 'Landscaping';
        else if (/\bpool\b|\bspa\b/.test(lowerMsg)) catFilter = 'Pool';
        else if (/\bgarage\b|window|blind|screen/.test(lowerMsg) && !/work order/.test(lowerMsg)) catFilter = 'Door/Window/Lock';
        else if (/inspect|walkthrough/.test(lowerMsg)) catFilter = 'Inspection';
        let filtered = wos;
        if (isEmergencyQ) {
          const emergencyPatterns = /leak|flood|burst|no heat|no hot water|no cool|no ac|lock.*out|can.t.*lock|can.t.*enter|gas.*leak|gas.*smell|no power|sewage|overflow|water.*damage|emergency|urgent/i;
          filtered = wos.filter(function(w) { return emergencyPatterns.test(w.fullDesc); });
          if (filtered.length === 0) {
            filtered = wos.filter(function(w) {
              const cat = categorize(w.fullDesc, w.vendor, w.trade);
              return (cat === 'HVAC' || cat === 'Plumbing') && w.daysOpen <= 3;
            });
          }
        } else if (unscheduledOnly) {
          filtered = wos.filter(function(w) { return !w.schedDate; });
        } else if (catFilter) {
          filtered = wos.filter(function(w) { return categorize(w.fullDesc, w.vendor, w.trade) === catFilter; });
        } else if (pastScheduled) {
          filtered = wos.filter(function(w) { return w.isPastScheduled; });
          if (filtered.length === 0 && !schedKey) filtered = wos.filter(function(w) { return /scheduled/i.test(w.status); });
        } else if (daysFilter) {
          filtered = wos.filter(function(w) { return w.daysOpen > daysFilter; });
        } else if (unassignedOnly) {
          filtered = wos.filter(function(w) { return w.vendor === 'Unassigned'; });
        }
        filtered.sort(function(a, b) { return b.daysOpen - a.daysOpen; });
        if (propertySummary) {
          const propCounts = {};
          wos.forEach(function(w) { if (w.address && w.address !== '?') propCounts[w.address] = (propCounts[w.address] || 0) + 1; });
          const sorted = Object.entries(propCounts).sort(function(a, b) { return b[1] - a[1]; });
          const lines = sorted.map(function(e) { return e[0] + ': ' + e[1] + ' work order' + (e[1] !== 1 ? 's' : ''); });
          return res.json({ content: [{ type: 'text', text: 'Open work orders by property (' + wos.length + ' total):\n\n' + lines.join('\n') }] });
        }
        if (vendorSummary) {
          const vendorCounts = {};
          wos.forEach(function(w) { vendorCounts[w.vendor] = (vendorCounts[w.vendor] || 0) + 1; });
          const sorted = Object.entries(vendorCounts).sort(function(a, b) { return b[1] - a[1]; });
          const lines = sorted.map(function(e) { return e[0] + ': ' + e[1] + ' work order' + (e[1] !== 1 ? 's' : ''); });
          return res.json({ content: [{ type: 'text', text: 'Open work orders by vendor (' + wos.length + ' total):\n\n' + lines.join('\n') }] });
        }
        const lines = filtered.map(function(w) {
          const schedInfo = w.schedDate ? ' | Sched: ' + w.schedDate : '';
          return w.address + ' — WO #' + w.num + ' | ' + w.issue + ' | ' + w.status + ' | ' + w.daysOpen + ' days' + schedInfo + ' | ' + w.vendor;
        });
        const header = isEmergencyQ ? '🚨 Emergency/urgent work orders (' + filtered.length + ' of ' + wos.length + ' total):'
          : unscheduledOnly ? 'Work orders with no scheduled date (' + filtered.length + ' of ' + wos.length + ' total):'
          : catFilter ? catFilter + ' work orders (' + filtered.length + ' of ' + wos.length + ' total):'
          : pastScheduled ? 'Work orders past scheduled start date (' + filtered.length + ' of ' + wos.length + '):'
          : daysFilter ? 'Work orders open over ' + daysFilter + ' days (' + filtered.length + ' of ' + wos.length + ' total):'
          : unassignedOnly ? 'Unassigned work orders (' + filtered.length + '):'
          : 'Open work orders (' + filtered.length + '):';
        return res.json({ content: [{ type: 'text', text: header + '\n\n' + lines.join('\n') }] });
      } catch(e) {
        console.error('WO shortcut error:', e.message);
      }
    }

    // Server-side shortcut for leasing reports
    const isLeasingReportQ = lowerMsg.match(/leasing report|leasing update|leasing activity|vacancy report|vacant.*report|report.*vacant|owner.*update.*leas|leas.*update.*owner|days on market|how long.*vacant|how long.*listed|listing.*activity|leas.*last.*week|leas.*last.*month|leas.*this.*week|leas.*this.*month|what.*happening.*leas|showings.*report|leads.*report|update.*owner.*property|property.*update.*owner/);
    if (isLeasingReportQ) {
      try {
        const now = Date.now();
        const azNow = new Date(now - 7 * 60 * 60 * 1000);
        let daysBack = 30;
        if (lowerMsg.match(/last week|this week|past week|7 day/)) daysBack = 7;
        else if (lowerMsg.match(/last month|this month|past month|30 day/)) daysBack = 30;
        else if (lowerMsg.match(/last 2 week|14 day/)) daysBack = 14;
        const cutoffMs = now - daysBack * 24 * 60 * 60 * 1000;
        const propMatch = lowerMsg.match(/(?:for|at|on)\s+([0-9]+\s+\w.{5,40}?)(?:\?|$)/i) ||
                          lowerMsg.match(/([0-9]{3,5}\s+(?:west|east|north|south|w |e |n |s ).{5,35}?)(?:\?|$)/i);
        const propFilter = propMatch ? propMatch[1].toLowerCase().trim() : null;
        const unitsData = await unitsFetch('/api/board/unit', { page: 0, pageSize: 200, includeArchived: false });
        let units = Array.isArray(unitsData) ? unitsData : (unitsData && unitsData.data) || [];
        if (propFilter) {
          const q = propFilter.split(' ').slice(0, 3).join(' ');
          units = units.filter(function(u) {
            return ((u['Address'] || '') + ' ' + (u['Street'] || '') + ' ' + (u.Title || '')).toLowerCase().includes(q);
          });
        }
        const schemaRaw = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schemaRaw)) schemaRaw.forEach(function(f) { schemaMap[f.key] = f.label; });
        const leadsData = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 200, includeArchived: false });
        const allLeads = Array.isArray(leadsData) ? leadsData : (leadsData && leadsData.data) || [];
        const mapLead = function(c) {
          const m = { _id: c.cardId, stage: c.stage, createdAt: c.createdAt };
          Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
          return m;
        };
        const leads = allLeads.map(mapLead).filter(function(l) {
          return !l.createdAt || new Date(l.createdAt).getTime() > cutoffMs;
        });
        const strVal = function(v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return v.map(function(i) { return typeof i === 'object' ? (i.name || i.value || '') : i; }).join(', ');
          if (typeof v === 'object') return v.name || v.value || '';
          return String(v);
        };
        const todayStr = azNow.toISOString().slice(0, 10);
        const vacantUnits = units.filter(function(u) { return /vacant|available/i.test(u.Stage || ''); });
        const occupiedUnits = units.filter(function(u) { return /occupied/i.test(u.Stage || ''); });
        const lines = [];
        const period = daysBack === 7 ? 'Last 7 days' : daysBack === 14 ? 'Last 14 days' : 'Last 30 days';
        lines.push('📊 LEASING REPORT — ' + period.toUpperCase() + (propFilter ? ' — ' + propFilter.toUpperCase() : ''));
        lines.push('Generated: ' + todayStr);
        lines.push('');
        if (vacantUnits.length > 0) {
          lines.push('🏠 VACANT / ACTIVE LISTINGS (' + vacantUnits.length + ')');
          lines.push('─────────────────────────────────');
          vacantUnits.forEach(function(u) {
            const addr = u.Address || u.Street || u.Title || '?';
            const rent = u['Market Rent'] || '?';
            const beds = u.Beds || '?';
            const baths = u.Baths || '?';
            const availDate = u['Available Date'] || '';
            const daysOnMarket = availDate ? Math.floor((now - new Date(availDate).getTime()) / 86400000) : null;
            const owner = u.Owners || u.Portfolio || '';
            const propLeads = leads.filter(function(l) {
              const pref = strVal(l['Preferred Rental'] || l['Unit'] || '');
              return addr && pref && (pref.toLowerCase().includes((u.Street || '').toLowerCase().slice(0, 10)) ||
                     (u.Street || '').toLowerCase().includes(pref.toLowerCase().slice(0, 10)));
            });
            const showings = propLeads.filter(function(l) { return /scheduled tour|tour completed/i.test(l.stage || ''); });
            const applications = propLeads.filter(function(l) { return /applied|applicant/i.test(l.stage || ''); });
            const newLeads = propLeads.filter(function(l) { return /nurturing/i.test(l.stage || ''); });
            lines.push('📍 ' + addr);
            lines.push('   Rent: ' + rent + ' | ' + beds + 'bd/' + baths + 'ba | Owner: ' + owner);
            if (availDate) lines.push('   Available: ' + availDate + (daysOnMarket !== null ? ' (' + daysOnMarket + ' days on market)' : ''));
            lines.push('   Activity (' + period + '): ' + propLeads.length + ' total leads | ' + showings.length + ' showings | ' + applications.length + ' applications | ' + newLeads.length + ' new inquiries');
            if (showings.length > 0) {
              showings.slice(0, 3).forEach(function(l) {
                const name = strVal(l['Primary Contact'] || l['Name']);
                const info = strVal(l['Requested Showing Information'] || l['Tour Date/Time']);
                if (name) lines.push('   ↳ Showing: ' + name + (info ? ' — ' + String(info).slice(0, 60) : ''));
              });
            }
            if (applications.length > 0) {
              applications.slice(0, 3).forEach(function(l) {
                const name = strVal(l['Primary Contact'] || l['Name']);
                if (name) lines.push('   ↳ Application: ' + name + ' [' + (l.stage || '') + ']');
              });
            }
            lines.push('');
          });
        }
        const recentlyOccupied = occupiedUnits.filter(function(u) {
          const stageChanged = u['Stage Changed'] || '';
          return stageChanged && new Date(stageChanged).getTime() > cutoffMs;
        });
        if (recentlyOccupied.length > 0) {
          lines.push('✅ LEASED IN THIS PERIOD (' + recentlyOccupied.length + ')');
          lines.push('─────────────────────────────────');
          recentlyOccupied.forEach(function(u) {
            const addr = u.Address || u.Street || u.Title || '?';
            const rent = u['Market Rent'] || '?';
            const resident = u.Residents || '';
            const leased = (u['Stage Changed'] || '').slice(0, 10);
            lines.push('✅ ' + addr + ' — Leased ' + leased + ' @ ' + rent + (resident ? ' — ' + resident : ''));
          });
          lines.push('');
        }
        lines.push('📈 SUMMARY');
        lines.push('─────────────────────────────────');
        lines.push('Total properties tracked: ' + units.length);
        lines.push('Currently vacant: ' + vacantUnits.length);
        lines.push('Currently occupied: ' + occupiedUnits.length);
        lines.push('Leased this period: ' + recentlyOccupied.length);
        lines.push('New leads this period: ' + leads.length);
        const totalShowings = leads.filter(function(l) { return /scheduled tour|tour completed/i.test(l.stage || ''); }).length;
        const totalApps = leads.filter(function(l) { return /applied/i.test(l.stage || ''); }).length;
        lines.push('Showings this period: ' + totalShowings);
        lines.push('Applications this period: ' + totalApps);
        return res.json({ content: [{ type: 'text', text: lines.join('\n') }] });
      } catch(e) {
        console.error('Leasing report shortcut error:', e.message);
      }
    }

    // Server-side shortcut for new leads questions
    const isLeadsQ = lowerMsg.match(/lead|prospect/) && lowerMsg.match(/new|this week|today|came|recent|incoming|how many|come in|what.*lead|lead.*what/);
    if (isLeadsQ) {
      try {
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100, updatedAtMin: weekAgo });
        const raw = Array.isArray(data) ? data : (data && data.data) || [];
        const extractVal = function(v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return v.map(function(x) { return x.name || x; }).join(', ');
          if (typeof v === 'object') return v.amount ? '$' + v.amount : (v.name || v.value || '');
          return String(v);
        };
        const cards = raw.map(function(card) {
          const m = { _cardId: card.cardId, name: card.name, stage: card.stage, createdAt: card.createdAt };
          Object.keys(card).forEach(function(k) {
            if (schemaMap[k]) m[schemaMap[k]] = extractVal(card[k]);
          });
          return m;
        });
        const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const newLeads = cards.filter(function(c) {
          return c.createdAt && new Date(c.createdAt).getTime() > weekAgoMs;
        });
        const toShow = newLeads.length > 0 ? newLeads : cards;
        const fmt = function(c) {
          const name = (c['Primary Contact'] || c.name || '?').replace(/^Application: /, '');
          const property = c['Preferred Rental'] || c['Unit'] || '';
          const source = c['Source'] || c['Lead Type'] || '';
          const stage = c.stage || c['Stage'] || '';
          const created = (c.createdAt || '').slice(0, 10);
          return name + (property ? ' — ' + property : '') + (source ? ' (' + source + ')' : '') + (stage ? ' [' + stage + ']' : '') + (created ? ' ' + created : '');
        };
        const label = newLeads.length > 0 ? 'New leads this week (' + newLeads.length + ')' : 'No new leads found this week. Recent leads (' + toShow.length + ')';
        return res.json({ content: [{ type: 'text', text: label + ':\n\n' + toShow.map(fmt).join('\n') }] });
      } catch(e) {
        console.error('Leads shortcut error:', e.message);
      }
    }

    // Server-side shortcut for showing schedule questions
    const isShowingQ = lowerMsg.match(/showing|scheduled tour|who.*tour|tour.*today|showing.*today|today.*showing|past.*tour|recent.*tour|tour.*week|week.*tour|showing.*week|week.*showing/);
    if (isShowingQ) {
      try {
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100 });
        const allCards = Array.isArray(data) ? data : (data && data.data) || [];
        const mapCard = function(c) {
          const m = { _id: c.cardId, stage: c.stage, createdAt: c.createdAt, comments: c.comments };
          Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
          return m;
        };
        const mapped = allCards.map(mapCard);
        const showingCards = mapped.filter(function(c) {
          return c['Requested Showing Information'] || c['Tour Date/Time'] ||
                 /scheduled tour|tour completed|tour canceled/i.test(c.stage || '');
        });
        const parseShowingDate = function(c) {
          const raw = c['Requested Showing Information'];
          const info = typeof raw === 'string' ? raw : (raw && (raw.value || raw.name || JSON.stringify(raw))) || '';
          const m = info.match(/\((\d{2}\/\d{2}\/\d{4})/);
          if (m) return m[1];
          const td = String(c['Tour Date/Time'] || '').slice(0, 10);
          return td;
        };
        const nowUtc = Date.now();
        const azOffset = -7 * 60 * 60 * 1000;
        const nowAz = new Date(nowUtc + azOffset);
        const todayAz = new Date(nowAz); todayAz.setHours(0,0,0,0);
        const weekStart = new Date(todayAz); weekStart.setDate(todayAz.getDate() - todayAz.getDay());
        const strVal = function(v) {
          if (!v) return '';
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return v.map(function(i) { return typeof i === 'object' ? (i.name || i.value || JSON.stringify(i)) : i; }).join(', ');
          if (typeof v === 'object') return v.name || v.value || v.address || JSON.stringify(v);
          return String(v);
        };
        const fmt = function(c) {
          const contact = strVal(c['Primary Contact'] || c['Name']) || '?';
          const unit = strVal(c['Preferred Rental'] || c['Unit']) || '?';
          const raw = c['Requested Showing Information'];
          const info = typeof raw === 'string' ? raw : (raw && (raw.value || raw.name || '')) || '';
          const timeMatch = info.match(/\(([^)]+)\)/);
          const time = timeMatch ? timeMatch[1] : String(c['Tour Date/Time'] || '');
          const stage = c.stage || '';
          const status = c['Requested Showing Status'] || '';
          const source = c['Source'] || '';
          return '• ' + contact + ' @ ' + unit + (time ? '\n  ' + time : '') +
                 (stage ? ' [' + stage + ']' : '') + (status ? ' (' + status + ')' : '') +
                 (source ? ' — ' + source : '');
        };
        const parseDateMs = function(c) {
          const ds = parseShowingDate(c);
          if (!ds) return null;
          try { return new Date(ds).getTime(); } catch(e) { return null; }
        };
        let filtered, label;
        const todayStr = String(todayAz.getMonth()+1).padStart(2,'0') + '/' + String(todayAz.getDate()).padStart(2,'0') + '/' + todayAz.getFullYear();
        if (lowerMsg.match(/today/)) {
          filtered = showingCards.filter(function(c) { return parseShowingDate(c) === todayStr; });
          label = 'Showings today (' + todayStr + ')';
          if (filtered.length === 0) {
            const upcoming = showingCards.filter(function(c) {
              const ms = parseDateMs(c); return ms !== null && ms > todayAz.getTime();
            }).sort(function(a,b) { return (parseDateMs(a)||0) - (parseDateMs(b)||0); });
            const text = 'No showings found for today (' + todayStr + ').' +
              (upcoming.length > 0 ? '\n\nUpcoming showings (' + upcoming.length + '):\n\n' + upcoming.map(fmt).join('\n') : '\n\nNo upcoming showings scheduled either.');
            return res.json({ content: [{ type: 'text', text }] });
          }
        } else if (lowerMsg.match(/this week|week/)) {
          const weekStartMs = weekStart.getTime();
          const weekEndMs = weekStartMs + 7 * 24 * 60 * 60 * 1000;
          filtered = showingCards.filter(function(c) {
            const ms = parseDateMs(c);
            return ms !== null && ms >= weekStartMs && ms < weekEndMs;
          }).sort(function(a,b) { return (parseDateMs(a)||0) - (parseDateMs(b)||0); });
          label = 'Showings this week';
        } else if (lowerMsg.match(/happened|completed|did.*happen|took place|past|yesterday/)) {
          const threeDaysAgo = new Date(todayAz); threeDaysAgo.setDate(todayAz.getDate() - 3);
          filtered = showingCards.filter(function(c) {
            const ms = parseDateMs(c);
            return ms !== null && ms >= threeDaysAgo.getTime() && ms <= nowAz.getTime();
          }).sort(function(a,b) { return (parseDateMs(a)||0) - (parseDateMs(b)||0); });
          label = 'Showings in the past 3 days';
        } else {
          filtered = showingCards.sort(function(a,b) { return (parseDateMs(a)||0) - (parseDateMs(b)||0); });
          label = 'All showing activity';
        }
        const text = filtered.length > 0
          ? label + ' (' + filtered.length + '):\n\n' + filtered.map(fmt).join('\n\n')
          : label + ': None found.\n\nTotal leads with showing info: ' + showingCards.length;
        return res.json({ content: [{ type: 'text', text }] });
      } catch(e) {
        console.error('Showing shortcut error:', e.message);
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
        if (typeof result === 'string' && result.length > 10000) {
          result = result.slice(0, 10000) + '...[truncated for context limit]';
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

app.get('/sandbox', function(req, res) {
  res.sendFile(new URL('sandbox.html', import.meta.url).pathname);
});

app.get('/recon', function(req, res) {
  res.sendFile(new URL('recon.html', import.meta.url).pathname);
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

const FAQ_TABS = [
  {
    id: "maintenance", label: "🔧 Maintenance", color: "#fff7ed", border: "#f97316", accent: "#ea580c",
    questions: [
      {icon:"🚨", text:"What emergency work orders do we have right now?"},
      {icon:"📅", text:"What work orders have been open over 30 days?"},
      {icon:"⏰", text:"What work orders have been open over 7 days?"},
      {icon:"🗓️", text:"What work orders have been open over 14 days?"},
      {icon:"🚨", text:"What work orders are still open past their scheduled start date?"},
      {icon:"🏢", text:"Which vendor has the most open work orders?"},
      {icon:"📊", text:"Show me the amount of work orders opened per vendor"},
      {icon:"🔁", text:"Are there repeat issues at any property?"},
      {icon:"📈", text:"Are there any recurring issues at any properties?"},
      {icon:"👤", text:"What work orders are not scheduled yet with a vendor?"},
      {icon:"💬", text:"Which work orders have no comments?"},
      {icon:"🔢", text:"How many open work orders do we have?"},
      {icon:"🏠", text:"What homes have the most submitted work orders?"},
      {icon:"⚡", text:"What is the average time for a work order to get assigned to a vendor?"},
      {icon:"❄️", text:"Show me all HVAC work orders"},
      {icon:"💧", text:"Any water leak or plumbing emergencies open?"},
      {icon:"🐛", text:"Show me pest control related work orders"},
    ]
  },
  {
    id: "leasing", label: "🏠 Leasing", color: "#f0fdf4", border: "#22c55e", accent: "#16a34a",
    questions: [
      {icon:"🏠", text:"What units are available right now?"},
      {icon:"👥", text:"What new leads came in this week?"},
      {icon:"📊", text:"Show me the leasing report for this week"},
      {icon:"📊", text:"Show me the leasing report for last month"},
      {icon:"📅", text:"What showings are scheduled today?"},
      {icon:"📅", text:"What showings happened this week?"},
      {icon:"📝", text:"Show me all active applications"},
      {icon:"🔍", text:"What is the status of applications at [address]?"},
      {icon:"📋", text:"What are our applicant screening criteria?"},
      {icon:"💰", text:"What is our application fee and deposit structure?"},
      {icon:"📊", text:"How many leads came in this month and what sources?"},
      {icon:"🔎", text:"How many applications are pending approval?"},
      {icon:"📆", text:"What units are coming available in the next 30 days?"},
      {icon:"🏷️", text:"What is the current rent for [address]?"},
      {icon:"⏱️", text:"Which homes have been on the market over 30 days?"},
      {icon:"📉", text:"Which homes have been on the market over 14 days?"},
    ]
  },
  {
    id: "tenants", label: "👤 Tenants", color: "#eff6ff", border: "#3b82f6", accent: "#2563eb",
    questions: [
      {icon:"💰", text:"What does [tenant name] owe and what is it from?"},
      {icon:"📋", text:"What's our lease break policy?"},
      {icon:"📅", text:"When does [tenant name]'s lease expire?"},
      {icon:"🔑", text:"What are the move-in requirements and fees?"},
      {icon:"🏚️", text:"What is the move-out process and timeline?"},
      {icon:"💳", text:"What is the late fee policy?"},
      {icon:"🐾", text:"What is the pet policy and fees?"},
      {icon:"🔧", text:"How do tenants submit a maintenance request?"},
      {icon:"🏦", text:"What is the RBP program and what does it cost?"},
      {icon:"📬", text:"How does a tenant give notice to vacate?"},
      {icon:"🔒", text:"What happens if a tenant is locked out?"},
      {icon:"💸", text:"Can a tenant set up a payment plan?"},
    ]
  },
  {
    id: "owners", label: "🏢 Owners", color: "#fdf4ff", border: "#a855f7", accent: "#9333ea",
    questions: [
      {icon:"🏢", text:"How is [owner name]'s property performing?"},
      {icon:"💸", text:"When are owner disbursements processed?"},
      {icon:"📊", text:"What are our management fees?"},
      {icon:"🔑", text:"What is our leasing process for new owners?"},
      {icon:"🏚️", text:"Show me all move-outs in progress"},
      {icon:"🔄", text:"Show me all leases up for renewal"},
      {icon:"📋", text:"What does the rent-ready process look like?"},
      {icon:"🛡️", text:"What guarantees do we offer owners?"},
      {icon:"📈", text:"What is the current occupancy rate?"},
      {icon:"🔔", text:"What does an owner do when a tenant gives notice?"},
      {icon:"🏗️", text:"What maintenance work requires owner approval?"},
      {icon:"📄", text:"How do we handle owner statements?"},
    ]
  },
  {
    id: "accounting", label: "💰 Accounting", color: "#fefce8", border: "#eab308", accent: "#ca8a04",
    questions: [
      {icon:"💰", text:"What does [tenant name] owe?"},
      {icon:"📊", text:"Show me recent transactions for [property address]"},
      {icon:"💳", text:"What are the outstanding balances across all tenants?"},
      {icon:"🧾", text:"What charges are past due this month?"},
      {icon:"💸", text:"What is the late fee policy and when is it applied?"},
      {icon:"📑", text:"How are security deposits handled?"},
      {icon:"🏦", text:"What is the earnest deposit amount?"},
      {icon:"📋", text:"What fees are charged at move-out?"},
      {icon:"🔄", text:"How are owner disbursements calculated?"},
      {icon:"💡", text:"What utility bills are owner responsibility?"},
      {icon:"📆", text:"When is rent due and what is the grace period?"},
      {icon:"🏷️", text:"What admin fees do we charge?"},
    ]
  },
  {
    id: "operations", label: "⚡ Operations", color: "#f0f9ff", border: "#0ea5e9", accent: "#0284c7",
    questions: [
      {icon:"🔍", text:"Any inspections scheduled this week?"},
      {icon:"💬", text:"Any recent announcements in Slack?"},
      {icon:"📅", text:"What move-ins are happening this week?"},
      {icon:"📋", text:"What move-outs are in progress?"},
      {icon:"🔄", text:"What leases are expiring in the next 60 days?"},
      {icon:"🏠", text:"How many units do we currently manage?"},
      {icon:"📊", text:"What is our current occupancy rate?"},
      {icon:"🗓️", text:"What HOA violations are open?"},
      {icon:"🔑", text:"What properties are vacant right now?"},
      {icon:"📬", text:"Any pending move-out inspections?"},
      {icon:"🔗", text:"What are all the active leases expiring this month?"},
      {icon:"📈", text:"What new properties did we onboard recently?"},
    ]
  },
];

const SOURCES = [
  {label:"Rentvine",bg:"#e6f0fb",border:"#85B7EB"},
  {label:"Aptly",   bg:"#EAF3DE",border:"#97C459"},
  {label:"Knowledge Base",  bg:"#FAEEDA",border:"#EF9F27"},
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

function Sidebar({activeTab, setActiveTab, send}) {
  const [expandedTab, setExpandedTab] = useState("maintenance");
  const toggleTab = (id) => setExpandedTab(expandedTab === id ? null : id);
  return (
    <div style={{width:260,minWidth:260,background:"white",borderRight:"1px solid #f0f0f0",display:"flex",flexDirection:"column",height:"100vh",overflowY:"auto"}}>
      <div style={{padding:"14px 16px",borderBottom:"1px solid #f0f0f0",display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:30,height:30,borderRadius:8,background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🌿</div>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:"#1a1a1a"}}>Aloe Assistant</div>
          <div style={{fontSize:10,color:"#888"}}>Internal · All live</div>
        </div>
      </div>
      <div style={{padding:"8px 10px",flex:1}}>
        {FAQ_TABS.map(tab => (
          <div key={tab.id} style={{marginBottom:2}}>
            <button onClick={()=>toggleTab(tab.id)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 8px",borderRadius:7,border:"none",background:expandedTab===tab.id?tab.color:"transparent",cursor:"pointer",textAlign:"left",transition:"background 0.1s"}}>
              <span style={{fontSize:12,fontWeight:600,color:expandedTab===tab.id?tab.accent:"#444"}}>{tab.label}</span>
              <span style={{fontSize:10,color:"#aaa",transform:expandedTab===tab.id?"rotate(180deg)":"none",transition:"transform 0.2s"}}>▼</span>
            </button>
            {expandedTab===tab.id && (
              <div style={{paddingLeft:4,paddingBottom:4}}>
                {tab.questions.map((q,i)=>(
                  <button key={i} onClick={()=>send(q.text)} style={{width:"100%",display:"flex",alignItems:"flex-start",gap:6,padding:"5px 8px",borderRadius:6,border:"none",background:"transparent",cursor:"pointer",textAlign:"left",transition:"background 0.1s",marginBottom:1}}>
                    <span style={{fontSize:11,flexShrink:0,marginTop:1}}>{q.icon}</span>
                    <span style={{fontSize:11,color:"#555",lineHeight:1.4}}>{q.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div style={{padding:"10px 14px",borderTop:"1px solid #f0f0f0"}}>
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {SOURCES.map(s=>React.createElement('div',{key:s.label,style:{padding:"2px 7px",borderRadius:10,background:s.bg,border:\`1px solid \${s.border}\`,fontSize:10,color:"#333"}},s.label))}
        </div>
      </div>
    </div>
  );
}

function Assistant() {
  const [messages,setMessages] = useState([]);
  const [input,setInput] = useState("");
  const [loading,setLoading] = useState(false);
  const [lastError,setLastError] = useState("");
  const [sidebarOpen,setSidebarOpen] = useState(true);
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

  const clearChat = () => { setMessages([]); setLastError(""); };

  return (
    <div style={{display:"flex",height:"100vh",overflow:"hidden"}}>
      {sidebarOpen && <Sidebar send={(txt)=>{ send(txt); }} />}
      <div style={{flex:1,display:"flex",flexDirection:"column",minWidth:0}}>
        {lastError && <div style={{padding:"8px 16px",background:"#fff5f5",borderBottom:"1px solid #fed7d7",display:"flex",justifyContent:"space-between",flexShrink:0}}><span style={{fontSize:12,color:"#c53030"}}>⚠ {lastError}</span><button onClick={()=>setLastError("")} style={{background:"none",border:"none",cursor:"pointer",color:"#c53030",fontSize:16}}>×</button></div>}
        <div style={{display:"flex",alignItems:"center",padding:"10px 16px",background:"white",borderBottom:"1px solid #f0f0f0",flexShrink:0,gap:10}}>
          <button onClick={()=>setSidebarOpen(!sidebarOpen)} style={{width:30,height:30,borderRadius:6,border:"1px solid #e5e5e5",background:"white",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,flexShrink:0}} title={sidebarOpen?"Hide sidebar":"Show sidebar"}>☰</button>
          <div style={{fontSize:14,fontWeight:600,color:"#1a1a1a",flex:1}}>Chat</div>
          {messages.length>0 && <button onClick={clearChat} style={{fontSize:11,color:"#888",background:"none",border:"1px solid #e5e5e5",borderRadius:6,padding:"4px 8px",cursor:"pointer"}}>New chat</button>}
        </div>
        <div style={{flex:1,overflowY:"auto",padding:"20px 16px"}}>
          {messages.length===0 ? (
            <div style={{maxWidth:560,margin:"0 auto",paddingTop:40,textAlign:"center"}}>
              <div style={{fontSize:30,marginBottom:10}}>🌿</div>
              <div style={{fontSize:18,fontWeight:600,color:"#1a1a1a",marginBottom:6}}>Hi, I'm Aloe</div>
              <div style={{fontSize:13,color:"#666",lineHeight:1.7,maxWidth:400,margin:"0 auto"}}>Your AI assistant for Aloe Property Management. Pick a shortcut from the left sidebar, or type any question below.</div>
              <div style={{fontSize:12,color:"#aaa",marginTop:20}}>← Browse categories in the sidebar</div>
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
            <textarea ref={taRef} value={input} onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}} placeholder="Ask anything — or pick a shortcut from the sidebar..." rows={1} style={{flex:1,padding:"9px 12px",background:"#f9f9f7",border:"1px solid #e5e5e5",borderRadius:8,color:"#1a1a1a",fontSize:14,fontFamily:"inherit",resize:"none",lineHeight:1.5,minHeight:38,maxHeight:120}}/>
            <button onClick={()=>send()} disabled={!input.trim()||loading} style={{width:38,height:38,borderRadius:8,background:input.trim()&&!loading?"#3B6D11":"#f0f0f0",border:"none",cursor:input.trim()&&!loading?"pointer":"default",color:input.trim()&&!loading?"white":"#aaa",fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>↑</button>
          </div>
          <div style={{textAlign:"center",fontSize:11,color:"#aaa",marginTop:6}}>Rentvine · Aptly · Knowledge Base · Slack · All data is live</div>
        </div>
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
