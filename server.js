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
const SLACK_TOKEN         = process.env.SLACK_TOKEN;

const RENTVINE_BASE = `https://${RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
const RENTVINE_AUTH = Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString('base64');

const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

RENTVINE — Source of truth for all property management data:
- Tenant info, balances, ledger, payment history, unpaid charges with full breakdown
- Lease details, move-in/out dates, lease terms, rent amounts, deposit, lease status
- Property and unit details, availability, beds/baths, addresses
- Owner info, portfolio details, contact information
- Work orders, maintenance, inspections, vendors

APTLY — CRM and workflow boards:
- List Property board (ID: qfBzBxfooJtfTQncd) — properties listed for rent, shows rent ready, showings enabled, published status. USE THIS to check if a home is listed/available.
- Renter Leads board (ID: 4EMDSYKirhQaNdQKz) — showing STATS and activity only, NOT availability. DO NOT use this for availability checks.
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards (IDs TBD)

NOTION — Company policies and SOPs
SLACK — Team communications

STRICT RULES:

1. DETERMINING PROPERTY AVAILABILITY — always do ALL of these:
   a) Call rv_get_leases with status "all" for the address — get full lease data including tenant names, lease status text, endDate, moveOutDate, expectedMoveOutDate
   b) Search Aptly List Property board (ID: qfBzBxfooJtfTQncd) using aptly_search_cards — this shows homes actively listed for rent with rent ready, showings enabled, and published status
   c) DO NOT check Renter Leads for availability — it does not contain that data

2. READING LEASE DATA:
   - primaryLeaseStatusID=1 = occupied. Report tenant names, lease end date, and the lease status text (e.g. "Active", "Active - Notice Given")
   - "Active - Notice Given" means tenant has given notice to vacate — home will be available soon
   - primaryLeaseStatusID=2 = vacated
   - No lease = vacant
   - NEVER say "available" for a property with an active lease
   - NEVER ignore tenant names — always include them if present

3. RESPONSE TONE for showing/availability questions:
   Use a warm, natural leasing voice. Match this style:
   - Occupied, notice given: "That home isn't available for showings just yet — we do have current residents in place through [date]. Once we get closer to their move-out date, we'll get the home listed and ready for tours. I'd love to add you to our interest list so we can reach out as soon as it's available!"
   - Occupied, no notice: "That home is currently occupied and not available for showings. The lease runs through [date]."
   - Listed/published in Aptly: "That home is available! It's listed at $[rent]/month, [beds]bd/[baths]ba. Showings are [enabled/not yet enabled]."
   - Vacant but not listed: "The home is vacant but not yet listed. We're getting it ready — I can add you to our interest list."

4. FALLBACK ROUTING — only when you have truly zero data:
   - Leasing / showings → Dhyana
   - Maintenance → Roberto
   - HOA → Juan
   - Move-out / renewals → Persia
   - Maricopa with zero data → Teri
   - Owner/landlord → Alexes
   - Accounting → Randi
   DO NOT route if you found lease data — that IS sufficient to answer.

5. NEVER SAY: "I couldn't access", "inaccessible", "limited data", "cannot be toured", "tours are not possible", "next steps would be", "you should", "I recommend", "reach out to X" when you have data`;


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
    description: 'Returns the known Aptly board IDs for Aloe PM. Use these IDs with aptly_search_cards and aptly_get_board_cards.',
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
          return JSON.stringify(allData.filter(function(item) {
            const p = item.property || {};
            const full = (p.address || '') + ' ' + (p.city || '') + ' ' + (p.name || '');
            return fuzzyMatch(input.search, full);
          }));
        }
        return JSON.stringify(allData);
      }

      case 'rv_get_units': {
        // If we have a propertyId, use the per-property units endpoint
        if (input.propertyId) {
          const units = await rvFetch('/properties/' + input.propertyId + '/units');
          if (!units.error) {
            // Cross-reference with active leases to tag availability
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
        }
        // Fallback: derive unit info from the full lease export
        // This works because leases include full unit and property data
        const allLeases = await rvFetch('/leases/export', { pageSize: 200 });
        if (input.search && Array.isArray(allLeases)) {
          return JSON.stringify(allLeases.filter(function(item) {
            const full = (item.unit && item.unit.address || '') + ' ' +
                         (item.property && item.property.address || '') + ' ' +
                         (item.property && item.property.city || '');
            return fuzzyMatch(input.search, full);
          }));
        }
        if (input.propertyId && Array.isArray(allLeases)) {
          return JSON.stringify(allLeases.filter(function(item) {
            return item.lease && item.lease.propertyID == input.propertyId;
          }));
        }
        return JSON.stringify(allLeases);
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
        return JSON.stringify(await aptlyFetch('/aptlet/' + input.boardId, { page: input.page || 0 }));
      }

      case 'aptly_list_boards': {
        return JSON.stringify([
          { name: 'List Property (Listings)', id: 'qfBzBxfooJtfTQncd', note: 'Properties listed for rent — rent ready, showings enabled, published status' },
          { name: 'Renter Leads', id: '4EMDSYKirhQaNdQKz', note: 'Showing activity and lead stats only — NOT listing availability' },
          { name: 'Move-Ins', id: 'UNKNOWN', note: 'New tenant move-in pipeline' },
          { name: 'Move-Outs', id: 'UNKNOWN', note: 'Tenant move-out pipeline' },
          { name: 'Tenant Renewals', id: 'UNKNOWN', note: 'Lease renewal pipeline' },
          { name: 'HOA Violations', id: 'UNKNOWN', note: 'HOA violation tracking' },
        ]);
      }

      case 'aptly_search_cards': {
        const data = await aptlyFetch('/aptlet/' + input.boardId, { page: 0 });
        if (Array.isArray(data && data.cards)) {
          const q = input.query.toLowerCase();
          return JSON.stringify(Object.assign({}, data, {
            cards: data.cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(q); }),
          }));
        }
        return JSON.stringify(data);
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

  if (msg.match(/tenant|owe|balance|ledger|payment|charge|deposit|past.?due|unpaid|how much/)) {
    ['rv_get_leases', 'rv_get_ledger', 'rv_get_transactions'].forEach(function(t) { tools.add(t); });
  }
  if (msg.match(/availab|unit|vacant|propert|homes?|house|bed|bath|address|tour|showing|schedul|appointment|visit|\d{4,5}/)) {
    ['rv_get_leases', 'rv_get_properties', 'aptly_list_boards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
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
  if (msg.match(/lead|pipeline|move.?in|move.?out|hoa|renewal|board|card|aptly/)) {
    ['aptly_get_board_cards', 'aptly_list_boards', 'aptly_search_cards'].forEach(function(t) { tools.add(t); });
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

    let current = messages.slice();

    for (let i = 0; i < 8; i++) {
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
          system: SYSTEM_PROMPT,
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
        return {
          type: 'tool_result',
          tool_use_id: tb.id,
          content: await executeTool(tb.name, tb.input),
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

app.get('/debug/lease/:id', async function(req, res) {
  const data = await rvFetch('/leases/export', { 'leaseIDs[]': req.params.id });
  res.json(data);
});

app.get('/debug/aptly/ticket/:id', async function(req, res) {
  const id = req.params.id;
  const results = {};
  const paths = [
    '/aptlet-instance/' + id,
    '/ticket/' + id,
    '/instance/' + id,
    '/card/' + id,
    '/aptlet/' + id,
  ];
  for (const path of paths) {
    try {
      const r = await fetch('https://app.getaptly.com/api' + path + '?x-token=' + APTLY_TOKEN);
      if (r.ok) {
        results[path] = { status: r.status, data: await r.json() };
      } else {
        results[path] = { status: r.status, body: await r.text() };
      }
    } catch(e) {
      results[path] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/debug/aptly/units', async function(req, res) {
  const results = {};
  const endpoints = [
    '/location/unit', '/location/units', '/locations', '/units', '/properties',
    '/listing', '/listings', '/v1/units', '/v2/units', '/v1/locations',
    '/aptlet', '/aptlets', '/unit', '/property',
    '/location', '/v1/location', '/v1/listing', '/v2/listing',
  ];
  for (const ep of endpoints) {
    try {
      const r = await fetch('https://app.getaptly.com/api' + ep + '?x-token=' + APTLY_TOKEN);
      if (r.ok) {
        results[ep] = { status: r.status, data: await r.json() };
      } else {
        results[ep] = { status: r.status };
      }
    } catch(e) {
      results[ep] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/debug/aptly/listings', async function(req, res) {
  const data = await aptlyFetch('/aptlet/qfBzBxfooJtfTQncd', { page: 0 });
  res.json(data);
});

app.get('/debug/aptly/boards', async function(req, res) {
  const data = await aptlyFetch('/aptlets');
  res.json(data);
});

app.get('/debug/aptly/search/:boardId/:query', async function(req, res) {
  const data = await aptlyFetch('/aptlet/' + req.params.boardId, { page: 0 });
  const q = req.params.query.toLowerCase();
  if (Array.isArray(data && data.cards)) {
    res.json(data.cards.filter(function(c) { return JSON.stringify(c).toLowerCase().includes(q); }));
  } else {
    res.json(data);
  }
});

app.get('/debug/properties', async function(req, res) {
  const data = await rvFetch('/properties/export', { pageSize: 200 });
  res.json(data);
});

app.get('/debug/units', async function(req, res) {
  const data = await rvFetch('/units/export', { pageSize: 200 });
  res.json(data);
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
