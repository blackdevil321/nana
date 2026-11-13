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

// {{mobile}} aur {{mobileNum}} ko actual number se replace karta hai
function interpolate(obj, mobile) {
  const num = String(parseInt(mobile, 10));
  if (typeof obj === 'string') {
    return obj
      .replace(/\{\{mobileNum\}\}/g, num)
      .replace(/\{\{mobile\}\}/g, mobile);
  }
  if (Array.isArray(obj)) {
    return obj.map(v => interpolate(v, mobile));
  }
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k in obj) {
      out[k] = interpolate(obj[k], mobile);
    }
    return out;
  }
  return obj;
}

// Timeout lagata hai taaki ek API poori request ko na roke
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    )
  ]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
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
    if (typeof cfg.body === 'string') {
      body = interpolate(cfg.body, mobile);
    } else {
      body = JSON.stringify(interpolate(cfg.body, mobile));
    }
  }

  try {
    const fetchPromise = fetch(url, { method, headers, body }).then(async res => {
      const text = await res.text();
      let data; 
      try { data = JSON.parse(text); } catch { data = text; }
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
    return {
      api: key,
      name: cfg.name || key,
      success: false,
      error: e.message,
      ms: Date.now() - start
    };
  }
}

// ============================================================
// WORKER ENTRY POINT
// ============================================================
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const mobile = url.searchParams.get('mobile');

    // CORS Preflight Handle
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    // Mobile number validation
    if (!mobile) return json({ error: 'Missing ?mobile' }, 400);
    const clean = mobile.replace(/\D/g, '');
    if (clean.length !== 10) return json({ error: 'Mobile must be exactly 10 digits' }, 400);

    const start = Date.now();

    // Saari APIs ko ek saath (parallel) run karo
    const settled = await Promise.allSettled(
      Object.entries(apisConfig).map(([k, c]) => runOne(k, c, clean))
    );

    // Results ko format karo
    const results = settled.map(r =>
      r.status === 'fulfilled' ? r.value : { success: false, error: r.reason?.message }
    );

    const successCount = results.filter(r => r.success).length;

    // Final response
    return json({
      mobile: clean,
      total: results.length,
      success: successCount,
      failed: results.length - successCount,
      totalTimeMs: Date.now() - start,
      results
    });
  }
};
