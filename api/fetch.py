from http.server import BaseHTTPRequestHandler
import urllib.request
import urllib.error
import json
import re
import threading
import traceback
from urllib.parse import urlparse, parse_qs

# ─── Helpers ─────────────────────────────────────────────────────────────────

def clean_html(text):
    return (text
        .replace('&amp;', '&').replace('&quot;', '"')
        .replace('&#39;', "'").replace('&lt;', '<').replace('&gt;', '>')
        .replace('&nbsp;', ' ').strip())

def extract_tweet_path(url):
    url = url.split('?')[0].split('#')[0]
    m = re.search(r'(?:x\.com|twitter\.com)/(\w+/status/\d+)', url)
    return '/' + m.group(1) if m else None

def clean_text(text):
    if not text:
        return ''
    # Strip trailing t.co links and pic.twitter links
    text = re.sub(r'\s*https?://t\.co/\S+\s*', ' ', text)
    text = re.sub(r'\s*https?://pic\.twitter\.com/\S+\s*', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

def fetch_url(url, headers=None, timeout=7):
    """Fetch URL with timeout, returns decoded string. Raises on error."""
    headers = headers or {}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode('utf-8', errors='ignore')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HTTP {e.code} from {url}')
    except urllib.error.URLError as e:
        raise RuntimeError(f'URL error: {e.reason}')

def extract_og(html, name):
    """Extract meta tag value — handles both attribute orders."""
    flags = re.IGNORECASE | re.DOTALL
    for pattern in [
        rf'<meta[^>]+(?:property|name)=["\'][^"\']*{re.escape(name)}[^"\']*["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'][^"\']*{re.escape(name)}[^"\']*["\']',
    ]:
        m = re.search(pattern, html, flags)
        if m:
            return clean_html(m.group(1))
    return ''

# ─── Fetch Strategies ─────────────────────────────────────────────────────────

def try_vxtwitter(path):
    data = json.loads(fetch_url(
        f'https://api.vxtwitter.com{path}',
        headers={'User-Agent': 'Mozilla/5.0 (compatible; PostPrint/1.0)'},
        timeout=7
    ))
    text = clean_text(data.get('text', ''))
    if not text:
        raise ValueError('vxtwitter: empty text')
    return {
        'name':   data.get('user_name', 'Unknown'),
        'handle': '@' + data.get('user_screen_name', 'unknown'),
        'text':   text,
        'image':  data.get('user_profile_image_url', ''),
    }

def try_fxtwitter(path):
    data = json.loads(fetch_url(
        f'https://api.fxtwitter.com{path}',
        headers={'User-Agent': 'Mozilla/5.0 (compatible; PostPrint/1.0)'},
        timeout=7
    ))
    tweet  = data.get('tweet', {})
    author = tweet.get('author', {})
    text   = clean_text(
        tweet.get('text', '') or
        (tweet.get('raw_text') or {}).get('text', '')
    )
    if not text:
        raise ValueError('fxtwitter: empty text')
    return {
        'name':   author.get('name', 'Unknown'),
        'handle': '@' + author.get('screen_name', 'unknown'),
        'text':   text,
        'image':  author.get('avatar_url', ''),
    }

def try_og_scrape(url):
    """Last-resort HTML scrape using OG/Twitter meta tags."""
    html = fetch_url(url.split('?')[0], headers={
        'User-Agent':      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept':          'text/html,application/xhtml+xml',
    }, timeout=9)

    text = clean_text(
        extract_og(html, 'og:description') or
        extract_og(html, 'twitter:description') or
        extract_og(html, 'description')
    )

    title  = extract_og(html, 'og:title') or extract_og(html, 'twitter:title') or ''
    name, handle = 'Unknown', '@unknown'
    m = re.search(r'^(.+?)\s*\((@\w+)\)', title)
    if m:
        name, handle = m.group(1).strip(), m.group(2)
    elif ' on X' in title:
        name = title.split(' on X')[0].strip()

    image = extract_og(html, 'og:image') or ''

    if not text:
        raise ValueError('OG scrape: could not extract tweet text')

    return {'name': name, 'handle': handle, 'text': text, 'image': image}

# ─── Parallel Race: vx vs fx ─────────────────────────────────────────────────

def race_apis(path):
    """
    Fire vxtwitter + fxtwitter concurrently.
    First success wins; raises only if both fail.
    """
    result   = [None]
    errors   = []
    done_evt = threading.Event()
    lock     = threading.Lock()

    def worker(fn, *args):
        try:
            val = fn(*args)
            with lock:
                if result[0] is None:
                    result[0] = val
                    done_evt.set()
        except Exception as e:
            with lock:
                errors.append(str(e))
            if len(errors) >= 2:
                done_evt.set()

    t1 = threading.Thread(target=worker, args=(try_vxtwitter, path), daemon=True)
    t2 = threading.Thread(target=worker, args=(try_fxtwitter, path), daemon=True)
    t1.start(); t2.start()

    done_evt.wait(timeout=8)

    if result[0]:
        return result[0]
    raise RuntimeError(f'Both APIs failed — {errors}')

# ─── Serverless Request Handler ───────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):

    def send_cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type',   'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass  # client disconnected — safe to ignore

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        try:
            self._handle_get()
        except Exception:
            traceback.print_exc()
            try:
                self.send_json(500, {'error': 'Unexpected serverless error'})
            except Exception:
                pass

    def _handle_get(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        url    = (params.get('url', [None])[0] or '').strip()

        if not url:
            return self.send_json(400, {'error': 'Missing url parameter'})

        if 'x.com' not in url and 'twitter.com' not in url:
            return self.send_json(400, {'error': 'Only X / Twitter URLs are supported'})

        path = extract_tweet_path(url)
        if not path:
            return self.send_json(400, {'error': 'Could not parse tweet ID — paste the full post URL'})

        # Layer 1 + 2: parallel API race
        try:
            data = race_apis(path)
            return self.send_json(200, data)
        except Exception as e:
            print(f'  [WARN] API race failed: {e}')

        # Layer 3: OG scrape fallback
        try:
            data = try_og_scrape(url)
            return self.send_json(200, data)
        except Exception as e:
            print(f'  [WARN] OG scrape failed: {e}')

        # All layers exhausted
        self.send_json(503, {
            'error': 'Could not fetch this tweet automatically. Use the manual form — paste the text yourself.'
        })
