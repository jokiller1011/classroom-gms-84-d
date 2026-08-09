const express = require('express');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.raw({ type: '*/*', limit: '50mb' }));

app.all('/proxy', async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing ?url=');

    let parsed;
    try { parsed = new URL(targetUrl); } catch { return res.status(400).send('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).send('Only HTTP/HTTPS allowed');

    const requester = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: req.method,
      headers: { ...req.headers },
    };

    ['host','connection','keep-alive','transfer-encoding','proxy-connection','proxy-authorization','upgrade']
      .forEach(h => delete options.headers[h]);
    options.headers['host'] = parsed.hostname;
    options.headers['accept-encoding'] = 'identity';

    const proxyReq = requester.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const responseHeaders = { ...proxyRes.headers };
      ['content-security-policy','x-frame-options','content-encoding','transfer-encoding']
        .forEach(h => delete responseHeaders[h]);

      if (isHtml) {
        let body = '';
        proxyRes.on('data', chunk => body += chunk.toString());
        proxyRes.on('end', () => {
          const rewritten = rewriteHtml(body, parsed);
          const buffer = Buffer.from(rewritten, 'utf-8');
          responseHeaders['content-length'] = buffer.length;
          res.writeHead(proxyRes.statusCode || 200, responseHeaders);
          res.end(buffer);
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, responseHeaders);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.status(502).send(`<h2>Proxy Error</h2><p>${err.message}</p>`);
    });

    if (['POST','PUT','PATCH'].includes(req.method) && req.body && req.body.length) proxyReq.write(req.body);
    proxyReq.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

// ==================== HTML REWRITER ====================
function rewriteHtml(html, baseUrl) {
  const proxyBase = '/proxy?url=';
  const baseUrlStr = baseUrl.origin + baseUrl.pathname.replace(/\/[^/]*$/, '/');

  // ---- Navigation lock script (injected BEFORE any other script) ----
  const lockScript = `
<script>
(function() {
  var proxyBase = '${proxyBase}';
  function fixUrl(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('javascript:') || url.startsWith('data:') || url.startsWith('blob:') ||
        url.startsWith('mailto:') || url.startsWith('#')) return url;
    if (url.startsWith(proxyBase)) return url; // already proxied
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return proxyBase + encodeURIComponent(url);
    }
    // relative URL resolution happens later, but we'll let the native handler deal after
    return url;
  }

  // Override window.location
  var originalLocation = window.location;
  var locationProxy = new Proxy(originalLocation, {
    set: function(obj, prop, value) {
      if (prop === 'href') {
        var fixed = fixUrl(value);
        if (fixed && fixed !== value) {
          console.log('[UnBlocker] Redirecting to', fixed);
          originalLocation.href = fixed;
          return true;
        }
      }
      return Reflect.set(obj, prop, value);
    },
    get: function(obj, prop) {
      if (prop === 'assign' || prop === 'replace') {
        return function(url) {
          var fixed = fixUrl(url);
          return obj[prop](fixed);
        };
      }
      return Reflect.get(obj, prop);
    }
  });
  Object.defineProperty(window, 'location', {
    get: function() { return locationProxy; },
    set: function(value) { locationProxy.href = value; }
  });

  // Override document.location
  Object.defineProperty(document, 'location', {
    get: function() { return locationProxy; },
    set: function(value) { locationProxy.href = value; }
  });

  // Override window.open
  var originalOpen = window.open;
  window.open = function(url, target, features) {
    var fixed = fixUrl(url);
    return originalOpen.call(window, fixed, target, features);
  };

  // Intercept all clicks (even dynamically added elements)
  document.addEventListener('click', function(e) {
    var target = e.target;
    while (target && target.nodeName !== 'A') target = target.parentNode;
    if (target && target.href) {
      var href = target.getAttribute('href');
      if (href && !href.startsWith('javascript:') && !href.startsWith('#') && !href.startsWith('mailto:')) {
        var fixed = fixUrl(href);
        if (fixed && fixed !== href) {
          e.preventDefault();
          window.location.href = fixed;
        }
      }
    }
  }, true);

  // Intercept form submissions
  document.addEventListener('submit', function(e) {
    var form = e.target;
    if (form.action && typeof form.action === 'string') {
      var fixed = fixUrl(form.action);
      if (fixed && fixed !== form.action) {
        e.preventDefault();
        form.action = fixed;
        form.submit();
      }
    }
  }, true);

  // Override history.pushState / replaceState to keep URLs proxified
  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;
  history.pushState = function(state, title, url) {
    if (url) url = fixUrl(url);
    return originalPushState.call(this, state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) url = fixUrl(url);
    return originalReplaceState.call(this, state, title, url);
  };

  // Rewrite <meta http-equiv="refresh"> content attribute
  var metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
  if (metaRefresh) {
    var content = metaRefresh.getAttribute('content');
    if (content) {
      var parts = content.split(';');
      var urlPart = parts.find(p => p.trim().toLowerCase().startsWith('url='));
      if (urlPart) {
        var url = urlPart.split('=')[1];
        var fixed = fixUrl(url);
        if (fixed) {
          metaRefresh.setAttribute('content', content.replace(url, fixed));
        }
      }
    }
  }
})();
</script>
`;
  // -------------------------------------------------------------

  // Browser‑like toolbar (injected at the very top)
  const navBar = `
<style>
  #__ub_toolbar__ {
    position: fixed; top: 0; left: 0; right: 0; z-index: 999999;
    background: #0d1117; border-bottom: 2px solid #30363d;
    padding: 6px 12px; display: flex; align-items: center; gap: 8px;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    font-size: 13px; box-shadow: 0 2px 16px rgba(0,0,0,0.6);
  }
  #__ub_toolbar__ input {
    flex: 1; background: #161b22; border: 1px solid #30363d;
    border-radius: 6px; padding: 5px 10px; color: #e6edf3;
    font-family: 'SF Mono', 'Consolas', monospace; font-size: 12px;
    outline: none; transition: border-color 0.2s;
  }
  #__ub_toolbar__ input:focus { border-color: #58a6ff; }
  #__ub_toolbar__ button {
    background: #58a6ff; color: #fff; border: none; padding: 5px 12px;
    border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 12px;
    transition: background 0.2s; white-space: nowrap;
  }
  #__ub_toolbar__ button:hover { background: #79c0ff; }
  #__ub_toolbar__ .ub_home {
    background: transparent; color: #8b949e; font-size: 16px;
    text-decoration: none; padding: 2px 6px; border-radius: 4px;
  }
  #__ub_toolbar__ .ub_home:hover { background: rgba(88,166,255,0.1); color: #58a6ff; }
  #__ub_toolbar__ .ub_refresh { background: #21262d; color: #e6edf3; }
  #__ub_toolbar__ .ub_refresh:hover { background: #30363d; }
  body { margin-top: 40px !important; }
</style>
<div id="__ub_toolbar__">
  <a href="/" class="ub_home" title="Home">⌂</a>
  <button class="ub_refresh" onclick="location.reload()" title="Refresh">↻</button>
  <input id="__ub_url__" value="${escapeHtml(baseUrl.href)}" 
         onkeydown="if(event.key==='Enter'){__ub_navigate(this.value)}">
  <button onclick="__ub_navigate(document.getElementById('__ub_url__').value)">Go</button>
</div>
<script>
  function __ub_navigate(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    window.location.href = '${proxyBase}' + encodeURIComponent(url);
  }
</script>
`;

  let modified = html;
  // Inject lock script as early as possible (after <head> or before any script)
  modified = modified.replace(/<head[^>]*>/i, match => match + lockScript);
  if (modified === html) modified = lockScript + modified; // fallback

  // Inject toolbar after <body>
  modified = modified.replace(/<body[^>]*>/i, match => match + navBar);
  if (modified === html) modified = navBar + modified;

  // Rewrite all resource attributes (href, src, action, srcset, etc.)
  const rewrites = [
    { tag: 'a', attr: 'href' }, { tag: 'link', attr: 'href' }, { tag: 'img', attr: 'src' },
    { tag: 'script', attr: 'src' }, { tag: 'iframe', attr: 'src' }, { tag: 'form', attr: 'action' },
    { tag: 'source', attr: 'src' }, { tag: 'video', attr: 'src' }, { tag: 'audio', attr: 'src' },
    { tag: 'embed', attr: 'src' }, { tag: 'object', attr: 'data' }
  ];
  rewrites.forEach(({ tag, attr }) => {
    const regex = new RegExp(`<${tag}[^>]*?${attr}=["']([^"']+)["']`, 'gi');
    modified = modified.replace(regex, (full, url) => {
      const resolved = resolveUrl(url, baseUrlStr);
      if (resolved && /^https?:\/\//.test(resolved)) {
        return full.replace(url, proxyBase + encodeURIComponent(resolved));
      }
      return full;
    });
  });

  // srcset
  modified = modified.replace(/srcset=["']([^"']+)["']/gi, (full, srcset) => {
    const rewritten = srcset.split(',').map(part => {
      const [u, ...rest] = part.trim().split(/\s+/);
      const r = resolveUrl(u, baseUrlStr);
      if (r && /^https?:\/\//.test(r)) return proxyBase + encodeURIComponent(r) + (rest.length ? ' ' + rest.join(' ') : '');
      return part.trim();
    }).join(', ');
    return `srcset="${rewritten}"`;
  });

  // Inline styles
  modified = modified.replace(/style=["']([^"']+)["']/gi, (full, style) => `style="${rewriteCssUrls(style, baseUrlStr)}"`);
  modified = modified.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (full, css) => full.replace(css, rewriteCssUrls(css, baseUrlStr)));

  return modified;
}

function rewriteCssUrls(css, baseUrlStr) {
  const proxyBase = '/proxy?url=';
  return css.replace(/url\(["']?([^)"']+)["']?\)/gi, (full, url) => {
    const resolved = resolveUrl(url, baseUrlStr);
    if (resolved && /^https?:\/\//.test(resolved)) return `url(${proxyBase}${encodeURIComponent(resolved)})`;
    return full;
  });
}

function resolveUrl(url, baseUrlStr) {
  if (!url || url.startsWith('data:') || url.startsWith('javascript:') ||
      url.startsWith('mailto:') || url.startsWith('#') || url.startsWith('blob:')) return null;
  try { return new URL(url, baseUrlStr).href; } catch { return null; }
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

app.listen(PORT, () => console.log(`\n  ★ UnBlocker running at http://localhost:${PORT}\n`));
