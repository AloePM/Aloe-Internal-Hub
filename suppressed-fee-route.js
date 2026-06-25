// ── Suppressed Fee Balance & Unbilled Analysis ──────────────────────────────
// Fetches GL data for all 14 suppressed fee accounts from Rentvine,
// aggregates credit/debit by property+month, surfaces mismatches and
// unbilled months (income received but no payout bill before 2 months ago).

const SUPPRESSED_ACCOUNTS = [
  { id: 93,  label: '6111: Management Fees' },
  { id: 94,  label: '6112: Commissions/Placement Fees' },
  { id: 40,  label: '4405: Resident Benefit Package' },
  { id: 58,  label: '4473: Administrative Fee' },
  { id: 51,  label: '4445: MGMT Pet Fee Not Refundable' },
  { id: 14,  label: '4500: Late Fee' },
  { id: 148, label: '4405-2: SN-Resident Benefit Package' },
  { id: 136, label: '4473-2: Owner Administrative Charge' },
  { id: 90,  label: '6101: Legal' },
  { id: 57,  label: '4472: Five Day Notice' },
  { id: 12,  label: '4410: Dishonored Funds Charge' },
  { id: 62,  label: '4476: Lease Break Fee' },
  { id: 56,  label: '4471: Transaction Fee' },
  { id: 19,  label: '6600: Vendor Markup Expense' },
];

function parseAmt(v) {
  if (!v && v !== 0) return 0;
  return parseFloat(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

function monthKey(dateStr) {
  if (!dateStr) return '0000-00';
  const d = new Date(dateStr);
  if (isNaN(d)) return '0000-00';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function fetchGLForAccount(accountId, rvBase, rvAuth, rvAccount) {
  const reportJson = {
    displayColumns: ['datePosted', 'propertyName', 'description', 'type', 'debit', 'credit'],
    filters: [
      { name: 'account', comparator: 'in', values: [accountId] },
      { name: 'isSuppressed', comparator: 'booleanTrue' },
      { name: 'datePosted', comparator: 'allTime' },
      { name: 'includeVoided', comparator: 'booleanFalse' },
    ],
  };
  const url = `${rvBase}/reports/general-ledger?exportTypeID=1&json=${encodeURIComponent(JSON.stringify(reportJson))}&orientation=2&showHeader=true`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${rvAuth}`,
      'X-Rentvine-Account': rvAccount,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GL fetch failed for account ${accountId}: HTTP ${res.status} — ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.rows || data.data || data.results || []);
}

function buildAnalysis(allAccountData, unbilledCutoffDate) {
  // Per-account, per-property, per-month: {credit, debit}
  const acctPropMonth = {}; // accountId -> prop -> month -> {credit, debit}

  SUPPRESSED_ACCOUNTS.forEach(acct => {
    acctPropMonth[acct.id] = {};
    const rows = allAccountData[acct.id] || [];
    rows.forEach(r => {
      const prop = r.propertyName || r['Property Code'] || 'Unknown';
      const month = monthKey(r.datePosted || r['Date Posted']);
      const cr = parseAmt(r.credit || r.Credit);
      const dr = parseAmt(r.debit || r.Debit);
      if (!acctPropMonth[acct.id][prop]) acctPropMonth[acct.id][prop] = {};
      if (!acctPropMonth[acct.id][prop][month]) acctPropMonth[acct.id][prop][month] = { credit: 0, debit: 0 };
      acctPropMonth[acct.id][prop][month].credit += cr;
      acctPropMonth[acct.id][prop][month].debit += dr;
    });
  });

  const mismatches = [];
  const unbilled = [];
  const byAccount = [];
  const byProperty = {};

  SUPPRESSED_ACCOUNTS.forEach(acct => {
    let acctTotalCredit = 0, acctTotalDebit = 0;
    let acctUnbilledMonths = 0, acctPropsWithIssues = new Set();

    Object.entries(acctPropMonth[acct.id] || {}).forEach(([prop, months]) => {
      let propCredit = 0, propDebit = 0;
      const propUnbilledMonths = [];

      Object.entries(months).forEach(([month, vals]) => {
        propCredit += vals.credit;
        propDebit += vals.debit;

        // Unbilled: has income (credit > 0) but no payout (debit == 0) in that month,
        // and the month is on or before the cutoff (2 months before today).
        const monthDate = new Date(month + '-01');
        if (vals.credit > 0.005 && vals.debit < 0.005 && monthDate <= unbilledCutoffDate) {
          propUnbilledMonths.push({ month, credit: +vals.credit.toFixed(2) });
        }
      });

      acctTotalCredit += propCredit;
      acctTotalDebit += propDebit;

      const diff = +(propCredit - propDebit).toFixed(2);

      if (Math.abs(diff) > 0.005) {
        mismatches.push({
          prop,
          accountId: acct.id,
          accountLabel: acct.label,
          credit: +propCredit.toFixed(2),
          debit: +propDebit.toFixed(2),
          diff,
          status: diff < 0 ? 'overpaid' : 'under-disbursed',
        });
        acctPropsWithIssues.add(prop);
      }

      if (propUnbilledMonths.length > 0) {
        const unbilledAmt = +propUnbilledMonths.reduce((s, m) => s + m.credit, 0).toFixed(2);
        unbilled.push({
          prop,
          accountId: acct.id,
          accountLabel: acct.label,
          totalCredit: +propCredit.toFixed(2),
          unbilledMonths: propUnbilledMonths,
          unbilledAmt,
        });
        acctPropsWithIssues.add(prop);
        acctUnbilledMonths += propUnbilledMonths.length;
      }

      // Roll up to by-property
      if (!byProperty[prop]) byProperty[prop] = { credit: 0, debit: 0, unbilledAmt: 0, issues: new Set() };
      byProperty[prop].credit += propCredit;
      byProperty[prop].debit += propDebit;
      if (propUnbilledMonths.length > 0) {
        byProperty[prop].unbilledAmt += propUnbilledMonths.reduce((s, m) => s + m.credit, 0);
        byProperty[prop].issues.add('unbilled');
      }
      if (Math.abs(diff) > 0.005) byProperty[prop].issues.add('mismatch');
    });

    byAccount.push({
      accountId: acct.id,
      accountLabel: acct.label,
      totalCredit: +acctTotalCredit.toFixed(2),
      totalDebit: +acctTotalDebit.toFixed(2),
      net: +(acctTotalCredit - acctTotalDebit).toFixed(2),
      unbilledMonthCount: acctUnbilledMonths,
      propsWithIssues: acctPropsWithIssues.size,
    });
  });

  // Summarize by-property
  const byPropertyArr = Object.entries(byProperty).map(([prop, v]) => ({
    prop,
    credit: +v.credit.toFixed(2),
    debit: +v.debit.toFixed(2),
    balance: +(v.credit - v.debit).toFixed(2),
    unbilledAmt: +v.unbilledAmt.toFixed(2),
    issues: Array.from(v.issues),
  }));

  // Portfolio totals
  const totalCredit = +byAccount.reduce((s, a) => s + a.totalCredit, 0).toFixed(2);
  const totalDebit = +byAccount.reduce((s, a) => s + a.totalDebit, 0).toFixed(2);
  const totalUnbilled = +unbilled.reduce((s, u) => s + u.unbilledAmt, 0).toFixed(2);
  const overpaidCount = mismatches.filter(m => m.status === 'overpaid').length;
  const totalUnbilledMonthInstances = unbilled.reduce((s, u) => s + u.unbilledMonths.length, 0);

  return {
    summary: {
      totalCredit,
      totalDebit,
      netBalance: +(totalCredit - totalDebit).toFixed(2),
      totalUnbilledIncome: totalUnbilled,
      overpaidInstances: overpaidCount,
      totalUnbilledMonthInstances,
      mismatchCount: mismatches.length,
      unbilledPropAccountCombos: unbilled.length,
    },
    mismatches: mismatches.sort((a, b) => a.diff - b.diff),
    unbilled: unbilled.sort((a, b) => b.unbilledAmt - a.unbilledAmt),
    byAccount,
    byProperty: byPropertyArr.sort((a, b) => b.issues.length - a.issues.length || b.unbilledAmt - a.unbilledAmt),
    generatedAt: new Date().toISOString(),
    unbilledCutoff: unbilledCutoffDate.toISOString().slice(0, 10),
  };
}

module.exports = function registerSuppressedFeeRoutes(app, rvBase, rvAuth, rvAccount) {
  // Cache: reuse results for 15 minutes to avoid hammering Rentvine on refresh
  let cache = null;
  let cacheAt = 0;
  const CACHE_TTL = 15 * 60 * 1000;

  app.get('/api/suppressed-fee-analysis', async (req, res) => {
    const force = req.query.refresh === '1';
    if (!force && cache && Date.now() - cacheAt < CACHE_TTL) {
      return res.json({ ...cache, cached: true, cachedAt: new Date(cacheAt).toISOString() });
    }

    // Unbilled cutoff = first day of the month 2 months before today
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    // End of that month
    const cutoffEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0);

    try {
      // Fetch all accounts — batched 3 at a time to stay under Rentvine rate limits
      const allAccountData = {};
      const batchSize = 3;
      for (let i = 0; i < SUPPRESSED_ACCOUNTS.length; i += batchSize) {
        const batch = SUPPRESSED_ACCOUNTS.slice(i, i + batchSize);
        await Promise.all(
          batch.map(async acct => {
            allAccountData[acct.id] = await fetchGLForAccount(acct.id, rvBase, rvAuth, rvAccount);
          })
        );
      }

      const result = buildAnalysis(allAccountData, cutoffEnd);
      cache = result;
      cacheAt = Date.now();
      res.json({ ...result, cached: false });
    } catch (err) {
      console.error('Suppressed fee analysis error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Serve the UI page
  app.get('/suppressed-fees', (req, res) => {
    res.sendFile('suppressed-fees.html', { root: __dirname });
  });
};
