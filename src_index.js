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

    const allowed = ['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'];
    if (!allowed.includes(fuel)) {
      return json({ error: 'Unsupported fuel type.' }, 400);
    }

    // FuelCosts expects radius in miles.
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

      const rows = extractRows(body);
      const stations = rows
        .map((s) => normalizeStation(s, fuel))
        .filter(Boolean)
        .sort((a, b) => a.pricePpl - b.pricePpl || (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));

      const result = {
        ok: true,
        fuel,
        searchedFrom: { latitude: lat, longitude: lon },
        radiusKm,
        count: stations.length,
        stations,
        generatedAt: new Date().toISOString(),
        source: 'FuelCosts.co.uk, sourced from UK Government Fuel Finder',
        sourceUpdatedEvery: 'approximately 4 minutes',
      };

      // Temporary diagnostic information if the upstream shape changes.
      // This lets us fix the mapping without exposing the upstream payload.
      if (stations.length === 0) {
        result.debug = {
          upstreamType: Array.isArray(body) ? 'array' : typeof body,
          topLevelKeys: body && typeof body === 'object' && !Array.isArray(body)
            ? Object.keys(body).slice(0, 30)
            : [],
          rowCount: rows.length,
          firstRowKeys: rows[0] && typeof rows[0] === 'object'
            ? Object.keys(rows[0]).slice(0, 50)
            : [],
        };
      }

      return json(result);
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : 'Upstream request failed.',
      }, 502);
    }
  },
};

function extractRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];

  const candidates = [
    body.stations,
    body.results,
    body.items,
    body.data,
    body.rows,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && Array.isArray(candidate.items)) return candidate.items;
    if (candidate && Array.isArray(candidate.stations)) return candidate.stations;
  }

  return [];
}

function normalizeStation(s, requestedFuel) {
  if (!s || typeof s !== 'object') return null;

  const location = s.location && typeof s.location === 'object' ? s.location : {};
  const prices = [
    ...(Array.isArray(s.fuelPrices) ? s.fuelPrices : []),
    ...(Array.isArray(s.fuel_prices) ? s.fuel_prices : []),
    ...(Array.isArray(s.prices) ? s.prices : []),
  ];

  const matchingPrice = prices.find((p) => {
    const type = String(
      p?.fuelType ?? p?.fuel_type ?? p?.type ?? p?.fuel ?? ''
    ).toUpperCase();
    return type === requestedFuel;
  }) || prices[0];

  const price = Number(
    s.pricePpl ?? s.price_ppl ?? s.price ??
    s.fuelPrice ?? s.fuel_price ?? s.currentPrice ?? s.current_price ??
    matchingPrice?.pricePpl ?? matchingPrice?.price_ppl ??
    matchingPrice?.price ?? matchingPrice?.currentPrice
  );

  const lat = Number(
    s.latitude ?? s.lat ?? location.latitude ?? location.lat
  );
  const lon = Number(
    s.longitude ?? s.lon ?? s.lng ?? location.longitude ?? location.lon ?? location.lng
  );

  const distanceMilesRaw =
    s.distanceMiles ?? s.distance_miles ?? s.distance ?? s.miles ??
    s.distanceInMiles ?? s.distance_miles_from_search;

  const distanceMiles = Number(distanceMilesRaw);

  if (!Number.isFinite(price) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const name =
    s.tradingName ?? s.trading_name ?? s.stationName ?? s.station_name ??
    s.name ?? s.brandName ?? s.brand_name ?? s.brand ?? 'Fuel station';

  const brand =
    s.brandName ?? s.brand_name ?? s.brand ?? s.organisation ?? s.organization ?? '';

  const address =
    s.address ?? location.address ?? location.addressLine1 ?? location.address_line_1 ?? '';

  return {
    nodeId: s.nodeId ?? s.node_id ?? s.id ?? null,
    name: String(name),
    brand: String(brand),
    fuelType: String(
      s.fuelType ?? s.fuel_type ?? matchingPrice?.fuelType ??
      matchingPrice?.fuel_type ?? requestedFuel
    ).toUpperCase(),
    pricePpl: price,
    priceLastUpdated:
      s.priceLastUpdated ?? s.price_last_updated ??
      matchingPrice?.priceLastUpdated ?? matchingPrice?.price_last_updated ??
      s.updatedAt ?? s.updated_at ?? null,
    distanceMiles: Number.isFinite(distanceMiles) ? round(distanceMiles, 2) : null,
    distanceKm: Number.isFinite(distanceMiles) ? round(distanceMiles * 1.609344, 2) : null,
    location: {
      latitude: lat,
      longitude: lon,
      addressLine1: String(address || ''),
      addressLine2: String(s.addressLine2 ?? s.address_line_2 ?? location.addressLine2 ?? location.address_line_2 ?? ''),
      city: String(s.city ?? location.city ?? ''),
      county: String(s.county ?? location.county ?? ''),
      postcode: String(s.postcode ?? s.post_code ?? location.postcode ?? location.post_code ?? ''),
    },
    motorwayServiceStation: Boolean(
      s.motorwayServiceStation ?? s.is_motorway_service_station ??
      s.motorway ?? false
    ),
    supermarketServiceStation: Boolean(
      s.supermarketServiceStation ?? s.is_supermarket_service_station ??
      s.supermarket ?? false
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
