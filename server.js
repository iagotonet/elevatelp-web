const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ElevateLP/1.0)' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPageTexts(html) {
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  const texts = [];
  const tagPattern = /<(h[1-6]|p|span|div|a|button|li|td|th|label)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = tagPattern.exec(html)) !== null) {
    const text = stripHtml(match[2]).trim();
    if (text.length > 3 && text.length < 500 && !text.match(/^https?:\/\//)) {
      texts.push(text);
    }
  }
  return [...new Set(texts)].filter(t => t.split(' ').length >= 1);
}

// Padroes de campos que SAO configuracao (nao texto)
const CONFIG_PATTERNS = /(_color|_background|_typography|_font|_size|_weight|_transform|_border|_padding|_margin|_radius|_shadow|_transition|_animation|_position|_align|_justify|_flex|_grid|_display|_width|_height|_image|_icon|_url|_link|_id|_hover|_normal|_tablet|_mobile|_responsive|hover_|_gradient|_overlay|_opacity|_z_index|_gap|_space|gradient_position|background_background|border_border|typography_typography|box_shadow|text_transform|font_family|font_size|font_weight|line_height|letter_spacing)/i;

// Valores que claramente nao sao copy
const JUNK_PATTERNS = /^(yes|no|true|false|none|auto|inherit|initial|center|left|right|top|bottom|middle|full|stretch|h[1-6]|classic|gradient|solid|custom|uppercase|lowercase|normal|bold|italic|image|recent|fadeIn|fadeInUp|fast|slow|shrink|text_center|text_left|text_right|min-height|contain|cover|no-repeat|transform|stacked|framed|inline|block|flex|grid|absolute|relative|fixed|static|hidden|visible|pointer|grab|default|style-\d+|layout-\d+|ekit-[a-z-]+|elementskit-[a-z-]+)$/i;

function isContentField(fieldName) {
  if (CONFIG_PATTERNS.test(fieldName)) return false;
  return true;
}

function isRealText(val) {
  const v = (val || '').trim();
  if (!v || v.length < 2) return false;
  if (JUNK_PATTERNS.test(v)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
  if (/^https?:\/\//.test(v)) return false;
  if (/^www\./.test(v)) return false;
  if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt|B|s|ms)?$/.test(v)) return false;
  if (/^rgba?\(/.test(v)) return false;
  if (/@/.test(v) && /\./.test(v) && v.length < 100) return false; // emails
  if (/^[a-f0-9]{6,32}$/.test(v)) return false; // IDs hexadecimais
  if (/^[a-z0-9_-]+$/.test(v) && v.length < 15 && !v.includes(' ')) return false; // slugs
  if (/^(\+\d[\d\s-]{6,}|\(\d+\))/.test(v)) return false; // telefones
  // Deve ter pelo menos 2 caracteres nao-especiais
  const letters = v.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (letters.length < 2) return false;
  return true;
}

function extractElementorTexts(data) {
  const texts = [];
  const seen = new Set();

  function walk(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      const wt = el.widgetType || '';
      const s = el.settings || {};
      const eid = el.id || '';
      if (!wt || typeof s !== 'object') { if (el.elements) walk(el.elements); continue; }

      // Varrer TODOS os campos do settings
      for (const [field, val] of Object.entries(s)) {
        // Pular campos de configuracao
        if (!isContentField(field)) continue;

        if (typeof val === 'string') {
          const clean = stripHtml(val);
          const key = `${eid}:${field}`;
          if (!seen.has(key) && isRealText(clean)) {
            seen.add(key);
            texts.push({ elId: eid, wt, field, text: clean, rawHtml: val.includes('<'), applyWt: wt });
          }
        } else if (Array.isArray(val)) {
          // Varrer listas (slides, items, etc)
          val.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            for (const [sf, sv] of Object.entries(item)) {
              if (!isContentField(sf)) continue;
              const key2 = `${eid}:${field}:${idx}:${sf}`;
              if (seen.has(key2) || typeof sv !== 'string') continue;
              const clean = stripHtml(sv);
              if (isRealText(clean)) {
                seen.add(key2);
                texts.push({ elId: eid, wt, listKey: field, idx, sub: sf, text: clean, rawHtml: sv.includes('<'), applyWt: wt });
              }
            }
          });
        }
      }
      if (el.elements) walk(el.elements);
    }
  }

  const root = Array.isArray(data) ? data : (data.content || []);
  walk(root);
  return texts;
}

function applyTexts(jsonData, texts, adaptedCopies) {
  const adapted = JSON.parse(JSON.stringify(jsonData));

  function applyOne(jsonCopy, t, newText) {
    const r = Array.isArray(jsonCopy) ? jsonCopy : (jsonCopy.content || []);
    function w(els) {
      if (!Array.isArray(els)) return false;
      for (const el of els) {
        if (!el || typeof el !== 'object') continue;
        if (el.id === t.elId) {
          const s = el.settings || {};
          if (t.listKey) {
            const lst = s[t.listKey];
            if (Array.isArray(lst) && lst[t.idx] !== undefined) {
              lst[t.idx][t.sub] = t.rawHtml ? `<p>${newText}</p>` : newText;
              return true;
            }
          } else if (t.field === 'editor') {
            s.editor = `<p>${newText}</p>`; return true;
          } else if (t.field) {
            s[t.field] = newText; return true;
          }
        }
        if (el.elements && w(el.elements)) return true;
      }
      return false;
    }
    return w(r);
  }

  let count = 0;
  for (let i = 0; i < texts.length; i++) {
    if (adaptedCopies[i] && applyOne(adapted, texts[i], adaptedCopies[i])) count++;
  }
  return { adapted, count };
}

function callClaude(system, userMsg) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: userMsg }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.error) reject(new Error(r.error.message));
          else resolve(r.content[0].text.trim());
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function parseNumberedList(text, expected) {
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) result[parseInt(m[1]) - 1] = m[2].trim();
  }
  for (let i = 0; i < expected; i++) {
    if (!result[i]) result[i] = null;
  }
  return result.slice(0, expected);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  if (req.method === 'POST' && req.url === '/process') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { pageUrl, jsonData, briefing, clientName } = JSON.parse(body);
        if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY nao configurada');
        if (!jsonData) throw new Error('JSON do Elementor obrigatorio');
        if (!briefing) throw new Error('Briefing obrigatorio');

        let pageTexts = [];
        if (pageUrl) {
          try {
            const html = await fetchUrl(pageUrl);
            pageTexts = extractPageTexts(html);
          } catch(e) {
            console.log('Aviso pagina:', e.message);
          }
        }

        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        const texts = extractElementorTexts(parsed);
        if (texts.length === 0) throw new Error('Nenhum texto encontrado no JSON');

        const pageContext = pageTexts.length > 0
          ? `\n\nTextos visíveis na página (contexto de layout):\n${pageTexts.slice(0, 30).join('\n')}`
          : '';

        const system = `Você é um adaptador de copy para landing pages brasileiras.

REGRAS — siga à risca:
1. Responda APENAS com a lista numerada, uma linha por item
2. Formato obrigatório: "1. texto adaptado"
3. TAMANHO: mantenha exatamente o range indicado [X-Y palavras] — não ultrapasse nem fique muito abaixo
4. Português brasileiro
5. Adapte para o negócio do briefing — não invente serviços que não existem
6. Zero explicações fora da lista`;

        const lines = texts.map((t, i) => {
          const words = t.text.split(/\s+/).filter(w => w).length;
          const min = Math.max(1, Math.floor(words * 0.8));
          const max = Math.ceil(words * 1.2);
          return `${i+1}. [${min}-${max} palavras] ${t.text}`;
        });

        const userMsg = `EMPRESA: ${clientName || 'não informado'}

BRIEFING:
${briefing}
${pageContext}

Reescreva:
${lines.join('\n')}`;

        const response = await callClaude(system, userMsg);
        const adaptedCopies = parseNumberedList(response, texts.length);
        const { adapted, count } = applyTexts(parsed, texts, adaptedCopies);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, total: texts.length, applied: count, json: adapted }));

      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`ElevateLP porta ${PORT}`));
