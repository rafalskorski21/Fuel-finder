const FUELCOSTS_API = 'https://fuelcosts.co.uk/api/stations';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({
        ok: true,
        service: 'Fuel Finder live backend',
        dataSource: 'FuelCosts.co.uk / UK Government Fuel Finder',
      });
    }

    if (url.pathname !== '/api/stations') {
      return json({ error: 'Not found' }, 404);
    }

    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const fuel = normalizeFuel(url.searchParams.get('fuel') || 'E10');
    const radiusKm = clamp(Number(url.searchParams.get('radiusKm') || 10), 1, 50);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        lat < 49 || lat > 61 || lon < -9 || lon > 3) {
      return json({ error: 'Valid UK latitude and longitude are required.' }, 400);
    }

    if (!['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'].includes(fuel)) {
      return json({ error: 'Unsupported fuel type.' }, 400);
    }

    // FuelCosts uses miles for radius/distance.
    const radiusMiles = Math.max(0.62, radiusKm * 0.621371);

    const upstreamUrl = new URL(FUELCOSTS_API);
    upstreamUrl.searchParams.set('lat', String(lat));
    upstreamUrl.searchParams.set('lon', String(lon));
    upstreamUrl.searchParams.set('radius', String(radiusMiles));
    upstreamUrl.searchParams.set('fuel', fuel);
    upstreamUrl.searchParams.set('sort', 'price');
    upstreamUrl.searchParams.set('page', '1');
    upstreamUrl.searchParams.set('perPage', '50');

    try {
      const response = await fetch(upstreamUrl.toString(), {
        headers: { Accept: 'application/json' },
        cf: { cacheTtl: 120, cacheEverything: true },
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        return json({
          ok: false,
          error: body?.error || `Fuel price service returned ${response.status}.`,
        }, 502);
      }

      const rows = Array.isArray(body)
        ? body
        : (Array.isArray(body?.stations) ? body.stations : []);

      const stations = rows
        .map((s) => normalizeStation(s, fuel))
        .filter(Boolean)
        .sort((a, b) => a.pricePpl - b.pricePpl || a.distanceMiles - b.distanceMiles);

      return json({
        ok: true,
        fuel,
        searchedFrom: { latitude: lat, longitude: lon },
        radiusKm,
        count: stations.length,
        stations,
        generatedAt: new Date().toISOString(),
        source: 'FuelCosts.co.uk, sourced from UK Government Fuel Finder',
        sourceUpdatedEvery: 'approximately 4 minutes',
      });
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : 'Upstream request failed.',
      }, 502);
    }
  },
};

function normalizeStation(s, requestedFuel) {
  if (!s || typeof s !== 'object') return null;

  const price = Number(
    s.pricePpl ?? s.price ?? s.fuelPrice ?? s.currentPrice
  );
  const lat = Number(s.latitude ?? s.location?.latitude);
  const lon = Number(s.longitude ?? s.location?.longitude);
  const distanceMiles = Number(
    s.distanceMiles ?? s.distance ?? s.distance_miles
  );

  if (!Number.isFinite(price) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const name = s.tradingName || s.trading_name || s.name || s.brand || 'Fuel station';
  const brand = s.brandName || s.brand_name || s.brand || '';

  return {
    nodeId: s.nodeId || s.node_id || null,
    name,
    brand,
    fuelType: s.fuelType || s.fuel_type || requestedFuel,
    pricePpl: price,
    priceLastUpdated: s.priceLastUpdated || s.price_last_updated || s.updatedAt || null,
    distanceMiles: Number.isFinite(distanceMiles) ? round(distanceMiles, 2) : null,
    distanceKm: Number.isFinite(distanceMiles) ? round(distanceMiles * 1.609344, 2) : null,
    location: {
      latitude: lat,
      longitude: lon,
      addressLine1: s.addressLine1 || s.address_line_1 || s.address || '',
      addressLine2: s.addressLine2 || s.address_line_2 || '',
      city: s.city || '',
      county: s.county || '',
      postcode: s.postcode || s.post_code || '',
    },
    motorwayServiceStation: Boolean(
      s.motorwayServiceStation ?? s.is_motorway_service_station
    ),
    supermarketServiceStation: Boolean(
      s.supermarketServiceStation ?? s.is_supermarket_service_station
    ),
  };
}

function normalizeFuel(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'DIESEL' || v === 'B7') return 'B7_STANDARD';
  if (v === 'PREMIUM DIESEL' || v === 'B7P') return 'B7_PREMIUM';
  return v;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function round(n, places) {
  const p = 10 ** places;
  return Math.round(n * p) / p;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
