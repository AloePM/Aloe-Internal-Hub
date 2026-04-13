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
- "unit" — Units/Listings board. Has Stage (Vacant/Occupied), beds, baths, sq ft, rent, deposit, available date, Published For Rent field. For availability questions use "qfBzBxfooJtfTQncd" instead (it has Mirror Published For Rent field and is the master listing board). IMPORTANT: The "Created At" field on each unit = the date the property was onboarded into the portfolio — use this to answer questions about recently onboarded properties.
- "qfBzBxfooJtfTQncd" — List Property / On Market board. Shows properties actively listed, showing start date, notes on occupancy, market status.
- "location" — Properties/Locations board. Has owner, address, property details for every property.
- "4EMDSYKirhQaNdQKz" — Renter Leads. Use aptly_get_leads for ANY question about leads, showings, tours, prospects, lead sources, conversion. Fields include: Primary Contact, Preferred Rental, Stage, Source, Requested Showing Information (contains date/time), Requested Showing Status, Tour Date/Time, Move Date, Household Income, Beds, Pets, Last Action, email counts, comments. Stages: Nurturing, Scheduled Tour, Tour Completed, Tour Canceled / No Show, Applied.
- "MJxaStgENouWrNEKd" — Applicants (Applications board). Use this for ANY question about applications. Has Application Location (property address), Primary Applicant, Stage, income, credit, household info. NEVER use Renter Leads for applications.
- For ANY question about a specific applicant, their comments, notes, status, income, credit, or history: use aptly_get_applicant tool with their name or address. This fetches all cards in memory and searches by any field — name, partial address, street name all work.
- When asked for comments on an applicant and aptly_get_applicant returns "No comments", ALSO search for the applicant by name using aptly_search_cards with boardId "MJxaStgENouWrNEKd" — this may return comments that the other method missed.
- "workOrder" — Work Orders board (Aptly). USE aptly_get_work_orders AS THE PRIMARY SOURCE for counts, vendor analysis, days open, unassigned, HVAC/plumbing/pest queries. For comments/notes analysis ("which have no comments", "show follow-ups"): use rv_get_work_order_notes which fetches notes from Rentvine per work order — this is the ONLY reliable source for comment data. The Aptly bulk API does not return comments in list responses. IMPORTANT: Never call aptly_get_work_orders AND rv_get_work_orders in the same loop — pick one. Use rv_get_work_orders only when specifically asked about Rentvine counts or vendor assignment. FORMAT: When listing work orders always use this exact format per line: "[address] — WO #[num] | [issue] | [status] | [daysOpen] days | [vendor]"
- "YA3QWmPebvMwLwbB3" — Move-Outs. Shows move-out pipeline, repair status, inspection status.
- "K9mMGGjKgQPqDykaa" — Move-Ins board. Key fields after schema mapping: "Mirror Move-In Date" (MM/DD/YYYY), "Mirror Rent Amount", "Stage", "Title" (contains date+tenants+address), "Buildings", "Unit", "Mirror Residents", "Mirror Portfolio" (owner). Stages: Approved, Lease Sent, Lease Signed, Utilities, Move-In Day, Moved In, Abandoned. Filter by "Mirror Move-In Date" for upcoming move-ins. Exclude Abandoned and Moved In stages for upcoming.
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
- ALWAYS include comments when showing card details from any Aptly board. Comments are in the comments array (standard boards) or formatted_comments field. Show them as: "Notes: [date] [person]: [comment]". If no comments, don't mention it.
- Never ask clarifying questions
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
    name: 'rv_get_property_work_order_history',
    description: 'Get ALL work orders (open AND closed/completed) for a specific property by address or property ID. Use for: "show history for X address", "repeat issues at X", "what work has been done at X", "past work orders for X". Returns open + closed work orders sorted newest first.',
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
      properties: {
        workOrderId: { type: 'number', description: 'Work order ID' },
      },
      required: ['workOrderId'],
    },
  },
  {
    name: 'rv_get_recurring_issues',
    description: 'Find properties with recurring work orders of the same category (HVAC, plumbing, electrical, appliance, etc.) within a time period. Use when asked: "which properties have had repeated HVAC issues?", "recurring plumbing problems", "same issue multiple times at a property", "has X address had AC problems before?". Searches ALL work orders including closed/completed ones in Rentvine.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Issue category to check: HVAC, Plumbing, Electrical, Appliance, Roofing, Landscaping, Pest Control, Pool, or leave blank for all categories' },
        daysBack: { type: 'number', description: 'How far back to look in days. Default 365 (1 year). Use 730 for 2 years.' },
        minCount: { type: 'number', description: 'Minimum number of same-category WOs to flag a property. Default 2.' },
      },
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
    name: 'aptly_get_applicant',
    description: 'Get full details and comments for a specific applicant by name or address from the Applicants board. Use when asked about a specific applicant, their notes, comments, status, income, credit, or history.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Applicant name or property address to look up' },
      },
      required: ['query'],
    },
  },
  {
    name: 'aptly_get_leads',
    description: 'Get renter leads from the Renter Leads board. Use for ANY question about leads, showings, prospects, tours, lead activity, lead pipeline, conversion rates, tour feedback, who applied after showing, lead sources. Returns: contact, property, stage, source, showing info, tour date, move date, income, email activity, comments.',
    input_schema: {
      type: 'object',
      properties: {
        daysBack: { type: 'number', description: 'Filter to leads created in last N days. Use 7 for this week, 30 for this month. Omit for all leads.' },
        property: { type: 'string', description: 'Filter by property address' },
        stage: { type: 'string', description: 'Filter by stage, e.g. "Scheduled Tour", "Tour Completed", "Nurturing", "Applied"' },
        includeArchived: { type: 'boolean', description: 'Include archived leads. Default false.' },
      },
    },
  },
  {
    name: 'aptly_get_work_orders',
    description: 'PRIMARY source for ALL work order questions. Returns open work orders from Aptly with full comments from vendors and Aloe team. Use for: counts, which WOs have no comments, vendor analysis, days open (7/14/30 days), repeat issues, unassigned WOs, HVAC/plumbing/pest queries, scheduled date analysis, average assignment time. Fields: title, stage, property, vendor, daysOpen, createdAt, scheduledDate, comments[].',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status/stage, e.g. "open", "pending", "closed". Omit for all.' },
        property: { type: 'string', description: 'Filter by property address or name.' },
        includeArchived: { type: 'boolean', description: 'Include archived/closed work orders. Default false.' },
      },
    },
  },
  {
    name: 'rv_get_work_order_notes',
    description: 'Get notes/comments for work orders from Rentvine — the ONLY way to check which work orders have comments. Use for: "which work orders have no comments", "which have no follow-up", "show comments on WO #X". When no workOrderId given, fetches notes for all open WOs and returns split: workOrdersWithNotes vs workOrdersWithNoNotes.',
    input_schema: {
      type: 'object',
      properties: {
        workOrderId: { type: 'string', description: 'Filter notes for a specific work order ID' },
      },
    },
  },
  {
    name: 'compare_work_orders',
    description: 'Compare work orders between Aptly and Rentvine to find mismatches. Use when asked to cross-reference, compare, or find work orders that are in one system but not the other. Fetches both systems, matches by workOrderNumber, and returns: matched pairs, work orders only in Aptly, work orders only in Rentvine, and status mismatches.',
    input_schema: { type: 'object', properties: {} },
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

// Search using Aptly's Meteor/DDP token — works for screening boards
async function aptlyMeteorSearch(boardId, query) {
  const meteorToken = process.env.APTLY_METEOR_TOKEN || APTLY_TOKEN;
  const url = new URL('https://app.getaptly.com/api/aptlet/' + boardId);
  url.searchParams.set('x-token', meteorToken);
  url.searchParams.set('query', query || '');
  url.searchParams.set('page', '0');
  const r = await fetch(url.toString());
  if (!r.ok) return [];
  const data = await r.json();
  return (data && data.cards) || (Array.isArray(data) ? data : []);
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
  return allCards.map(function(card) {
    // Extract array fields (like appPrimaryApplicant, appLocation) to their first name value
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
      // Raw built-in fields
      'Title': card.name || '',
      'Stage': card.stage || '',
      'Application Complete': card.appInputCompleted || card.readyToReview || '',
      'appApproved': card.appApproved || false,
      'Created At': card.createdAt || '',
      // Key custom fields extracted directly from known raw keys
      'Primary Applicant': extractName(card.appPrimaryApplicant),
      'Application Location': extractName(card.appLocation),
      'Household': card.appHousehold || '',
      'Move-In Date': card.appMoveInDate || '',
      'Total Household Mo. Income': card.appIncome ? '$' + card.appIncome.amount : '',
      'Avg. Household Credit': card.appCreditRating || '',
      // Comments — core-api may not return these; aptly_get_applicant re-fetches via aptlyFetch
      'comments': Array.isArray(card.comments) ? card.comments.map(function(c) {
        return { by: c.userName || c.name || 'Unknown', note: c.content || c.text || '', date: (c.createdAt || '').slice(0, 10) };
      }) : [],
    };
    // Also map any remaining UUID schema fields
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
        // Fetch work orders — page 1 only (100 records, most recent first)
        const p = { pageSize: 100, page: 1 };
        if (input.propertyId) p.propertyID = input.propertyId;
        const data = await rvFetch('/maintenance/work-orders', p);
        let rawWOs = Array.isArray(data) ? data : (data && data.data) || [];
        // Response is nested: [{workOrder:{...}, contact:{...}, unit:{...}}, ...]
        let allWOs = rawWOs.map(function(rec) {
          if (rec.workOrder) {
            return Object.assign({}, rec.workOrder, {
              unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
              vendorName: (rec.contact && rec.contact.name) || '',
            });
          }
          return rec;
        }).filter(function(wo) { return wo.workOrderID; });
        // Log status distribution
        const statusDist = {};
        allWOs.forEach(function(wo) {
          const sid = String(wo.primaryWorkOrderStatusID);
          statusDist[sid] = (statusDist[sid] || 0) + 1;
        });
        console.log('RV WO total raw:', allWOs.length, 'by primaryStatus:', JSON.stringify(statusDist));
        // Filter purely by primaryWorkOrderStatusID — dateClosed is unreliable in Rentvine
        // Status 4 = Completed, Status 5 = Cancelled. Everything else = open/active
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
        // Check for unassigned: no vendorContactID
        const unassigned = filtered.filter(function(wo) { return !wo.vendorContactID; });
        console.log('RV WO filtered:', filtered.length, 'unassigned:', unassigned.length);
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
        // Find property ID from address if not provided
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
        // Fetch ALL work orders for this property (no status filter)
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
        console.log('RV property WO history for propId', propId, ': total', wos.length, 'open', open.length, 'closed', closed.length);
        return JSON.stringify({ propertyId: propId, address: input.address, total: wos.length, open: open.length, closed: closed.length, workOrders: wos });
      }

      case 'rv_get_recurring_issues': {
        const daysBack = input.daysBack || 365;
        const minCount = input.minCount || 2;
        const targetCat = (input.category || '').toLowerCase();
        const cutoffMs = Date.now() - daysBack * 24 * 60 * 60 * 1000;
        // Categorize from description
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
        // Fetch multiple pages of ALL work orders (open + closed)
        let allWOs = [];
        for (let pg = 1; pg <= 10; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
        }
        console.log('RV recurring: total WOs fetched:', allWOs.length);
        // Group by address + category
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
        // Filter to those with minCount+ WOs
        const flagged = Object.values(byAddrCat)
          .filter(function(e) { return e.wos.length >= minCount; })
          .sort(function(a, b) { return b.wos.length - a.wos.length; });
        console.log('RV recurring: flagged properties:', flagged.length);
        if (flagged.length === 0) {
          return JSON.stringify({ message: 'No properties found with ' + minCount + '+ ' + (targetCat || '') + ' work orders in the last ' + daysBack + ' days.' });
        }
        return JSON.stringify({ total: flagged.length, daysBack, category: targetCat || 'all', results: flagged });
      }

      case 'rv_get_work_order_detail': {
        // Returns full work order including notes/statuses
        const detail = await rvFetch('/maintenance/work-orders/' + input.workOrderId);
        // Also fetch status updates (notes) for this work order
        const statuses = await rvFetch('/maintenance/work-order-statuses', { workOrderID: input.workOrderId, pageSize: 50, page: 1 });
        return JSON.stringify({ detail, statuses });
      }

      case 'rv_get_work_order_notes': {
        // Get notes for a specific work order or all open work orders
        if (input.workOrderId) {
          const data = await rvFetch('/maintenance/work-orders/' + input.workOrderId + '/statuses');
          console.log('RV WO notes for', input.workOrderId, ':', Array.isArray(data) ? data.length : JSON.stringify(data).slice(0, 100));
          return JSON.stringify(data);
        }
        // For all open WOs: fetch WOs first, then fetch notes for each
        const woData = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: 1 });
        const rawWOs = Array.isArray(woData) ? woData : (woData && woData.data) || [];
        const openWOs = rawWOs.map(function(rec) {
          return rec.workOrder ? Object.assign({}, rec.workOrder, { vendorName: (rec.contact && rec.contact.name) || '' }) : rec;
        }).filter(function(wo) {
          const sid = parseInt(wo.primaryWorkOrderStatusID);
          return wo.workOrderID && sid !== 4 && sid !== 5;
        });
        // Fetch notes for each open WO in parallel (limit 30 to avoid rate limits)
        const notesResults = await Promise.all(openWOs.slice(0, 30).map(async function(wo) {
          try {
            const notes = await rvFetch('/maintenance/work-orders/' + wo.workOrderID + '/statuses');
            return { workOrderID: wo.workOrderID, workOrderNumber: wo.workOrderNumber, description: wo.description, notes: Array.isArray(notes) ? notes : [] };
          } catch(e) { return { workOrderID: wo.workOrderID, workOrderNumber: wo.workOrderNumber, description: wo.description, notes: [] }; }
        }));
        const withNotes = notesResults.filter(function(r) { return r.notes.length > 0; });
        const noNotes = notesResults.filter(function(r) { return r.notes.length === 0; });
        console.log('RV WO notes: checked', notesResults.length, 'WOs, with notes:', withNotes.length, 'no notes:', noNotes.length);
        return JSON.stringify({ total: notesResults.length, withNotes: withNotes.length, noNotes: noNotes.length, workOrdersWithNoNotes: noNotes, workOrdersWithNotes: withNotes });
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
        // Renter Leads and other boards use core-api (same token as Units/Applicants)
        const coreApiBoards = ['4EMDSYKirhQaNdQKz', 'MJxaStgENouWrNEKd', 'K9mMGGjKgQPqDykaa', 'YA3QWmPebvMwLwbB3', '86YrLPbwdkxtdyZoj'];
        if (coreApiBoards.indexOf(boardId) !== -1) {
          // Fetch schema for label mapping
          const schemaData = await unitsFetch('/api/schema/' + boardId);
          const schemaMap = {};
          if (Array.isArray(schemaData)) schemaData.forEach(function(f) { schemaMap[f.key] = f.label; });
          // Paginate fully to get all cards
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
            if (pg > 10) break; // safety cap
          }
          // Map UUID keys to labels
          const withComments = allCards.map(function(card) {
            const m = { _cardId: card.cardId, stage: card.stage, createdAt: card.createdAt };
            Object.keys(card).forEach(function(k) {
              m[schemaMap[k] || k] = card[k];
            });
            // Add formatted comments
            m.formatted_comments = Array.isArray(card.comments) && card.comments.length > 0
              ? card.comments.map(function(cm) { return (cm.userName || 'Unknown') + ' (' + (cm.createdAt || '').slice(0, 10) + '): ' + (cm.content || ''); })
              : [];
            return m;
          });
          console.log('Board', boardId, 'total cards fetched:', allCards.length, 'schema fields:', Object.keys(schemaMap).length);
          return JSON.stringify({ cards: withComments, total: allCards.length });
        }
        // Other boards use app.getaptly.com
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
          { id: 'workOrder', name: 'Work Orders', description: 'Maintenance work orders — stage, vendor, property, created date, days open, comments' },
        ]);
      }

      case 'compare_work_orders': {
        // Fetch all active work orders from both systems simultaneously
        const [rvData, aptlyData] = await Promise.all([
          rvFetch('/maintenance/work-orders', { pageSize: 100, page: 1 }),
          unitsFetch('/api/board/workOrder', { page: 0, pageSize: 100, includeArchived: false }),
        ]);

        // Process Rentvine — unwrap nested response
        const rvRaw = Array.isArray(rvData) ? rvData : [];
        const rvWOs = rvRaw.map(function(rec) {
          return rec.workOrder ? Object.assign({}, rec.workOrder, {
            unitAddress: (rec.unit && (rec.unit.address || rec.unit.name)) || '',
            vendorName: (rec.contact && rec.contact.name) || '',
          }) : rec;
        }).filter(function(wo) {
          return wo.workOrderID && parseInt(wo.primaryWorkOrderStatusID) !== 4 && parseInt(wo.primaryWorkOrderStatusID) !== 5;
        });

        // Process Aptly — filter to active only
        const aptlyRaw = Array.isArray(aptlyData) ? aptlyData : (aptlyData && aptlyData.data) || [];
        const aptlyWOs = aptlyRaw.filter(function(c) {
          return !c.archived && !/completed|cancelled|rejected/i.test(c.stage || '');
        });

        // Build lookup maps by workOrderNumber
        const rvByNumber = {};
        rvWOs.forEach(function(wo) {
          if (wo.workOrderNumber) rvByNumber[String(wo.workOrderNumber)] = wo;
        });
        const aptlyByNumber = {};
        aptlyWOs.forEach(function(c) {
          if (c.workOrderNumber) aptlyByNumber[String(c.workOrderNumber)] = c;
        });

        // Find matches and mismatches
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
            // Check status alignment
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

        // Find work orders in Rentvine but not Aptly
        const rvOnly = rvWOs.filter(function(wo) {
          return wo.workOrderNumber && !aptlyByNumber[String(wo.workOrderNumber)];
        }).map(function(wo) {
          return { number: String(wo.workOrderNumber), title: wo.description || '?', rvStatusId: wo.primaryWorkOrderStatusID, property: wo.unitAddress || '' };
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
          aptlyOnly: aptlyOnly,
          rvOnly: rvOnly,
          statusMismatch: statusMismatch,
        });
      }

      case 'aptly_get_leads': {
        // Fetch all Renter Leads from core-api with schema mapping
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', {
          page: 0, pageSize: 100,
          includeArchived: input.includeArchived ? true : false,
        });
        const allCards = Array.isArray(data) ? data : (data && data.data) || [];
        // Map UUID keys to labels
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
        // Filter by daysBack if specified
        if (input.daysBack) {
          const cutoffMs = Date.now() - input.daysBack * 24 * 60 * 60 * 1000;
          leads = leads.filter(function(c) {
            try { return new Date(c.createdAt).getTime() > cutoffMs; } catch(e) { return false; }
          });
        }
        // Filter by property if specified
        if (input.property) {
          const p = input.property.toLowerCase();
          leads = leads.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(p); });
        }
        // Filter by stage if specified
        if (input.stage) {
          const s = input.stage.toLowerCase();
          leads = leads.filter(function(c) { return (c.stage || '').toLowerCase().includes(s); });
        }
        // Return rich data for each lead
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
        // Fetch work orders from Aptly core-api (board ID: workOrder)
        let allWOs = [];
        let page = 0;
        while (true) {
          const params = { page, pageSize: 100, includeArchived: false };
          const data = await unitsFetch('/api/board/workOrder', params);
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          console.log('Aptly WO page', page, ':', batch.length, 'cards');
          if (batch.length === 0) break;
          const active = batch.filter(function(c) { return !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''); });
          allWOs = allWOs.concat(active);
          if (batch.length < 100) break;
          if (page >= 1) break;
          page++;
        }
        console.log('Aptly WO total fetched:', allWOs.length);

        // Filter by input
        let filtered = allWOs;
        if (input.status) {
          const s = input.status.toLowerCase();
          if (s === 'open' || s === 'not closed') {
            filtered = allWOs; // already filtered above
          } else {
            filtered = allWOs.filter(function(c) { return (c.stage || '').toLowerCase().includes(s); });
          }
        }
        if (input.property) {
          const p = input.property.toLowerCase();
          filtered = filtered.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(p); });
        }

        // Calculate metrics using raw field names
        const now = Date.now();
        const withMetrics = filtered.map(function(c) {
          const created = c.createdAt ? new Date(c.createdAt).getTime() : null;
          const daysOpen = created ? Math.floor((now - created) / 86400000) : null;
          return Object.assign({}, c, { daysOpen });
        });

        const open = withMetrics; // already filtered to non-closed
        const unassigned = open.filter(function(c) { return !c.vendor; });
        const byStage = {};
        withMetrics.forEach(function(c) { const s = c.stage || 'Unknown'; byStage[s] = (byStage[s] || 0) + 1; });

        // Slim output — address first, issue type instead of full description
        const slim = withMetrics.map(function(c) {
          const unitArr = Array.isArray(c.unit) ? c.unit : (c.unit ? [c.unit] : []);
          const locArr = Array.isArray(c.location) ? c.location : (c.location ? [c.location] : []);
          const address = (locArr[0] && locArr[0].name) || (unitArr[0] && unitArr[0].name) || '';
          const vendorArr = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
          const vendor = (vendorArr[0] && vendorArr[0].name) || 'Unassigned';
          const rawDesc = c.description || c.name || '?';
          const cleanDesc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          return {
            address: address,
            num: c.workOrderNumber || c.number || '',
            issue: cleanDesc.split(/\s+/).slice(0, 6).join(' '),
            vendor: vendor,
            opened: (c.createdAt || '').slice(0, 10),
            daysOpen: c.daysOpen,
            status: c.stage || '',
          };
        });
        console.log('Aptly WO slim:', slim.length, 'unassigned:', unassigned.length);
        if (slim.length > 0) {
          const s = withMetrics[0];
          console.log('WO[0] unit:', JSON.stringify(s.unit).slice(0,100), '| vendor:', JSON.stringify(s.vendor).slice(0,80), '| keys:', Object.keys(s).join(','));
        }

        return JSON.stringify({
          total: withMetrics.length,
          open: open.length,
          unassigned: unassigned.length,
          avgDaysOpen: open.length ? Math.round(open.reduce(function(s, c) { return s + (c.daysOpen || 0); }, 0) / open.length) : 0,
          byStage: byStage,
          workOrders: slim,
        });
      }

      case 'aptly_get_applicant': {
        const q = (input.query || '').toLowerCase();
        // Step 1: Find matching cards via getApplicantsCards (supports address + name search)
        const allCards = await getApplicantsCards();
        const matched = allCards.filter(function(c) {
          return JSON.stringify(c).toLowerCase().includes(q);
        });
        if (matched.length === 0) {
          return JSON.stringify({ message: 'No applicant found matching: ' + input.query });
        }
        // Step 2: For each match, search by applicant name using APTLY_METEOR_TOKEN
        // The Meteor token gives full access including comments on screening boards
        const results = await Promise.all(matched.map(async function(c) {
          const fullName = c['Primary Applicant'] || '';
          const cardId = c._cardId || '';
          let comments = ['No comments'];
          if (cardId) {
            try {
              // Try core-api comments endpoint
              const commentsData = await unitsFetch('/api/board/MJxaStgENouWrNEKd/' + cardId + '/comments');
              console.log('Comments for', fullName, ':', JSON.stringify(commentsData).slice(0, 200));
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
            comments: comments,
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
            // Applicants board uses aptlyFetch with the search query directly
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
  }
  if (msg.match(/owner|landlord|portfolio|performing|statement/)) {
    ['rv_get_owners', 'rv_get_properties'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly|tour|showing|schedul|appointment|visit/)) {
    ['aptly_get_board_cards', 'aptly_list_boards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
    ['rv_get_inspections', 'rv_get_properties', 'zi_get_inspections'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/lead|prospect/) && msg.match(/new|this week|today|came|recent|incoming|how many|what|pipeline|count|source|zillow/)) {
    tools.add('aptly_get_leads');
  }
  if (msg.match(/applicant|application|applied|applying|screening|comment|note.*card|card.*note|what.*said|who.*said/)) {
    tools.add('aptly_get_applicant');
    tools.add('aptly_search_cards');
  }
  // Also add aptly_get_applicant when asking about a specific address with comment/note context
  if (msg.match(/comment|note|said|pomf|update/) && msg.match(/\d+\s+\w/)) {
    tools.add('aptly_get_applicant');
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
          // Check Available Date or Stage Changed date
          const dateStr = c['Available Date'] || c['Stage Changed'] || c['Created At'] || '';
          if (!dateStr) return false;
          try {
            return (now - new Date(dateStr).getTime()) > threshold;
          } catch(e) { return false; }
        }).sort(function(a, b) {
          const da = new Date(a['Available Date'] || a['Stage Changed'] || 0).getTime();
          const db = new Date(b['Available Date'] || b['Stage Changed'] || 0).getTime();
          return da - db; // oldest first
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
        // Filter out archived/closed — only show active applications
        const active = filtered.filter(function(c) {
          return !c.archived && c.Stage !== 'Application Closed' && c.Stage !== 'Archived';
        });
        // Group active by completion status
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
        // Only show complete, partial, and approved — not bare incomplete unless asked
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
        // Use location board — Date Contract Begins is when Aloe PM started managing the property
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
        // Parse date from ISO or MM/DD/YYYY
        const parseDate = function(raw) {
          if (!raw) return null;
          const mmdd = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (mmdd) { try { return new Date(mmdd[3]+'-'+mmdd[1].padStart(2,'0')+'-'+mmdd[2].padStart(2,'0')).getTime(); } catch(e) {} }
          try { const ms = new Date(raw).getTime(); return isNaN(ms) ? null : ms; } catch(e) { return null; }
        };
        // Get the best "onboarded" date — prefer Date Contract Begins, fall back to Created At
        const getOnboardMs = function(c) {
          return parseDate(c['Date Contract Begins'] || '') || parseDate(c['Created At'] || '') || null;
        };
        // Filter to properties onboarded within cutoff
        const newProps = mapped.filter(function(c) {
          const ms = getOnboardMs(c);
          return ms !== null && ms > cutoffMs;
        }).sort(function(a, b) { return (getOnboardMs(b) || 0) - (getOnboardMs(a) || 0); });
        console.log('Onboard: total locations:', mapped.length, 'new in', daysBack, 'days:', newProps.length);
        // Sample first card dates for debug
        if (mapped.length > 0) { const s = mapped[0]; console.log('Sample Created At:', s['Created At'], '| Contract:', s['Date Contract Begins']); }
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
          // Show most recently contracted
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
        // Fetch schema + all Move-Ins cards
        const schemaData = await unitsFetch('/api/schema/K9mMGGjKgQPqDykaa');
        const schemaMap = {};
        if (Array.isArray(schemaData)) schemaData.forEach(function(f) { schemaMap[f.key] = f.label; });
        let allCards = [];
        let pg = 0;
        while (true) {
          const data = await unitsFetch('/api/board/K9mMGGjKgQPqDykaa', { page: pg, pageSize: 50 });
          const batch = Array.isArray(data) ? data : (data && data.data) || [];
          if (batch.length === 0) break;
          // Map UUID keys to labels
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
        // AZ time
        const azNow = new Date(Date.now() - 7 * 60 * 60 * 1000);
        const azToday = new Date(azNow); azToday.setHours(0,0,0,0);
        // Next week boundaries (Mon-Sun of next week, or just next 14 days)
        // Helper to extract string value from field that may be object/array
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
        // Determine time window
        let windowStart = todayMs;
        let windowEnd = todayMs + 14 * 24 * 60 * 60 * 1000; // default 14 days
        let windowLabel = 'upcoming (next 14 days)';
        if (lowerMsg.includes('next week')) {
          const dow = azToday.getDay(); // 0=Sun
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
        // Filter: active stages only, within window
        const excluded = /abandoned|moved in/i;
        const filtered = allCards.filter(function(c) {
          if (excluded.test(c._stage || '')) return false;
          const ms = parseMoveinDate(c);
          return ms !== null && ms >= windowStart && ms < windowEnd;
        }).sort(function(a, b) { return (parseMoveinDate(a) || 0) - (parseMoveinDate(b) || 0); });
        const fmt = function(c) {
          // Title is always a plain string: "04/17/2026 Erik Gunderson; Emeleen Adler 2705 W Estrella Dr..."
          const title = strField(c['Title'] || c.name || '');
          // Extract just the names from title (between date and address)
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

    // Server-side shortcut for recurring category issues across all work orders (open + closed)
    const isRecurringQ = lowerMsg.match(/recurring|came back|again|multiple.*time|more than once|history.*issue|issue.*history|closed.*work.*order|billed.*work.*order|past.*year|within.*year|how many times|repeat.*hvac|hvac.*repeat|same.*hvac|hvac.*same|hvac.*issue|plumb.*repeat|repeat.*plumb|repeat.*appliance|appliance.*repeat|repeat.*electric|same.*issue.*before|previous.*issue|pattern|trend/);
    if (isRecurringQ) {
      try {
        // Determine category filter
        let catFilter = '';
        if (lowerMsg.match(/hvac|ac\b|air.?condition|heat/)) catFilter = 'HVAC';
        else if (lowerMsg.match(/plumb|toilet|drain|leak|pipe/)) catFilter = 'Plumbing';
        else if (lowerMsg.match(/electric|outlet|light/)) catFilter = 'Electrical';
        else if (lowerMsg.match(/appliance|fridge|dishwasher|washer|dryer|microwave/)) catFilter = 'Appliance';
        else if (lowerMsg.match(/roof/)) catFilter = 'Roofing';
        const daysMatch = lowerMsg.match(/(\d+)\s*(?:day|month|year)/);
        let daysBack = 365;
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
        // Fetch all WOs from Rentvine (open + closed)
        let allWOs = [];
        for (let pg = 1; pg <= 10; pg++) {
          const d = await rvFetch('/maintenance/work-orders', { pageSize: 100, page: pg });
          const batch = Array.isArray(d) ? d : (d && d.data) || [];
          if (batch.length === 0) break;
          allWOs = allWOs.concat(batch);
          if (batch.length < 100) break;
        }
        console.log('Recurring shortcut: fetched', allWOs.length, 'WOs, catFilter:', catFilter || 'all');
        // Group by address + category
        const byAddrCat = {};
        allWOs.forEach(function(rec) {
          const wo = rec.workOrder || rec;
          const addr = (rec.unit && (rec.unit.address || rec.unit.name)) || '';
          if (!addr) return;
          const created = wo.dateTimeCreated ? new Date(wo.dateTimeCreated).getTime() : 0;
          if (created < cutoffMs) return;
          const desc = (wo.description || '').replace(/<[^>]+>/g, ' ');
          const cat = categorizeRV(desc);
          if (catFilter && cat !== catFilter) return;
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

    // Server-side shortcut for repeat issues / property work order history
    const isRepeatQ = lowerMsg.match(/repeat.*issue|issue.*repeat|recurring|same.*issue|same.*problem|multiple.*work.*order|same.*type|issue.*type|category|any.*propert.*same/);
    if (isRepeatQ) {
      try {
        // Fetch all open Aptly WOs
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
        // Categorize issue type from description + vendorTrade
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
        // Build per-property data
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
          // Cross-property: find issue categories that appear at multiple properties
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
        // Default: properties with 2+ open WOs
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

    // Server-side shortcut for work order questions — formats output directly
    const isWOQ = lowerMsg.match(/work.?order|work order/) && lowerMsg.match(/open|list|show|what|which|over|past|days|unassign|vendor|address|all|scheduled|start|most|property|home|propert/);
    if (isWOQ) {
      console.log('WO shortcut fired for:', lowerMsg.slice(0, 60));
      try {
        // Fetch schema to find scheduled date UUID keys
        let schedKey = null;
        try {
          const woSchema = await unitsFetch('/api/schema/workOrder');
          const woMap = {};
          if (Array.isArray(woSchema)) woSchema.forEach(function(f) { if (f && f.label) woMap[f.label] = f.key; });
          schedKey = woMap['Appointment Window Start'] || woMap['Scheduled Start Date'] || woMap['Start Date'] || woMap['Scheduled Date'] || null;
          console.log('WO schedKey:', schedKey);
        } catch(schemaErr) { console.log('WO schema fetch failed:', schemaErr.message); }
        // Fetch work orders
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
        const todayStr = new Date(now - 7*60*60*1000).toISOString().slice(0, 10); // AZ time approx
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
            address: address,
            num: c.workOrderNumber || '',
            issue: cleanDesc.split(/\s+/).slice(0, 6).join(' '),
            status: c.stage || '',
            daysOpen: daysOpen,
            vendor: vendor,
            schedDate: schedDate,
            isPastScheduled: isPastScheduled,
          };
        });

        const daysMatch = lowerMsg.match(/over\s+(\d+)\s*day|(\d+)\s*day/);
        const daysFilter = daysMatch ? parseInt(daysMatch[1] || daysMatch[2]) : null;
        const unassignedOnly = lowerMsg.match(/unassign/);
        const pastScheduled = lowerMsg.match(/past.*sched|sched.*past|past.*start|overdue|past their/);
        const vendorSummary = lowerMsg.match(/vendor.*most|most.*vendor|vendor.*count|how many.*vendor|vendor.*how many|vendor.*list|which vendor|per vendor|by vendor|vendor.*amount|amount.*vendor|vendor.*breakdown|breakdown.*vendor/);
        const propertySummary = lowerMsg.match(/most.*work.*order|work.*order.*most|most.*submit|submit.*most|most.*open|propert.*most|home.*most|which.*home|which.*propert|by.*property|per.*property|property.*count|address.*most/);
        let filtered = wos;
        if (pastScheduled) {
          filtered = wos.filter(function(w) { return w.isPastScheduled; });
          if (filtered.length === 0 && !schedKey) filtered = wos.filter(function(w) { return /scheduled/i.test(w.status); });
        } else if (daysFilter) {
          filtered = wos.filter(function(w) { return w.daysOpen > daysFilter; });
        } else if (unassignedOnly) {
          filtered = wos.filter(function(w) { return w.vendor === 'Unassigned'; });
        }
        filtered.sort(function(a, b) { return b.daysOpen - a.daysOpen; });
        // Property summary mode
        if (propertySummary) {
          const propCounts = {};
          wos.forEach(function(w) { if (w.address && w.address !== '?') propCounts[w.address] = (propCounts[w.address] || 0) + 1; });
          const sorted = Object.entries(propCounts).sort(function(a, b) { return b[1] - a[1]; });
          const lines = sorted.map(function(e) { return e[0] + ': ' + e[1] + ' work order' + (e[1] !== 1 ? 's' : ''); });
          return res.json({ content: [{ type: 'text', text: 'Open work orders by property (' + wos.length + ' total):\n\n' + lines.join('\n') }] });
        }
        // Vendor summary mode
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
        const header = pastScheduled ? 'Work orders past scheduled start date (' + filtered.length + ' of ' + wos.length + '):'
          : daysFilter ? 'Work orders open over ' + daysFilter + ' days (' + filtered.length + ' of ' + wos.length + ' total):'
          : unassignedOnly ? 'Unassigned work orders (' + filtered.length + '):'
          : 'Open work orders (' + filtered.length + '):';
        return res.json({ content: [{ type: 'text', text: header + '\n\n' + lines.join('\n') }] });
      } catch(e) {
        console.error('WO shortcut error:', e.message);
      }
    }

    // Server-side shortcut for new leads    // Server-side shortcut for new leads questions
    const isLeadsQ = lowerMsg.match(/lead|prospect/) && lowerMsg.match(/new|this week|today|came|recent|incoming|how many|come in|what.*lead|lead.*what/);
    if (isLeadsQ) {
      try {
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        // Fetch all leads with updatedAtMin from 7 days ago
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100, updatedAtMin: weekAgo });
        const raw = Array.isArray(data) ? data : (data && data.data) || [];
        // Map UUID keys to labels
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
        // Filter to only this week's new leads by createdAt
        const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const newLeads = cards.filter(function(c) {
          return c.createdAt && new Date(c.createdAt).getTime() > weekAgoMs;
        });
        const toShow = newLeads.length > 0 ? newLeads : cards; // fallback to all if none this week
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
        // Fetch schema first so we can map UUID keys to labels
        const schema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
        const schemaMap = {};
        if (Array.isArray(schema)) schema.forEach(function(f) { schemaMap[f.key] = f.label; });
        // Fetch all Renter Leads cards
        const data = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: 0, pageSize: 100 });
        const allCards = Array.isArray(data) ? data : (data && data.data) || [];
        // Map UUID keys to labels for each card
        const mapCard = function(c) {
          const m = { _id: c.cardId, stage: c.stage, createdAt: c.createdAt, comments: c.comments };
          Object.keys(c).forEach(function(k) { if (schemaMap[k]) m[schemaMap[k]] = c[k]; });
          return m;
        };
        const mapped = allCards.map(mapCard);
        // Get cards with any showing-related info
        const showingCards = mapped.filter(function(c) {
          return c['Requested Showing Information'] || c['Tour Date/Time'] ||
                 /scheduled tour|tour completed|tour canceled/i.test(c.stage || '');
        });
        // Parse date from "Showing request for Name (MM/DD/YYYY HH:MM am-...)"
        const parseShowingDate = function(c) {
          const raw = c['Requested Showing Information'];
          const info = typeof raw === 'string' ? raw : (raw && (raw.value || raw.name || JSON.stringify(raw))) || '';
          const m = info.match(/\((\d{2}\/\d{2}\/\d{4})/);
          if (m) return m[1];
          const td = String(c['Tour Date/Time'] || '').slice(0, 10);
          return td;
        };
        // AZ time boundaries (UTC-7, no DST)
        const nowUtc = Date.now();
        const azOffset = -7 * 60 * 60 * 1000;
        const nowAz = new Date(nowUtc + azOffset);
        const todayAz = new Date(nowAz); todayAz.setHours(0,0,0,0);
        const weekStart = new Date(todayAz); weekStart.setDate(todayAz.getDate() - todayAz.getDay());
        const fmt = function(c) {
          const contact = c['Primary Contact'] || c['Name'] || '?';
          const unit = c['Preferred Rental'] || c['Unit'] || '?';
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
          // If none today, also show upcoming
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
          // Default: show ALL showing activity
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

const FAQ_TABS = [
  {
    id: "maintenance", label: "🔧 Maintenance", color: "#fff7ed", border: "#f97316", accent: "#ea580c",
    questions: [
      {icon:"📅", text:"What work orders have been open over 30 days?"},
      {icon:"⏰", text:"What work orders have been open over 7 days?"},
      {icon:"🗓️", text:"What work orders have been open over 14 days?"},
      {icon:"🚨", text:"What work orders are still open past their scheduled start date?"},
      {icon:"🏢", text:"Which vendor has the most open work orders?"},
      {icon:"📊", text:"Show me the amount of work orders opened per vendor"},
      {icon:"🔁", text:"Are there repeat issues at any property?"},
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
          <div style={{textAlign:"center",fontSize:11,color:"#aaa",marginTop:6}}>Rentvine · Aptly · Notion · Slack · All data is live</div>
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
