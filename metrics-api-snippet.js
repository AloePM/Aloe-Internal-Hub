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

// ── GET /api/metrics ────────────────────────────────────────────────────────
app.get('/api/metrics', async (req, res) => {
  try {
    const TMK = thisMonthKey();
    const now = new Date();

    // ── 1. Properties ────────────────────────────────────────────────────
    let allProps = [], pg = 1;
    while (pg <= 20) {
      const batch = await rvFetch('/properties/export', { pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allProps = allProps.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }

    const activeProps = allProps.filter(item => {
      const p = item.property || item;
      return p.isActive === '1' || p.isActive === 1 || p.isActive === true;
    });

    const propGainedMTD = activeProps.filter(item => {
      const p = item.property || item;
      return monthKey(p.dateTimeCreated || p.dateContractBegins) === TMK;
    }).length;

    const propGainedByMonth = buildMonthBuckets(12);
    activeProps.forEach(item => {
      const p = item.property || item;
      const k = monthKey(p.dateTimeCreated || p.dateContractBegins);
      if (k && propGainedByMonth[k] !== undefined) propGainedByMonth[k]++;
    });

    // ── 2. Leases ────────────────────────────────────────────────────────
    let allLeases = []; pg = 1;
    while (pg <= 20) {
      const batch = await rvFetch('/leases/export', { pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allLeases = allLeases.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }

    const activeLeases = allLeases.filter(item => {
      const l = item.lease || item;
      return parseInt(l.leaseStatusID || l.primaryLeaseStatusID) === 1 ||
             (l.status || '').toLowerCase() === 'active';
    });

    // Occupancy
    const occupiedUnitIDs = new Set(activeLeases.map(item => {
      const l = item.lease || item;
      return l.unitID;
    }).filter(Boolean));

    // Total units from properties/units export
    let allUnits = []; pg = 1;
    while (pg <= 10) {
      const batch = await rvFetch('/properties/units/export', { pageSize: 200, page: pg });
      if (!Array.isArray(batch) || batch.length === 0) break;
      allUnits = allUnits.concat(batch);
      if (batch.length < 200) break;
      pg++;
    }

    const totalUnits = allUnits.filter(item => {
      const u = item.unit || item;
      return u.isActive === '1' || u.isActive === 1 || u.isActive === true;
    }).length;

    const vacantUnits = totalUnits - occupiedUnitIDs.size;
    const occupancyRate = totalUnits > 0 ? +((occupiedUnitIDs.size / totalUnits) * 100).toFixed(1) : 0;

    // Avg rent from active leases
    const rents = activeLeases.map(item => {
      const l = item.lease || item;
      return parseFloat(l.rentAmount || l.rent || 0);
    }).filter(r => r > 0);
    const avgRent = rents.length ? Math.round(rents.reduce((a, b) => a + b, 0) / rents.length) : 0;
    const vacancyLoss = vacantUnits * avgRent;

    // Move-ins / outs / expirations by month
    const moveInsByMonth = buildMonthBuckets(12);
    const moveOutsByMonth = buildMonthBuckets(12);
    const expirationsByMonth = buildMonthBuckets(12);
    let moveInsMTD = 0, moveOutsMTD = 0;

    // Move-out reasons — from Rentvine (pull from move-outs or all leases with moveOutReason)
    const moveOutReasons = {};

    allLeases.forEach(item => {
      const l = item.lease || item;

      const mi = l.moveInDate || l.startDate;
      const mk = monthKey(mi);
      if (mk && moveInsByMonth[mk] !== undefined) moveInsByMonth[mk]++;
      if (mk === TMK) moveInsMTD++;

      const mo = l.moveOutDate || l.endDate;
      const mok = monthKey(mo);
      if (mok && moveOutsByMonth[mok] !== undefined) moveOutsByMonth[mok]++;
      if (mok === TMK) moveOutsMTD++;

      // Expirations (leases ending in future months)
      if (mo) {
        const moDate = new Date(mo);
        if (moDate >= now) {
          if (mok && expirationsByMonth[mok] !== undefined) expirationsByMonth[mok]++;
        }
      }

      // Move-out reason
      const reason = l.moveOutReason || l.vacateReason || l.reasonForVacating || '';
      if (reason && mok) {
        if (!moveOutReasons[reason]) moveOutReasons[reason] = 0;
        moveOutReasons[reason]++;
      }
    });

    // Upcoming expirations (next 90 days)
    const in90 = new Date(); in90.setDate(in90.getDate() + 90);
    const upcomingExpirations = activeLeases.filter(item => {
      const l = item.lease || item;
      const end = l.moveOutDate || l.endDate;
      if (!end) return false;
      const d = new Date(end);
      return d >= now && d <= in90;
    }).length;

    // Avg days to lease: from listing date to moveInDate
    // Use availabilityDate on units vs moveInDate on leases
    const daysToLeaseArr = [];
    allLeases.forEach(item => {
      const l = item.lease || item;
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

    // ── 3. Applications from Aptly ────────────────────────────────────────
    const appsSchema = await unitsFetch('/api/schema/MJxaStgENouWrNEKd');
    const appsSchemaMap = {};
    if (Array.isArray(appsSchema)) appsSchema.forEach(f => { appsSchemaMap[f.key] = f.label; });

    let allApps = []; let appPg = 0;
    while (appPg < 10) {
      const batch = await unitsFetch('/api/board/MJxaStgENouWrNEKd', { page: appPg, pageSize: 100 });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      allApps = allApps.concat(items);
      if (items.length < 100) break;
      appPg++;
    }

    const appsByMonth = buildMonthBuckets(12);
    const appsApprovedByMonth = buildMonthBuckets(12);
    const appsDeniedByMonth = buildMonthBuckets(12);
    const appsCancelledByMonth = buildMonthBuckets(12);
    let appsMTD = 0, appsApprovedMTD = 0, appsDeniedMTD = 0, appsCancelledMTD = 0;

    allApps.forEach(card => {
      const k = monthKey(card.createdAt);
      const stage = (card.stage || card.Stage || '').toLowerCase();

      if (k && appsByMonth[k] !== undefined) appsByMonth[k]++;
      if (k === TMK) appsMTD++;

      if (stage.includes('approved') || card.appApproved === true) {
        if (k && appsApprovedByMonth[k] !== undefined) appsApprovedByMonth[k]++;
        if (k === TMK) appsApprovedMTD++;
      } else if (stage.includes('denied') || stage.includes('reject')) {
        if (k && appsDeniedByMonth[k] !== undefined) appsDeniedByMonth[k]++;
        if (k === TMK) appsDeniedMTD++;
      } else if (stage.includes('cancel') || stage.includes('closed') || stage.includes('withdrawn')) {
        if (k && appsCancelledByMonth[k] !== undefined) appsCancelledByMonth[k]++;
        if (k === TMK) appsCancelledMTD++;
      }
    });

    // ── 4. Listings (Aptly Units board) ──────────────────────────────────
    const unitsCards = await getUnitsCards();
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
    // Count unique unit addresses with Keyless Deadbolt
    const keylessUnits = new Set();
    const leadsSchema = await unitsFetch('/api/schema/4EMDSYKirhQaNdQKz');
    let allLeadsRaw = []; let lPg = 0;
    while (lPg < 5) {
      const batch = await unitsFetch('/api/board/4EMDSYKirhQaNdQKz', { page: lPg, pageSize: 100, includeArchived: true });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      allLeadsRaw = allLeadsRaw.concat(items);
      if (items.length < 100) break;
      lPg++;
    }

    allLeadsRaw.forEach(card => {
      const lockboxType = card['Mirror Lockbox Type'] || card.mirrorLockboxType || '';
      if (/keyless deadbolt/i.test(lockboxType)) {
        const addr = card['Mirror Address'] || card['Preferred Rental'] || card.Unit || '';
        if (addr) keylessUnits.add(addr.split(',')[0].trim().toLowerCase());
      }
    });

    // Lead sources breakdown
    const leadSources = {};
    allLeadsRaw.forEach(card => {
      const src = card.Source || card['Lead Type'] || 'Unknown';
      if (src && src !== 'Unknown') {
        leadSources[src] = (leadSources[src] || 0) + 1;
      }
    });

    // New leads by month
    const newLeadsByMonth = buildMonthBuckets(12);
    allLeadsRaw.forEach(card => {
      const k = monthKey(card.createdAt || card['Created At']);
      if (k && newLeadsByMonth[k] !== undefined) newLeadsByMonth[k]++;
    });

    // ── 5. Owner Pipeline (PMA board) ────────────────────────────────────
    const pmaSchema = await unitsFetch('/api/schema/LDhqFFos8fsQLavv8');
    const pmaSchemaMap = {};
    if (Array.isArray(pmaSchema)) pmaSchema.forEach(f => { pmaSchemaMap[f.key] = f.label; });

    let allPMA = []; let pmaPg = 0;
    while (pmaPg < 10) {
      const batch = await unitsFetch('/api/board/LDhqFFos8fsQLavv8', { page: pmaPg, pageSize: 100, includeArchived: true });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      allPMA = allPMA.concat(items);
      if (items.length < 100) break;
      pmaPg++;
    }

    const pmaSignedByMonth = buildMonthBuckets(12);
    const newPipelineByMonth = buildMonthBuckets(12);
    let pmaSignedMTD = 0, newPipelineMTD = 0;

    allPMA.forEach(card => {
      const stage = (card.stage || '').toLowerCase();
      const k = monthKey(card.createdAt);

      if (k && newPipelineByMonth[k] !== undefined) newPipelineByMonth[k]++;
      if (k === TMK) newPipelineMTD++;

      if (stage.includes('signed') || stage.includes('won') || stage.includes('pma signed')) {
        const signedDate = card.updatedAt || card.createdAt;
        const sk = monthKey(signedDate);
        if (sk && pmaSignedByMonth[sk] !== undefined) pmaSignedByMonth[sk]++;
        if (sk === TMK) pmaSignedMTD++;
      }
    });

    // ── 6. Offboard / End Management — board ID: BaMiriNFDZBtWd5rR ─────────
    // Confirmed field structure from live data:
    // - card.Reason = plain string (the actual reason: "Selling with Another Agent" etc.)
    // - card.Stage  = pipeline stage ("New", "In Progress", "Complete" etc.)
    // - card.createdAt = ISO date when the offboard was initiated
    let allOffboard = []; let obPg = 0;
    while (obPg < 10) {
      const batch = await unitsFetch('/api/board/BaMiriNFDZBtWd5rR', { page: obPg, pageSize: 100, includeArchived: true });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      allOffboard = allOffboard.concat(items);
      if (items.length < 100) break;
      obPg++;
    }

    const endMgmtByMonth = buildMonthBuckets(12);
    const endMgmtReasons = {};
    let endMgmtMTD = 0;

    allOffboard.forEach(card => {
      const k = monthKey(card.createdAt);
      if (k && endMgmtByMonth[k] !== undefined) endMgmtByMonth[k]++;
      if (k === TMK) endMgmtMTD++;

      // Reason is the explicit "Reason" field on the card (confirmed from live data)
      const reason = card['Reason'] || card.Reason || '';
      if (reason) {
        endMgmtReasons[reason] = (endMgmtReasons[reason] || 0) + 1;
      }
    });

    // ── 7. Move-Outs Board (Comprehensive Inspections) ────────────────────
    let allMoveOuts = []; let moPg = 0;
    while (moPg < 10) {
      const batch = await unitsFetch('/api/board/YA3QWmPebvMwLwbB3', { page: moPg, pageSize: 100, includeArchived: true });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      allMoveOuts = allMoveOuts.concat(items);
      if (items.length < 100) break;
      moPg++;
    }

    let comprehensiveInspYes = 0, comprehensiveInspNo = 0;
    allMoveOuts.forEach(card => {
      // Confirmed from live Aptly data: field is "Comprehensive Inspection" (plain string)
      // Values seen: "Yes" — checking for Yes/No case-insensitively
      const val = String(card['Comprehensive Inspection'] || '').trim().toLowerCase();
      if (val === 'yes') comprehensiveInspYes++;
      else if (val === 'no') comprehensiveInspNo++;
    });

    // ── 8. Work Orders ────────────────────────────────────────────────────
    let allWOs = []; let woPg = 0;
    while (woPg <= 5) {
      const batch = await unitsFetch('/api/board/workOrder', { page: woPg, pageSize: 100, includeArchived: false });
      const items = Array.isArray(batch) ? batch : (batch && batch.data) || [];
      if (items.length === 0) break;
      const active = items.filter(c => !c.archived && !/closed|cancelled|complete/i.test(c.stage || ''));
      allWOs = allWOs.concat(active);
      if (items.length < 100) break;
      woPg++;
    }

    const woByStage = {};
    allWOs.forEach(c => {
      const s = c.stage || 'Unknown';
      woByStage[s] = (woByStage[s] || 0) + 1;
    });

    const unassignedWOs = allWOs.filter(c => {
      const v = Array.isArray(c.vendor) ? c.vendor : (c.vendor ? [c.vendor] : []);
      return v.length === 0;
    }).length;

    // ── 9. Property growth trend ──────────────────────────────────────────
    const propByMonth = buildMonthBuckets(12);
    // Derive a running total — use gained counts as proxy
    const propKeys = Object.keys(propByMonth).sort();
    let running = activeProps.length;
    const propTrend = propKeys.map(k => ({
      month: k,
      gained: propGainedByMonth[k] || 0,
      total: 0, // filled below
    }));
    // Calculate running total backwards
    for (let i = propTrend.length - 1; i >= 0; i--) {
      propTrend[i].total = running;
      running -= propTrend[i].gained;
      if (running < 0) running = 0;
    }

    // ── Build response ────────────────────────────────────────────────────
    const formatTrend = (obj) => Object.entries(obj).sort().map(([month, value]) => ({ month, value }));

    res.json({
      generatedAt: new Date().toISOString(),
      thisMonth: TMK,

      // Portfolio
      portfolio: {
        activeProperties: activeProps.length,
        totalUnits,
        occupiedUnits: occupiedUnitIDs.size,
        vacantUnits,
        occupancyRate,
        avgRent,
        vacancyLoss,
        gainedMTD: propGainedMTD,
        activeListings: publishedListings.length,
        listingsOver45Days: listings45,
        listingsOver90Days: listings90,
        keylessDeadboltUnits: keylessUnits.size,
        propGainedTrend: formatTrend(propGainedByMonth),
        propTrend,
      },

      // Leases / Occupancy
      leases: {
        active: activeLeases.length,
        moveInsMTD,
        moveOutsMTD,
        upcomingExpirations,
        avgDaysToLease,
        moveInsByMonth: formatTrend(moveInsByMonth),
        moveOutsByMonth: formatTrend(moveOutsByMonth),
        expirationsByMonth: formatTrend(expirationsByMonth),
        moveOutReasons: Object.entries(moveOutReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => ({ reason, count })),
      },

      // Applications
      applications: {
        totalMTD: appsMTD,
        approvedMTD: appsApprovedMTD,
        deniedMTD: appsDeniedMTD,
        cancelledMTD: appsCancelledMTD,
        byMonth: formatTrend(appsByMonth),
        approvedByMonth: formatTrend(appsApprovedByMonth),
        deniedByMonth: formatTrend(appsDeniedByMonth),
        cancelledByMonth: formatTrend(appsCancelledByMonth),
      },

      // Owner Pipeline
      pipeline: {
        signedMTD: pmaSignedMTD,
        newLeadsMTD: newPipelineMTD,
        signedByMonth: formatTrend(pmaSignedByMonth),
        newLeadsByMonth: formatTrend(newLeadsByMonth),
        leadSources: Object.entries(leadSources)
          .sort((a, b) => b[1] - a[1])
          .map(([source, count]) => ({ source, count })),
      },

      // End Management
      endManagement: {
        totalMTD: endMgmtMTD,
        byMonth: formatTrend(endMgmtByMonth),
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
    });

  } catch (err) {
    console.error('Metrics API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/metrics/debug ──────────────────────────────────────────────────
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
    const pmaSample = await unitsFetch('/api/board/LDhqFFos8fsQLavv8', { page: 0, pageSize: 3 });
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
        id: 'LDhqFFos8fsQLavv8',
        stages: pmaItems.map(c => c.stage),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
