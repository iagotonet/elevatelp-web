const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Fetch URL content
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

// Strip HTML tags
function stripHtml(h) {
  return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Extract visible text from HTML page
function extractPageTexts(html) {
  // Remove scripts, styles, nav, footer
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
  // Deduplicate
  return [...new Set(texts)].filter(t => t.split(' ').length >= 1);
}

// Extract texts from Elementor JSON
const CONTENT_FIELDS = new Set([
  'title','text','editor','description','button_text',
  'title_text','description_text','acc_title','acc_content',
  'tab_title','tab_content','hotspot_label','suffix',
  'ekit_heading_title','ekit_heading_sub_title',
  'ekit_icon_box_title_text','ekit_icon_box_description_text','ekit_icon_box_btn_text',
  'client_name','designation','review',
  'sg_title_text','sg_title_before','sg_title_after','sg_title_focused',
  'sg_subtitle_heading','sg_content_label',
  'sg_icon_text','sg_icon_description','sg_readmore_button_label',
  'name','content','label','heading','subtitle','caption','job','position',
]);

const CONTENT_LIST_FIELDS = new Set([
  'ekit_testimonial_data','ekit_accordion_items','slides','icon_list',
  'tabs','hotspot','sg_testimonials_list',
]);

const JUNK = new Set([
  'yes','no','true','false','none','auto','inherit','initial',
  'center','left','right','top','bottom','middle','full','stretch',
  'h1','h2','h3','h4','h5','h6','classic','gradient','solid','custom',
  'uppercase','lowercase','normal','bold','italic','image','recent',
  'fadeIn','fadeInUp','fast','shrink','text_center','text_left','text_right',
  'min-height','contain','cover','no-repeat','transform',
  'Divider','BADGE','badge','EXCLUSIVE',
]);

function isRealText(val) {
  const v = (val || '').trim();
  if (!v || v.length < 2) return false;
  if (JUNK.has(v)) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;
  if (/^https?:\/\//.test(v)) return false;
  if (/^\d+(\.\d+)?(px|em|rem|%|vh|vw|pt|B)?$/.test(v)) return false;
  if (/^rgba?\(/.test(v)) return false;
  if (/@/.test(v) && /\./.test(v)) return false;
  if (/^ekit-/.test(v)) return false;
  if (/^[a-f0-9]{6,8}$/.test(v)) return false;
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

      for (const [field, val] of Object.entries(s)) {
        if (typeof val === 'string' && CONTENT_FIELDS.has(field)) {
          const key = `${eid}:${field}`;
          if (!seen.has(key)) {
            const clean = stripHtml(val);
            if (isRealText(clean)) {
              seen.add(key);
              texts.push({ elId: eid, wt, field, text: clean, rawHtml: val.includes('<'), applyWt: wt });
            }
          }
        } else if (Array.isArray(val) && (CONTENT_LIST_FIELDS.has(field) || CONTENT_FIELDS.has(field))) {
          val.forEach((item, idx) => {
            if (!item || typeof item !== 'object') return;
            for (const [sf, sv] of Object.entries(item)) {
              if (!CONTENT_FIELDS.has(sf)) continue;
              const key2 = `${eid}:${field}:${idx}:${sf}`;
              if (!seen.has(key2) && typeof sv === 'string') {
                const clean = stripHtml(sv);
                if (isRealText(clean)) {
                  seen.add(key2);
                  texts.push({ elId: eid, wt, listKey: field, idx, sub: sf, text: clean, rawHtml: sv.includes('<'), applyWt: wt });
                }
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
  const root = Array.isArray(adapted) ? adapted : (adapted.content || []);
  let applied = 0;

  function walk(els) {
    if (!Array.isArray(els)) return;
    for (const el of els) {
      if (!el || typeof el !== 'object') continue;
      const matchIdx = texts.findIndex(t => t.elId === el.id && !t._applied);
      if (matchIdx >= 0 && adaptedCopies[matchIdx]) {
        const t = texts[matchIdx];
        const newText = adaptedCopies[matchIdx];
        const s = el.settings || {};
        if (t.listKey) {
          const lst = s[t.listKey];
          if (Array.isArray(lst) && lst[t.idx] !== undefined) {
            lst[t.idx][t.sub] = t.rawHtml ? `<p>${newText}</p>` : newText;
            t._applied = true; applied++;
          }
        } else if (t.field === 'editor') {
          s.editor = `<p>${newText}</p>`; t._applied = true; applied++;
        } else if (t.field) {
          s[t.field] = newText; t._applied = true; applied++;
        }
      }
      if (el.elements) walk(el.elements);
    }
  }

  // Need to apply each text by matching elId properly
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

// Call Claude API
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

// Parse numbered list response
function parseNumberedList(text, expected) {
  const result = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) result[parseInt(m[1]) - 1] = m[2].trim();
  }
  // Fill missing
  for (let i = 0; i < expected; i++) {
    if (!result[i]) result[i] = null;
  }
  return result.slice(0, expected);
}

// Main server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Serve frontend
  if (req.method === 'GET' && req.url === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html); return;
  }

  // Process API
  if (req.method === 'POST' && req.url === '/process') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { pageUrl, jsonData, briefing, clientName } = JSON.parse(body);

        if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada');
        if (!pageUrl) throw new Error('URL da página é obrigatória');
        if (!jsonData) throw new Error('JSON do Elementor é obrigatório');
        if (!briefing) throw new Error('Briefing é obrigatório');

        // 1. Fetch page and extract visible texts
        let pageTexts = [];
        try {
          const html = await fetchUrl(pageUrl);
          pageTexts = extractPageTexts(html);
        } catch(e) {
          console.log('Aviso: não conseguiu acessar a página:', e.message);
        }

        // 2. Extract texts from JSON
        const parsed = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
        const texts = extractElementorTexts(parsed);

        if (texts.length === 0) throw new Error('Nenhum texto encontrado no JSON');

        // 3. Build prompt
        const pageContext = pageTexts.length > 0
          ? `\n\nTEXTOS VISÍVEIS NA PÁGINA (use como contexto de layout):\n${pageTexts.slice(0, 50).join('\n')}`
          : '';

        const lines = texts.map((t, i) => {
          const words = t.text.split(/\s+/).length;
          return `${i+1}. [~${words}p] ${t.text}`;
        });

        const system = `Você é especialista em copywriting de alta conversão para landing pages brasileiras.
Sua ÚNICA função é reescrever textos para um negócio específico.
REGRAS ABSOLUTAS:
- Responda SOMENTE com a lista numerada, um item por linha
- Formato exato: "1. texto reescrito"
- NADA mais além da lista — sem explicações, sem análises, sem comentários
- Mantenha o mesmo número aproximado de palavras (~±30%)
- Botão/CTA: máximo 5 palavras, imperativo
- Português brasileiro
- Não mencione nomes genéricos do template original`;

        const userMsg = `EMPRESA: ${clientName || 'não informado'}

BRIEFING:
${briefing}
${pageContext}

Reescreva cada texto para esta empresa mantendo aproximadamente o mesmo tamanho:

${lines.join('\n')}`;

        // 4. Call Claude
        const response = await callClaude(system, userMsg);
        const adaptedCopies = parseNumberedList(response, texts.length);

        // 5. Apply to JSON
        const { adapted, count } = applyTexts(parsed, texts, adaptedCopies);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          success: true,
          total: texts.length,
          applied: count,
          json: adapted,
          preview: adaptedCopies.slice(0, 5)
        }));

      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`ElevateLP rodando na porta ${PORT}`);
});
