const API_BASE = 'https://www.fuel-finder.service.gov.uk';
const TOKEN_URL = `${API_BASE}/api/v1/oauth/generate_access_token`;
const CACHE_TTL_SECONDS = 15 * 60;
const STATION_CACHE_TTL = 60 * 60;
const MAX_RADIUS_KM = 50;
const DEFAULT_RADIUS_KM = 10;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'Fuel Finder live backend' });
    }

    if (url.pathname !== '/api/stations') {
      return json({ error: 'Not found' }, 404);
    }

    const lat = Number(url.searchParams.get('lat'));
    const lon = Number(url.searchParams.get('lon'));
    const fuel = normalizeFuel(url.searchParams.get('fuel') || 'E10');
    const radiusKm = Math.min(Math.max(Number(url.searchParams.get('radiusKm') || DEFAULT_RADIUS_KM), 1), MAX_RADIUS_KM);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 49 || lat > 61 || lon < -9 || lon > 3) {
      return json({ error: 'Valid UK latitude and longitude are required.' }, 400);
    }

    if (!['E10', 'E5', 'B7_STANDARD', 'B7_PREMIUM', 'B10', 'HVO'].includes(fuel)) {
      return json({ error: 'Unsupported fuel type.' }, 400);
    }

    try {
      const token = await getToken(env);
      // The Fuel Finder service permits only one in-flight information-recipient request
      // per client, so deliberately fetch these datasets sequentially.
      const stations = await getAllBatches('/api/v1/pfs', token, 'stations', STATION_CACHE_TTL);
      const prices = await getAllBatches('/api/v1/pfs/fuel-prices', token, 'prices', CACHE_TTL_SECONDS);

      const priceByNode = new Map();
      for (const item of prices) {
        if (!item?.node_id) continue;
        const match = Array.isArray(item.fuel_prices)
          ? item.fuel_prices.find(p => normalizeFuel(p?.fuel_type) === fuel && p?.price != null)
          : null;
        if (match) priceByNode.set(item.node_id, match);
      }

      const results = [];
      for (const station of stations) {
        if (!station?.node_id || station.temporary_closure || station.permanent_closure) continue;
        const loc = station.location || {};
        const sLat = Number(loc.latitude);
        const sLon = Number(loc.longitude);
        if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

        const distanceKm = haversineKm(lat, lon, sLat, sLon);
        if (distanceKm > radiusKm) continue;

        const price = priceByNode.get(station.node_id);
        if (!price) continue;
        const ppl = normalizePrice(price.price);
        if (!Number.isFinite(ppl)) continue;

        results.push({
          nodeId: station.node_id,
          name: station.trading_name || station.brand_name || 'Fuel station',
          brand: station.brand_name || station.trading_name || '',
          fuelType: fuel,
          pricePpl: ppl,
          priceLastUpdated: price.price_last_updated || null,
          distanceKm: round(distanceKm, 2),
          distanceMiles: round(distanceKm * 0.621371, 2),
          location: {
            latitude: sLat,
            longitude: sLon,
            addressLine1: loc.address_line_1 || '',
            addressLine2: loc.address_line_2 || '',
            city: loc.city || '',
            county: loc.county || '',
            postcode: loc.postcode || '',
          },
          motorwayServiceStation: !!station.is_motorway_service_station,
          supermarketServiceStation: !!station.is_supermarket_service_station,
        });
      }

      results.sort((a, b) => a.pricePpl - b.pricePpl || a.distanceKm - b.distanceKm);

      return json({
        ok: true,
        fuel,
        searchedFrom: { latitude: lat, longitude: lon },
        radiusKm,
        count: results.length,
        stations: results.slice(0, 50),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : 'Upstream API error' }, 502);
    }
  },
};

async function getToken(env) {
  if (!env.FUEL_FINDER_CLIENT_ID || !env.FUEL_FINDER_CLIENT_SECRET) {
    throw new Error('Fuel Finder API secrets are not configured in Cloudflare.');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.FUEL_FINDER_CLIENT_ID,
      client_secret: env.FUEL_FINDER_CLIENT_SECRET,
      scope: 'fuelfinder.read',
    }),
  });

  const body = await safeJson(res);
  if (!res.ok) throw new Error(`Fuel Finder token request failed (${res.status}).`);
  const token = body?.data?.access_token || body?.access_token;
  if (!token) throw new Error('Fuel Finder token response did not contain an access token.');
  return token;
}

async function getAllBatches(path, token, cachePrefix, ttlSeconds) {
  const all = [];
  for (let batch = 1; batch <= 50; batch++) {
    const cacheKey = new Request(`https://cache.fuelfinder.local/${cachePrefix}/${batch}`);
    let response = await caches.default.match(cacheKey);

    if (!response) {
      const upstream = await fetch(`${API_BASE}${path}?batch-number=${batch}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

      if (upstream.status === 404) break;
      if (!upstream.ok) {
        if ([429, 500, 502, 503, 504].includes(upstream.status)) {
          await sleep(1200 * Math.min(batch, 3));
          const retry = await fetch(`${API_BASE}${path}?batch-number=${batch}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          });
          if (retry.status === 404) break;
          if (!retry.ok) throw new Error(`Fuel Finder ${cachePrefix} batch ${batch} failed (${retry.status}).`);
          response = new Response(await retry.text(), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else {
          throw new Error(`Fuel Finder ${cachePrefix} batch ${batch} failed (${upstream.status}).`);
        }
      } else {
        response = new Response(await upstream.text(), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      await caches.default.put(cacheKey, new Response(await response.clone().text(), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` },
      }));
    }

    const page = await response.json();
    if (!Array.isArray(page)) throw new Error(`Unexpected Fuel Finder ${cachePrefix} response format.`);
    all.push(...page);
    if (page.length < 500) break;
  }
  return all;
}

function normalizeFuel(value) {
  const v = String(value || '').toUpperCase();
  if (v === 'DIESEL' || v === 'B7' || v === 'B7S') return 'B7_STANDARD';
  if (v === 'PREMIUM_DIESEL' || v === 'B7P') return 'B7_PREMIUM';
  return v;
}

function normalizePrice(value) {
  if (value == null || value === '') return NaN;
  const n = Number(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return n < 2 ? n * 100 : n;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function round(n, places) {
  const p = 10 ** places;
  return Math.round(n * p) / p;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}
