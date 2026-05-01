// =============================================================================
// APIFY COMPS INTEGRATION — add this block to server.js
// Paste after the existing /api/aptly/units route
// Requires env var: APIFY_API_KEY
// =============================================================================

const APIFY_TOKEN = process.env.APIFY_API_KEY || '';
const COMPS_CACHE = {};           // in-memory cache
const COMPS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Apify actor runner ────────────────────────────────────────────────────────
async function runApifyActor(actorId, input, timeoutSecs = 90) {
  if (!APIFY_TOKEN) return { error: 'APIFY_API_KEY not configured' };
  try {
    // Start the actor run
    const startRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeoutSecs}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    if (!startRes.ok) {
      const txt = await startRes.text();
      return { error: `Apify HTTP ${startRes.status}: ${txt.slice(0, 200)}` };
    }
    return await startRes.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ── Comp normalizer — unifies data from different actors ──────────────────────
function normalizeComps(items, type) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    address:     item.address || item.streetAddress || item.location?.streetAddress || '',
    city:        item.city    || item.location?.city || '',
    state:       item.state   || item.location?.state || 'AZ',
    zip:         item.zipCode || item.postalCode || '',
    price:       parseFloat(item.price || item.listPrice || item.rentZestimate || item.rent || 0),
    beds:        item.bedrooms || item.beds || item.bedroomCount || '',
    baths:       item.bathrooms || item.baths || item.bathroomCount || '',
    sqft:        item.livingArea || item.sqft || item.livingAreaSqFt || 0,
    pricePerSqft: item.pricePerSquareFoot || (item.price && item.livingArea ? Math.round(item.price / item.livingArea) : 0),
    zestimate:   item.zestimate || item.zestimateLow || 0,
    redfin_estimate: item.redfinEstimate || 0,
    daysOnMarket: item.daysOnMarket || item.dom || 0,
    status:      item.homeStatus || item.status || item.listingStatus || '',
    listingUrl:  item.url || item.detailUrl || item.hdpUrl || '',
    photos:      Array.isArray(item.photos) ? item.photos.slice(0, 3) : [],
    source:      item._source || (item.zestimate ? 'zillow' : item.redfinEstimate ? 'redfin' : 'realtor'),
    type,        // 'rent' or 'sale'
    listedDate:  item.listedDate || item.datePosted || '',
  })).filter(c => c.price > 0);
}

// ── Stats calculator ──────────────────────────────────────────────────────────
function calcStats(comps) {
  if (!comps.length) return null;
  const prices = comps.map(c => c.price).filter(Boolean).sort((a, b) => a - b);
  const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
  const median = prices[Math.floor(prices.length / 2)];
  const p25 = prices[Math.floor(prices.length * 0.25)];
  const p75 = prices[Math.floor(prices.length * 0.75)];
  const sqftPrices = comps.map(c => c.pricePerSqft).filter(Boolean);
  const avgPsf = sqftPrices.length ? Math.round(sqftPrices.reduce((s, p) => s + p, 0) / sqftPrices.length) : 0;
  const avgDom = comps.map(c => c.daysOnMarket).filter(Boolean);
  return {
    count: prices.length,
    min: Math.round(prices[0]),
    max: Math.round(prices[prices.length - 1]),
    avg: Math.round(avg),
    median: Math.round(median),
    p25: Math.round(p25),
    p75: Math.round(p75),
    avgPricePerSqft: avgPsf,
    avgDaysOnMarket: avgDom.length ? Math.round(avgDom.reduce((s, d) => s + d, 0) / avgDom.length) : null,
  };
}

// ── /api/comps — main comps endpoint ─────────────────────────────────────────
app.get('/api/comps', async function(req, res) {
  const { address, city, state = 'AZ', beds, type = 'rent' } = req.query;
  if (!address || !city) return res.status(400).json({ error: 'address and city required' });
  if (!APIFY_TOKEN) return res.status(503).json({ error: 'APIFY_API_KEY not configured — add it to Render environment variables' });

  const cacheKey = [address, city, state, beds, type].join('|').toLowerCase();
  const cached = COMPS_CACHE[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < COMPS_CACHE_TTL) {
    console.log('[Apify] Cache hit for:', address);
    return res.json({ ...cached.data, fromCache: true, cachedAt: new Date(cached.fetchedAt).toISOString() });
  }

  const fullAddress = `${address}, ${city}, ${state}`;
  console.log(`[Apify] Fetching ${type} comps for: ${fullAddress} ${beds}bd`);

  try {
    let rentalComps = [], saleComps = [], zestimate = null, redfin = null;

    if (type === 'rent' || type === 'both') {
      // Multi-source rental aggregator — Zillow + Redfin + Apartments.com rentals
      const rentalInput = {
        searchQuery: fullAddress,
        listingType: 'FOR_RENT',
        maxItems: 25,
        ...(beds ? { bedsMin: parseInt(beds), bedsMax: parseInt(beds) + 1 } : {}),
      };
      const rentalRaw = await runApifyActor('alizarin_refrigerator-owner~real-estate-aggregator', rentalInput, 90);
      if (!rentalRaw.error) {
        rentalComps = normalizeComps(Array.isArray(rentalRaw) ? rentalRaw : (rentalRaw.items || []), 'rent');
      }

      // Zillow scraper for Zestimate rental estimate on the subject property
      const zillowInput = {
        searchUrls: [`https://www.zillow.com/homes/${encodeURIComponent(fullAddress)}_rb/`],
        maxItems: 1,
      };
      const zillowRaw = await runApifyActor('maxcopell~zillow-scraper', zillowInput, 60);
      if (!zillowRaw.error && Array.isArray(zillowRaw) && zillowRaw[0]) {
        zestimate = zillowRaw[0].rentZestimate || zillowRaw[0].zestimate || null;
        redfin = zillowRaw[0].redfinEstimate || null;
      }
    }

    if (type === 'sale' || type === 'both') {
      // Multi-source sale comps
      const saleInput = {
        searchQuery: fullAddress,
        listingType: 'FOR_SALE',
        maxItems: 25,
        ...(beds ? { bedsMin: parseInt(beds), bedsMax: parseInt(beds) + 1 } : {}),
      };
      const saleRaw = await runApifyActor('alizarin_refrigerator-owner~real-estate-aggregator', saleInput, 90);
      if (!saleRaw.error) {
        saleComps = normalizeComps(Array.isArray(saleRaw) ? saleRaw : (saleRaw.items || []), 'sale');
      }

      // Zillow for sale Zestimate
      if (!zestimate) {
        const zillowInput = {
          searchUrls: [`https://www.zillow.com/homes/${encodeURIComponent(fullAddress)}_rb/`],
          maxItems: 1,
        };
        const zillowRaw = await runApifyActor('maxcopell~zillow-scraper', zillowInput, 60);
        if (!zillowRaw.error && Array.isArray(zillowRaw) && zillowRaw[0]) {
          zestimate = zillowRaw[0].zestimate || null;
          redfin = zillowRaw[0].redfinEstimate || null;
        }
      }
    }

    const result = {
      subject: { address: fullAddress, beds: beds || null, type },
      zestimate,
      redfin_estimate: redfin,
      rental: {
        comps: rentalComps,
        stats: calcStats(rentalComps),
      },
      sale: {
        comps: saleComps,
        stats: calcStats(saleComps),
      },
      fetchedAt: new Date().toISOString(),
      fromCache: false,
    };

    // Cache it
    COMPS_CACHE[cacheKey] = { data: result, fetchedAt: Date.now() };
    res.json(result);
  } catch (e) {
    console.error('[Apify] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /api/comps/cache — view and clear cache ───────────────────────────────────
app.get('/api/comps/cache', function(req, res) {
  const entries = Object.entries(COMPS_CACHE).map(([key, val]) => ({
    key,
    cachedAt: new Date(val.fetchedAt).toISOString(),
    ageHours: Math.round((Date.now() - val.fetchedAt) / 3600000),
    rentalComps: val.data.rental?.comps?.length || 0,
    saleComps: val.data.sale?.comps?.length || 0,
  }));
  res.json({ total: entries.length, entries });
});

app.delete('/api/comps/cache', function(req, res) {
  const count = Object.keys(COMPS_CACHE).length;
  Object.keys(COMPS_CACHE).forEach(k => delete COMPS_CACHE[k]);
  res.json({ cleared: count });
});

// ── /api/comps/market — city-level market summary ─────────────────────────────
app.get('/api/comps/market', async function(req, res) {
  const { city, state = 'AZ', beds, type = 'rent' } = req.query;
  if (!city) return res.status(400).json({ error: 'city required' });
  if (!APIFY_TOKEN) return res.status(503).json({ error: 'APIFY_API_KEY not configured' });

  const cacheKey = `market|${city}|${state}|${beds||'all'}|${type}`;
  const cached = COMPS_CACHE[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < COMPS_CACHE_TTL) {
    return res.json({ ...cached.data, fromCache: true });
  }

  try {
    const input = {
      searchQuery: `${city}, ${state}`,
      listingType: type === 'sale' ? 'FOR_SALE' : 'FOR_RENT',
      maxItems: 50,
      ...(beds ? { bedsMin: parseInt(beds), bedsMax: parseInt(beds) } : {}),
    };
    const raw = await runApifyActor('alizarin_refrigerator-owner~real-estate-aggregator', input, 120);
    const comps = normalizeComps(Array.isArray(raw) ? raw : (raw.items || []), type);

    // Break down by beds
    const byBeds = {};
    comps.forEach(c => {
      const b = String(c.beds || 'unknown');
      if (!byBeds[b]) byBeds[b] = [];
      byBeds[b].push(c);
    });
    const byBedsStats = {};
    Object.entries(byBeds).forEach(([b, cs]) => { byBedsStats[b] = calcStats(cs); });

    const result = {
      city, state, type,
      totalListings: comps.length,
      overall: calcStats(comps),
      byBeds: byBedsStats,
      fetchedAt: new Date().toISOString(),
    };

    COMPS_CACHE[cacheKey] = { data: result, fetchedAt: Date.now() };
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
