import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Environment variables ─────────────────────────────────────────────────────
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const RENTVINE_API_KEY    = process.env.RENTVINE_API_KEY;
const RENTVINE_API_SECRET = process.env.RENTVINE_API_SECRET;
const RENTVINE_ACCOUNT    = process.env.RENTVINE_ACCOUNT;
const APTLY_TOKEN         = process.env.APTLY_TOKEN;
const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const SLACK_TOKEN         = process.env.SLACK_TOKEN;
// ZINSPECTOR_API_KEY is stored but zInspector has no public API
// Inspection data flows through Rentvine's inspection endpoints instead

const RENTVINE_BASE = `https://${RENTVINE_ACCOUNT}.rentvine.com/api/manager`;
const RENTVINE_AUTH = Buffer.from(`${RENTVINE_API_KEY}:${RENTVINE_API_SECRET}`).toString('base64');

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Aloe Assistant — the internal AI for Aloe Property Management, a full-service residential property management company serving the Phoenix metro area (Chandler, Scottsdale, Gilbert, Maricopa, San Tan Valley, and surrounding areas). You serve Randi (owner), Persia (assistant PM), Dhyana (leasing agent), and other staff.

You have access to these live data sources via tools:

RENTVINE — Source of truth for all property management data:
- Tenant info, balances, ledger, payment history, unpaid charges with full breakdown
- Lease details, move-in/out dates, lease terms, rent amounts, deposit
- Property and unit details, availability, beds/baths, addresses
- Owner info, portfolio details, contact information
- Work orders and maintenance requests
- Property inspections (move-in, move-out, periodic)
- Vendors and contractors

APTLY — CRM and workflow boards:
- Renter leads pipeline (board ID: 4EMDSYKirhQaNdQKz)
- Move-Ins, Move-Outs, HOA Violations, Tenant Renewals boards
- Contact and lead details

NOTION — Company policies and SOPs:
- Lease break policy, move-in/out procedures
- Pet policy, screening criteria, fee schedules
- HOA violation procedures, maintenance escalation, all SOPs

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
- If you can't find something: "Check with Randi or Persia directly."
- Tone: professional, helpful, like the most knowledgeable senior colleague on the team`;

// ── Tools definition ──────────────────────────────────────────────────────────
const ALL_TOOLS = [
  // RENTVINE — Leases & Tenants
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
    description: 'Get the full accounting ledger for a lease — all charges, payments, credits with dates and descriptions. Use after rv_get_leases to get the leaseId.',
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
  // RENTVINE — Properties & Units
  {
    name: 'rv_get_properties',
    description: 'Get all properties in the Aloe PM portfolio with address, owner, and status',
    input_schema: {
      type: 'object',
      properties: {
        isActive: { type: 'boolean', description: 'Active properties only (default: true)' },
      },
    },
  },
  {
    name: 'rv_get_units',
    description: 'Get units with rent, deposit, beds, baths, availability. Use to find vacant/available rentals.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'number', description: 'Filter by property ID (optional)' },
      },
    },
  },
  // RENTVINE — Owners
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
  // RENTVINE — Work Orders
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
  // RENTVINE — Inspections
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
  // RENTVINE — Tenants & Vendors
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
  // APTLY — Leads & Boards
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
  // NOTION — Policies
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
  // SLACK — Team communications
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

// ── API helpers ───────────────────────────────────────────────────────────────
async function rvFetch(path, params = {}) {
  const url = new URL(`${RENTVINE_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Basic ${RENTVINE_AUTH}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) return { error: `Rentvine ${r.status}: ${r.statusText}`, url: url.toString() };
  return r.json();
}

async function aptlyFetch(path, params = {}) {
  const url = new URL(`https://app.getaptly.com/api${path}`);
  url.searchParams.set('x-token', APTLY_TOKEN);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString());
  if (!r.ok) return { error: `Aptly ${r.status}: ${r.statusText}` };
  return r.json();
}

async function notionFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`https://api.notion.com/v1${path}`, opts);
  return r.json();
}

async function slackFetch(path, params = {}) {
  const url = new URL(`https://slack.com/api${path}`);
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  return r.json();
}

// ── Tool executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  console.log(`Executing tool: ${name}`, JSON.stringify(input).slice(0, 100));
  try {
    switch (name) {

      // ── RENTVINE ──────────────────────────────────────────────────────────
      case 'rv_get_leases': {
        const params = { pageSize: 25, page: input.page || 1 };
        if (input.status === 'inactive') params['primaryLeaseStatusIDs[]'] = 2;
        else if (input.status !== 'all') params['primaryLeaseStatusIDs[]'] = 1;
        const data = await rvFetch('/leases/export', params);
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(item =>
            item.lease?.tenants?.some(t =>
              t.name?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q)
            ) || item.property?.address?.toLowerCase().includes(q) ||
            item.unit?.address?.toLowerCase().includes(q)
          ));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_ledger': {
        const data = await rvFetch('/accounting/ledgers', { leaseID: input.leaseId, pageSize: 50 });
        return JSON.stringify(data);
      }

      case 'rv_get_transactions': {
        const data = await rvFetch('/accounting/transactions', { leaseID: input.leaseId, pageSize: 50 });
        return JSON.stringify(data);
      }

      case 'rv_get_properties': {
        const data = await rvFetch('/properties/export', {
          isActive: input.isActive !== false ? true : undefined,
          pageSize: 100,
        });
        return JSON.stringify(data);
      }

      case 'rv_get_units': {
  // Get all units from export
  const units = await rvFetch('/units/export', { pageSize: 100 });
  // Get active leases to determine which units are occupied
  const leases = await rvFetch('/leases/export', { 'primaryLeaseStatusIDs[]': 1, pageSize: 200 });
  const occupiedUnitIds = new Set(
    Array.isArray(leases) ? leases.map(l => l.lease?.unitID).filter(Boolean) : []
  );
  // Mark each unit as available or occupied
  if (Array.isArray(units)) {
    return JSON.stringify(units.map(u => ({
      ...u,
      isAvailable: !occupiedUnitIds.has(u.unitID),
    })));
  }
  // Fallback: just return leases with unit data
  const fallback = await rvFetch('/leases/export', { pageSize: 100 });
  return JSON.stringify(fallback);
}

      case 'rv_get_owners': {
        const data = await rvFetch('/contacts/owners', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(o =>
            o.name?.toLowerCase().includes(q) || o.email?.toLowerCase().includes(q)
          ));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_work_orders': {
        const params = { pageSize: 50, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        const data = await rvFetch('/maintenance/work-orders', params);
        if (input.status && input.status !== 'all' && Array.isArray(data)) {
          return JSON.stringify(data.filter(wo =>
            input.status === 'open' ? !wo.closedDate : !!wo.closedDate
          ));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_work_order_detail': {
        const data = await rvFetch(`/maintenance/work-orders/${input.workOrderId}`);
        return JSON.stringify(data);
      }

      case 'rv_get_inspections': {
        const params = { pageSize: 50, page: input.page || 1 };
        if (input.propertyId) params.propertyID = input.propertyId;
        const data = await rvFetch('/maintenance/inspections', params);
        return JSON.stringify(data);
      }

      case 'rv_get_inspection_detail': {
        const data = await rvFetch(`/maintenance/inspections/${input.inspectionId}`);
        return JSON.stringify(data);
      }

      case 'rv_get_tenants': {
        const data = await rvFetch('/contacts/tenants', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(t =>
            t.name?.toLowerCase().includes(q) || t.email?.toLowerCase().includes(q)
          ));
        }
        return JSON.stringify(data);
      }

      case 'rv_get_vendors': {
        const data = await rvFetch('/contacts/vendors', { pageSize: 100 });
        if (input.search && Array.isArray(data)) {
          const q = input.search.toLowerCase();
          return JSON.stringify(data.filter(v => v.name?.toLowerCase().includes(q)));
        }
        return JSON.stringify(data);
      }

      // ── APTLY ─────────────────────────────────────────────────────────────
      case 'aptly_get_board_cards': {
        const data = await aptlyFetch(`/aptlet/${input.boardId}`, { page: input.page || 0 });
        return JSON.stringify(data);
      }

      case 'aptly_list_boards': {
        const data = await aptlyFetch('/aptlets');
        return JSON.stringify(data);
      }

      case 'aptly_search_cards': {
        const data = await aptlyFetch(`/aptlet/${input.boardId}`, { page: 0 });
        if (Array.isArray(data?.cards)) {
          const q = input.query.toLowerCase();
          return JSON.stringify({
            ...data,
            cards: data.cards.filter(c => JSON.stringify(c).toLowerCase().includes(q)),
          });
        }
        return JSON.stringify(data);
      }

      // ── NOTION ────────────────────────────────────────────────────────────
      case 'notion_search': {
        const data = await notionFetch('/search', 'POST', {
          query: input.query,
          filter: { value: 'page', property: 'object' },
          page_size: 5,
        });
        if (data.results?.length > 0) {
          const pages = await Promise.all(
            data.results.slice(0, 3).map(async page => {
              const blocks = await notionFetch(`/blocks/${page.id}/children`);
              const text = (blocks.results || [])
                .map(b => {
                  const t = b.type;
                  return b[t]?.rich_text?.map(rt => rt.plain_text).join('') || '';
                })
                .filter(t => t.length > 0)
                .slice(0, 30)
                .join('\n');
              return {
                title: page.properties?.title?.title?.[0]?.plain_text ||
                       page.properties?.Name?.title?.[0]?.plain_text || 'Untitled',
                id: page.id,
                url: page.url,
                content: text || 'No text content',
              };
            })
          );
          return JSON.stringify(pages);
        }
        return JSON.stringify({ message: 'No Notion pages found', query: input.query });
      }

      case 'notion_get_page': {
        const blocks = await notionFetch(`/blocks/${input.pageId}/children?page_size=100`);
        const text = (blocks.results || [])
          .map(b => {
            const t = b.type;
            if (!b[t]?.rich_text) return null;
            return b[t].rich_text.map(rt => rt.plain_text).join('');
          })
          .filter(Boolean)
          .join('\n');
        return JSON.stringify({ pageId: input.pageId, content: text || 'No content found' });
      }

      // ── SLACK ─────────────────────────────────────────────────────────────
      case 'slack_search': {
        const data = await slackFetch('/search.messages', { query: input.query, count: 10 });
        if (data.messages?.matches) {
          return JSON.stringify(data.messages.matches.map(m => ({
            channel: m.channel?.name,
            user: m.username,
            text: m.text,
            timestamp: new Date(parseFloat(m.ts) * 1000).toLocaleString(),
            permalink: m.permalink,
          })));
        }
        return JSON.stringify({ message: 'No Slack results found', query: input.query });
      }

      case 'slack_get_channel_messages': {
        const data = await slackFetch('/conversations.history', {
          channel: input.channelId,
          limit: input.limit || 20,
        });
        if (data.messages) {
          return JSON.stringify(data.messages.map(m => ({
            text: m.text,
            timestamp: new Date(parseFloat(m.ts) * 1000).toLocaleString(),
            user: m.user,
          })));
        }
        return JSON.stringify({ error: data.error || 'Could not fetch messages' });
      }

      case 'slack_list_channels': {
        const data = await slackFetch('/conversations.list', { limit: 100, exclude_archived: true });
        if (data.channels) {
          return JSON.stringify(data.channels.map(c => ({ id: c.id, name: c.name, purpose: c.purpose?.value })));
        }
        return JSON.stringify({ error: data.error || 'Could not list channels' });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`Tool ${name} error:`, err.message);
    return JSON.stringify({ error: err.message, tool: name });
  }
}

// ── Claude API proxy ──────────────────────────────────────────────────────────
function getRelevantTools(msg) {
  msg = msg.toLowerCase();
  const rv_leases   = ['rv_get_leases','rv_get_ledger','rv_get_transactions'];
  const rv_props    = ['rv_get_properties','rv_get_units'];
  const rv_ops      = ['rv_get_work_orders','rv_get_work_order_detail','rv_get_inspections','rv_get_inspection_detail'];
  const rv_contacts = ['rv_get_owners','rv_get_tenants','rv_get_vendors'];
  const aptly_t     = ['aptly_get_board_cards','aptly_list_boards','aptly_search_cards'];
  const notion_t    = ['notion_search','notion_get_page'];
  const slack_t     = ['slack_search','slack_get_channel_messages','slack_list_channels'];
  let tools = new Set();
  if (msg.match(/tenant|owe|balance|ledger|payment|charge|rent|deposit|past.?due|unpaid/)) rv_leases.forEach(t=>tools.add(t));
  if (msg.match(/availab|unit|vacant|propert|homes?|house|bed|bath|address/)) rv_props.forEach(t=>tools.add(t));
  if (msg.match(/work.?order|maintenance|repair|inspect/)) rv_ops.forEach(t=>tools.add(t));
  if (msg.match(/vendor|contractor/)) tools.add('rv_get_vendors');
  if (msg.match(/owner|landlord|portfolio|performing/)) rv_contacts.filter(t=>t.includes('owner')).forEach(t=>tools.add(t));
  if (msg.match(/lead|aptly|pipeline|move.?in|move.?out|hoa|renewal|board/)) aptly_t.forEach(t=>tools.add(t));
  if (msg.match(/policy|procedure|sop|how do|what do|lease.?break|pet|fee|screen|criteria|steps?/)) notion_t.forEach(t=>tools.add(t));
  if (msg.match(/slack|team|announcement|update|channel/)) slack_t.forEach(t=>tools.add(t));
  if (tools.size===0) { rv_leases.forEach(t=>tools.add(t)); notion_t.forEach(t=>tools.add(t)); }
  return ALL_TOOLS.filter(t=>[...tools].slice(0,8).includes(t.name));
}
app.post('/api/chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
  const { messages } = req.body;
    const lastMsg = [...messages].reverse().find(m=>m.role==='user')?.content||'';
    const tools = getRelevantTools(lastMsg);
    let currentMessages = [...messages];
    let loopCount = 0;

    while (loopCount < 6) {
      loopCount++;
      const response = await fetch('https://api.anthropic.com/v1/messages', {
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
          messages: currentMessages,
          tools: tools,
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      console.log(`Loop ${loopCount}: stop_reason=${data.stop_reason}`);

      if (data.stop_reason !== 'tool_use') {
        return res.json(data);
      }

      // Execute all tool calls
      const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUseBlocks.map(async tb => ({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: await executeTool(tb.name, tb.input),
        }))
      );

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: data.content },
        { role: 'user', content: toolResults },
      ];
    }

    res.status(500).json({ error: 'Too many tool calls — please try a more specific question' });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  anthropic:  !!ANTHROPIC_API_KEY,
  rentvine:   !!(RENTVINE_API_KEY && RENTVINE_API_SECRET),
  aptly:      !!APTLY_TOKEN,
  notion:     !!NOTION_TOKEN,
  slack:      !!SLACK_TOKEN,
  note:       'zInspector has no public API — inspection data comes via Rentvine',
}));

// ── Serve the React app ───────────────────────────────────────────────────────
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
  {label:"Rentvine", bg:"#e6f0fb", border:"#85B7EB"},
  {label:"Aptly",    bg:"#EAF3DE", border:"#97C459"},
  {label:"Notion",   bg:"#f5f5f5", border:"#d0d0d0"},
  {label:"Slack",    bg:"#f0e6f6", border:"#c17edb"},
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
    [0,1,2].map(i => React.createElement('div',{key:i,style:{
      width:6,height:6,borderRadius:"50%",background:"#3B6D11",
      animation:\`ab 1.2s ease-in-out \${i*0.18}s infinite\`
    }}))
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
          <input ref={ref} type="password" value={val}
            onChange={e=>{setVal(e.target.value);setError(false);}}
            onKeyDown={e=>e.key==="Enter"&&attempt()}
            placeholder="Passcode"
            style={{width:"100%",fontSize:15,padding:"10px 14px",textAlign:"center",letterSpacing:"0.15em",border:\`1px solid \${error?"#e53e3e":"#e5e5e5"}\`,borderRadius:8,background:"#f9f9f9",color:"#1a1a1a",fontFamily:"inherit",marginBottom:error?8:12}}
          />
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
      const res = await fetch('/api/chat',{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({messages:next.map(m=>({role:m.role,content:m.content}))}),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const txt = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\\n")||"Sorry, try again.";
      setMessages([...next,{role:"assistant",content:txt}]);
    } catch(e) {
      setLastError(e.message);
      setMessages([...next,{role:"assistant",content:"Something went wrong — see error above."}]);
    }
    setLoading(false);
  };

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100vh"}}>
      {lastError && (
        <div style={{padding:"8px 16px",background:"#fff5f5",borderBottom:"1px solid #fed7d7",display:"flex",justifyContent:"space-between",flexShrink:0}}>
          <span style={{fontSize:12,color:"#c53030"}}>⚠ {lastError}</span>
          <button onClick={()=>setLastError("")} style={{background:"none",border:"none",cursor:"pointer",color:"#c53030",fontSize:16}}>×</button>
        </div>
      )}

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
              <div style={{fontSize:14,color:"#666",maxWidth:420,lineHeight:1.6}}>
                Ask me anything — tenant balances, available homes, leads, policies, work orders, inspections, or team updates.
              </div>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
              {SOURCES.map(s => React.createElement('div',{key:s.label,style:{padding:"3px 10px",borderRadius:20,background:s.bg,border:\`1px solid \${s.border}\`,fontSize:12,color:"#333"}},s.label))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2, minmax(0, 1fr))",gap:8,width:"100%",maxWidth:540}}>
              {SUGGESTIONS.map((s,i) => (
                <button key={i} className="chip" onClick={()=>send(s.text)}
                  style={{background:"white",border:"1px solid #f0f0f0",borderRadius:8,padding:"10px 12px",cursor:"pointer",textAlign:"left",fontSize:13,color:"#666",lineHeight:1.4,display:"flex",alignItems:"flex-start",gap:6,transition:"background 0.1s"}}>
                  <span style={{fontSize:14,flexShrink:0}}>{s.icon}</span>{s.text}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{maxWidth:680,width:"100%",margin:"0 auto"}}>
            {messages.map((m,i) => (
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
                {m.role==="assistant" && (
                  <div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0,marginRight:8,marginTop:2}}>🌿</div>
                )}
                <div style={{maxWidth:"78%",padding:"10px 14px",
                  borderRadius:m.role==="user"?"12px 12px 4px 12px":"12px 12px 12px 4px",
                  background:m.role==="user"?"#EAF3DE":"white",
                  border:\`1px solid \${m.role==="user"?"#97C459":"#f0f0f0"}\`,
                  color:m.role==="user"?"#173404":"#1a1a1a",
                  fontSize:14,lineHeight:1.6}}>
                  {m.role==="assistant" ? renderMd(m.content) : m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <div style={{width:28,height:28,borderRadius:"50%",background:"#EAF3DE",border:"1px solid #97C459",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,flexShrink:0}}>🌿</div>
                <div style={{padding:"10px 14px",background:"white",border:"1px solid #f0f0f0",borderRadius:"12px 12px 12px 4px"}}><Dots/></div>
              </div>
            )}
            <div ref={endRef}/>
          </div>
        )}
      </div>

      <div style={{padding:"12px 16px",background:"white",borderTop:"1px solid #f0f0f0",flexShrink:0}}>
        <div style={{maxWidth:680,margin:"0 auto",display:"flex",gap:8,alignItems:"flex-end"}}>
          <textarea ref={taRef} value={input}
            onChange={e=>{setInput(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";}}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();}}}
            placeholder="Ask about tenants, balances, leads, properties, policies, work orders, inspections..."
            rows={1}
            style={{flex:1,padding:"9px 12px",background:"#f9f9f7",border:"1px solid #e5e5e5",borderRadius:8,color:"#1a1a1a",fontSize:14,fontFamily:"inherit",resize:"none",lineHeight:1.5,minHeight:38,maxHeight:120}}
          />
          <button onClick={()=>send()} disabled={!input.trim()||loading}
            style={{width:38,height:38,borderRadius:8,
              background:input.trim()&&!loading?"#3B6D11":"#f0f0f0",
              border:"none",cursor:input.trim()&&!loading?"pointer":"default",
              color:input.trim()&&!loading?"white":"#aaa",
              fontSize:16,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>↑</button>
        </div>
        <div style={{textAlign:"center",fontSize:11,color:"#aaa",marginTop:6}}>
          Rentvine · Aptly · Notion · Slack · All data is live
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
app.listen(PORT, () => console.log(`Aloe Assistant running on port ${PORT}`));
